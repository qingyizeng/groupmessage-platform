import type { Pool, Queryable } from '../../db/pool';
import { withTx } from '../../db/tx';
import type { Logger } from '../../lib/logger';
import { Waker } from '../../lib/async';
import type { PgListener } from '../../infra/pgListener';
import { emitWs } from '../../realtime/outbox';

export const JOBS_CHANNEL = 'jobs';

export type JobType = 'create_group' | 'leave_all';

export interface JobError {
  step: string;
  code: string;
}

export interface JobRow {
  id: string;
  type: JobType;
  status: 'running' | 'finished' | 'failed';
  group_id: string | null;
  input: Record<string, unknown>;
  state: Record<string, unknown>;
  errors: JobError[];
  attempts: number;
}

/**
 * Handle given to a job implementation. `state` is the checkpoint: mutate it and call `save()`
 * after each step, so a resumed job skips completed work. Writes are serialized, so parallel
 * sub-steps (e.g. several joins) can save independently.
 */
export class JobHandle<S extends Record<string, unknown> = Record<string, unknown>> {
  private chain: Promise<void> = Promise.resolve();

  constructor(
    readonly row: JobRow,
    readonly state: S,
    readonly errors: JobError[],
    private readonly pool: Pool,
    readonly signal: AbortSignal,
  ) {}

  get id() {
    return this.row.id;
  }

  save(extra?: (tx: Queryable) => Promise<void>): Promise<void> {
    const run = async () => {
      await withTx(this.pool, async (tx) => {
        // `extra` first: it may create the row that jobs.group_id references.
        if (extra) await extra(tx);
        await tx.query('UPDATE jobs SET state = $2, errors = $3, group_id = $4, updated_at = now() WHERE id = $1', [
          this.row.id,
          JSON.stringify(this.state),
          JSON.stringify(this.errors),
          this.row.group_id,
        ]);
      });
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Stops the job when the runner shuts down; it resumes from its checkpoint later. */
  throwIfAborted(): void {
    if (this.signal.aborted) throw new Error('job interrupted by shutdown');
  }

  async fail(step: string, code: string): Promise<void> {
    if (!this.errors.some((e) => e.step === step)) this.errors.push({ step, code });
    await this.save();
  }
}

export type JobImpl = (job: JobHandle) => Promise<void>;

const LEASE_MS = 30_000;
const HEARTBEAT_MS = 10_000;

/**
 * Runs jobs. A job function runs to completion in-process while its lease is renewed; if the
 * process dies the lease lapses (or is taken over at once by this instance's next incarnation)
 * and the job resumes from its last checkpoint. Unexpected exceptions retry with backoff.
 */
export class JobRunner {
  private readonly waker = new Waker();
  private readonly active = new Set<string>();
  private readonly inflight = new Set<Promise<void>>();

  constructor(
    private readonly deps: {
      pool: Pool;
      listener: PgListener;
      log: Logger;
      instanceId: string;
      impls: Record<JobType, JobImpl>;
      pollMs?: number;
    },
  ) {
    deps.listener.on(JOBS_CHANNEL, () => this.waker.wake());
  }

  wake(): void {
    this.waker.wake();
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let claimed: JobRow[] = [];
      try {
        claimed = await this.claim();
      } catch (err) {
        this.deps.log.warn({ err: String(err) }, 'job claim failed');
      }
      for (const job of claimed) this.execute(job, signal);
      if (claimed.length === 0) await this.waker.wait(this.deps.pollMs ?? 250, signal);
    }
    await Promise.allSettled([...this.inflight]);
  }

  private async claim(): Promise<JobRow[]> {
    const { rows } = await this.deps.pool.query<JobRow>(
      `UPDATE jobs SET lease_owner = $1, lease_until = now() + make_interval(secs => $3), attempts = attempts + 1
        WHERE id IN (
          SELECT id FROM jobs
           WHERE status = 'running' AND next_run_at <= now()
             AND (lease_until IS NULL OR lease_until < now() OR (lease_owner = $1 AND NOT (id = ANY($2::uuid[]))))
           ORDER BY next_run_at LIMIT 10 FOR UPDATE SKIP LOCKED)
        RETURNING id, type, status, group_id, input, state, errors, attempts`,
      [this.deps.instanceId, [...this.active], LEASE_MS / 1000],
    );
    return rows;
  }

  private execute(row: JobRow, signal: AbortSignal) {
    const { pool, log, instanceId } = this.deps;
    this.active.add(row.id);
    const heartbeat = setInterval(() => {
      void pool
        .query(
          `UPDATE jobs SET lease_until = now() + make_interval(secs => $3) WHERE id = $1 AND lease_owner = $2`,
          [row.id, instanceId, LEASE_MS / 1000],
        )
        .catch(() => undefined);
    }, HEARTBEAT_MS);
    const handle = new JobHandle(row, row.state ?? {}, row.errors ?? [], pool, signal);

    const work = (async () => {
      try {
        await this.deps.impls[row.type](handle);
        if (signal.aborted) return;
        await withTx(pool, async (tx) => {
          const status = handle.errors.length > 0 ? 'failed' : 'finished';
          await tx.query(
            `UPDATE jobs SET status = $2, state = $3, errors = $4, group_id = $5, lease_owner = NULL, lease_until = NULL,
                    updated_at = now()
              WHERE id = $1`,
            [row.id, status, JSON.stringify(handle.state), JSON.stringify(handle.errors), row.group_id],
          );
          await emitWs(tx, 'job_changed', { jobId: row.id, status });
        });
      } catch (err) {
        if (signal.aborted) return;
        log.warn({ err: String(err), jobId: row.id, type: row.type }, 'job interrupted; will resume');
        const backoff = Math.min(30, 2 ** Math.min(row.attempts, 5)) * 250;
        await pool
          .query(
            `UPDATE jobs SET lease_owner = NULL, lease_until = NULL, next_run_at = now() + make_interval(secs => $2)
              WHERE id = $1 AND status = 'running'`,
            [row.id, backoff / 1000],
          )
          .catch(() => undefined);
      } finally {
        clearInterval(heartbeat);
        this.active.delete(row.id);
      }
    })();
    this.inflight.add(work);
    void work.finally(() => {
      this.inflight.delete(work);
      this.waker.wake();
    });
  }
}

export async function enqueueJob(
  tx: Queryable,
  type: JobType,
  input: Record<string, unknown>,
  groupId: string | null = null,
): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    'INSERT INTO jobs (type, input, group_id) VALUES ($1, $2, $3) RETURNING id',
    [type, JSON.stringify(input), groupId],
  );
  await tx.query(`NOTIFY ${JOBS_CHANNEL}`);
  await emitWs(tx, 'job_changed', { jobId: rows[0]!.id, status: 'running' });
  return rows[0]!.id;
}

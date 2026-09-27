import type { Pool, Queryable } from '../../db/pool';
import { withTx } from '../../db/tx';
import type { Logger } from '../../lib/logger';
import { Waker } from '../../lib/async';
import type { PgListener } from '../../infra/pgListener';

export const TASKS_CHANNEL = 'scheduled_tasks';

export type TaskKind =
  | 'rate_limit_expiry'
  | 'gateway_disconnect'
  | 'sequence_step'
  | 'media_download'
  | 'media_cleanup'
  | 'maintenance';

export interface Task {
  id: number;
  kind: TaskKind;
  ref: string;
  payload: Record<string, unknown>;
  version: number;
  attempts: number;
}

export type TaskHandler = (task: Task) => Promise<void>;

/**
 * Schedules (or re-schedules) the task identified by (kind, ref) inside the caller's transaction.
 * `runAt` null means "as soon as possible".
 */
export async function scheduleTask(
  tx: Queryable,
  kind: TaskKind,
  ref: string,
  runAt: Date | null,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await tx.query(
    `INSERT INTO scheduled_tasks (kind, ref, run_at, payload) VALUES ($1, $2, COALESCE($3, now()), $4)
     ON CONFLICT (kind, ref) DO UPDATE
       SET run_at = EXCLUDED.run_at, payload = EXCLUDED.payload, attempts = 0, last_error = NULL,
           version = scheduled_tasks.version + 1`,
    [kind, ref, runAt, JSON.stringify(payload)],
  );
  await tx.query(`NOTIFY ${TASKS_CHANNEL}`);
}

/** Creates the task if it does not exist yet, without postponing an already scheduled run. */
export async function ensureTask(pool: Pool, kind: TaskKind, ref: string, delayMs: number): Promise<void> {
  await pool.query(
    `INSERT INTO scheduled_tasks (kind, ref, run_at) VALUES ($1, $2, now() + make_interval(secs => $3))
     ON CONFLICT (kind, ref) DO NOTHING`,
    [kind, ref, delayMs / 1000],
  );
}

/** A handler that runs `work` and always schedules its next run `intervalMs` later. */
export function recurringTask(pool: Pool, kind: TaskKind, ref: string, intervalMs: number, work: () => Promise<unknown>): TaskHandler {
  return async () => {
    try {
      await work();
    } finally {
      await withTx(pool, (tx) => scheduleTask(tx, kind, ref, new Date(Date.now() + intervalMs)));
    }
  };
}

export async function cancelTask(tx: Queryable, kind: TaskKind, ref: string): Promise<void> {
  await tx.query('DELETE FROM scheduled_tasks WHERE kind = $1 AND ref = $2', [kind, ref]);
}

const LEASE_SECONDS = 30;
const MAX_BACKOFF_MS = 30_000;

/** Claims due tasks with a lease (so a crashed worker's task is picked up again) and runs them. */
export class TaskRunner {
  private readonly waker = new Waker();

  constructor(
    private readonly deps: {
      pool: Pool;
      listener: PgListener;
      log: Logger;
      instanceId: string;
      handlers: Record<TaskKind, TaskHandler>;
      pollMs?: number;
    },
  ) {
    deps.listener.on(TASKS_CHANNEL, () => this.waker.wake());
  }

  wake(): void {
    this.waker.wake();
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let tasks: Task[] = [];
      try {
        tasks = await this.claim();
      } catch (err) {
        this.deps.log.warn({ err }, 'task claim failed');
      }
      await Promise.all(tasks.map((t) => this.execute(t)));
      if (tasks.length === 0) await this.waker.wait(this.deps.pollMs ?? 200, signal);
    }
  }

  private async claim(): Promise<Task[]> {
    const { rows } = await this.deps.pool.query<Task>(
      `UPDATE scheduled_tasks SET lease_owner = $1, lease_until = now() + make_interval(secs => $2)
        WHERE id IN (
          SELECT id FROM scheduled_tasks
           WHERE run_at <= now() AND (lease_until IS NULL OR lease_until < now())
           ORDER BY run_at LIMIT 20 FOR UPDATE SKIP LOCKED)
        RETURNING id, kind, ref, payload, version, attempts`,
      [this.deps.instanceId, LEASE_SECONDS],
    );
    return rows;
  }

  private async execute(task: Task): Promise<void> {
    const { pool, log } = this.deps;
    try {
      await this.deps.handlers[task.kind](task);
      // If the task was re-scheduled while running (version changed), keep the new run and just release it.
      await pool.query(
        `WITH d AS (DELETE FROM scheduled_tasks WHERE id = $1 AND version = $2 RETURNING id)
         UPDATE scheduled_tasks SET lease_owner = NULL, lease_until = NULL WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM d)`,
        [task.id, task.version],
      );
    } catch (err) {
      log.warn({ err, task: { kind: task.kind, ref: task.ref } }, 'task failed, will retry');
      const backoff = Math.min(MAX_BACKOFF_MS, 500 * 2 ** task.attempts);
      await pool
        .query(
          `UPDATE scheduled_tasks
              SET attempts = attempts + 1, last_error = $3, lease_owner = NULL, lease_until = NULL,
                  run_at = CASE WHEN version = $2 THEN now() + make_interval(secs => $4) ELSE run_at END
            WHERE id = $1`,
          [task.id, task.version, String((err as Error).message ?? err), backoff / 1000],
        )
        .catch((e) => log.error({ err: e }, 'failed to record task failure'));
    }
  }
}

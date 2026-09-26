import type { Pool } from '../../db/pool';
import { withTx } from '../../db/tx';
import type { Logger } from '../../lib/logger';
import { Waker } from '../../lib/async';
import type { PgListener } from '../../infra/pgListener';
import type { GatewayClient } from '../../integrations/gatewayClient';
import type { AgentClient } from './agentClient';
import { RunExecutor, type AgentLimits } from './executor';
import { AGENT_CHANNEL, maybeStartRun, type RunRow } from './runRepo';

const LEASE_MS = 30_000;
const HEARTBEAT_MS = 5_000;

/**
 * Starts runs for groups with pending triggers and drives running runs. A run is executed by the
 * instance holding its lease; the heartbeat renews the lease and checkpoints elapsed wall-clock
 * time. If the process dies, the run is resumed (same runId) by whoever claims it next; this
 * instance's next incarnation takes over its own leases immediately.
 */
export class AgentRunner {
  private readonly waker = new Waker();
  private readonly active = new Map<string, RunExecutor>();
  private readonly inflight = new Set<Promise<void>>();

  constructor(
    private readonly deps: {
      pool: Pool;
      agent: AgentClient;
      gateway: GatewayClient;
      listener: PgListener;
      log: Logger;
      instanceId: string;
      limits: AgentLimits;
      pollMs?: number;
    },
  ) {
    deps.listener.on(AGENT_CHANNEL, () => this.waker.wake());
  }

  wake(): void {
    this.waker.wake();
  }

  async run(signal: AbortSignal): Promise<void> {
    const heartbeat = setInterval(() => void this.heartbeat(), HEARTBEAT_MS);
    try {
      while (!signal.aborted) {
        let claimed: RunRow[] = [];
        try {
          await this.startPendingRuns();
          claimed = await this.claim();
        } catch (err) {
          this.deps.log.warn({ err: String(err) }, 'agent runner iteration failed');
        }
        for (const run of claimed) this.execute(run, signal);
        if (claimed.length === 0) await this.waker.wait(this.deps.pollMs ?? 250, signal);
      }
    } finally {
      clearInterval(heartbeat);
      await Promise.allSettled([...this.inflight]);
    }
  }

  private async startPendingRuns(): Promise<void> {
    const { rows } = await this.deps.pool.query<{ group_id: string }>(
      `SELECT DISTINCT t.group_id FROM agent_triggers t JOIN groups g ON g.id = t.group_id
        WHERE t.run_id IS NULL AND NOT t.discarded AND g.agent_enabled AND g.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.group_id = t.group_id AND r.status = 'running')`,
    );
    for (const { group_id } of rows) {
      await withTx(this.deps.pool, (tx) => maybeStartRun(tx, group_id));
    }
  }

  private async claim(): Promise<RunRow[]> {
    const { rows } = await this.deps.pool.query<RunRow>(
      `UPDATE agent_runs SET lease_owner = $1, lease_until = now() + make_interval(secs => $3)
        WHERE id IN (
          SELECT id FROM agent_runs
           WHERE status = 'running'
             AND (lease_until IS NULL OR lease_until < now() OR (lease_owner = $1 AND NOT (id = ANY($2::uuid[]))))
           ORDER BY created_at LIMIT 20 FOR UPDATE SKIP LOCKED)
        RETURNING *`,
      [this.deps.instanceId, [...this.active.keys()], LEASE_MS / 1000],
    );
    return rows;
  }

  private execute(run: RunRow, signal: AbortSignal) {
    const executor = new RunExecutor(
      {
        pool: this.deps.pool,
        agent: this.deps.agent,
        gateway: this.deps.gateway,
        log: this.deps.log,
        limits: this.deps.limits,
        instanceId: this.deps.instanceId,
      },
      run,
      signal,
    );
    this.active.set(run.id, executor);
    const work = executor
      .execute()
      .catch(async (err) => {
        if (signal.aborted) return;
        this.deps.log.warn({ err: String(err), runId: run.id }, 'agent run interrupted; will resume');
        await this.deps.pool
          .query(
            `UPDATE agent_runs SET elapsed_ms = GREATEST(elapsed_ms, $3), lease_until = now() + interval '1 second'
              WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
            [run.id, this.deps.instanceId, Math.round(executor.elapsed())],
          )
          .catch(() => undefined);
      })
      .finally(() => {
        this.active.delete(run.id);
        this.inflight.delete(work);
        this.waker.wake();
      });
    this.inflight.add(work);
  }

  private async heartbeat(): Promise<void> {
    for (const [id, executor] of this.active) {
      await this.deps.pool
        .query(
          `UPDATE agent_runs SET lease_until = now() + make_interval(secs => $3), elapsed_ms = GREATEST(elapsed_ms, $4)
            WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
          [id, this.deps.instanceId, LEASE_MS / 1000, Math.round(executor.elapsed())],
        )
        .catch(() => undefined);
    }
  }
}

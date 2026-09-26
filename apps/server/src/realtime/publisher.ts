import type pg from 'pg';
import type { Logger } from '../lib/logger';
import { Waker } from '../lib/async';
import { LOCK_KEYS, runWhileLeader } from '../infra/leader';
import type { PgListener } from '../infra/pgListener';
import { OUTBOX_CHANNEL } from './outbox';

export const PUBLISH_CHANNEL = 'ws_publish';

/**
 * Assigns seq numbers to committed outbox rows. Runs on exactly one instance (advisory-lock leader)
 * and numbers rows from a counter row, so seq is gap-free and strictly increasing in commit-visible
 * order. A bigserial assigned inside business transactions would not be: a transaction holding
 * seq 10 can commit after seq 11 was already delivered, and a client resuming from 11 would never
 * see 10.
 */
export class WsPublisher {
  private readonly waker = new Waker();

  constructor(
    private readonly deps: { connectionString: string; listener: PgListener; log: Logger; pollMs?: number },
  ) {
    deps.listener.on(OUTBOX_CHANNEL, () => this.waker.wake());
  }

  run(signal: AbortSignal): Promise<void> {
    return runWhileLeader({
      connectionString: this.deps.connectionString,
      lockKey: LOCK_KEYS.wsPublisher,
      name: 'ws-publisher',
      log: this.deps.log,
      signal,
      fn: async (client, leaderSignal) => {
        while (!leaderSignal.aborted) {
          const assigned = await this.assignBatch(client);
          if (assigned === 0) await this.waker.wait(this.deps.pollMs ?? 200, leaderSignal);
        }
      },
    });
  }

  private async assignBatch(client: pg.Client): Promise<number> {
    await client.query('BEGIN');
    try {
      const { rows } = await client.query<{ n: number; last_seq: number }>(`
        WITH state AS (
          SELECT last_seq FROM ws_seq_state WHERE id = 1 FOR UPDATE
        ), todo AS (
          SELECT id FROM ws_outbox WHERE seq IS NULL ORDER BY id LIMIT 500 FOR UPDATE
        ), numbered AS (
          SELECT todo.id, state.last_seq + row_number() OVER (ORDER BY todo.id) AS seq FROM todo, state
        ), upd AS (
          UPDATE ws_outbox o SET seq = numbered.seq, published_at = now()
            FROM numbered WHERE o.id = numbered.id
          RETURNING o.seq
        )
        SELECT count(*)::int AS n, COALESCE(max(seq), (SELECT last_seq FROM state)) AS last_seq FROM upd`);
      const { n, last_seq } = rows[0]!;
      if (n > 0) {
        await client.query('UPDATE ws_seq_state SET last_seq = $1 WHERE id = 1', [last_seq]);
        await client.query('SELECT pg_notify($1, $2)', [PUBLISH_CHANNEL, String(last_seq)]);
      }
      await client.query('COMMIT');
      return n;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  }
}

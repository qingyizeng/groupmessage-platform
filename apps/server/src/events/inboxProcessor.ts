import type { Pool, PoolClient } from '../db/pool';
import type { Logger } from '../lib/logger';
import { Waker } from '../lib/async';
import { failpoints } from '../lib/failpoints';
import type { PgListener } from '../infra/pgListener';
import { emitWs } from '../realtime/outbox';
import { EVENTS_CHANNEL } from './ingest';

export interface GatewayEvent {
  eventId: number;
  type: string;
  data: Record<string, unknown>;
}

export type EventHandler = (tx: PoolClient, event: GatewayEvent) => Promise<void>;
export type EventHandlers = Partial<Record<string, EventHandler>>;

const MAX_ATTEMPTS = 8;
const MAX_BACKOFF_MS = 30_000;

class PermanentEventError extends Error {}

/**
 * Removes NUL characters, which PostgreSQL text/jsonb cannot store. Returns whether anything changed
 * so the operator can be told the stored content differs from what the gateway sent.
 */
export function sanitize(value: unknown): { value: unknown; changed: boolean } {
  let changed = false;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      if (!v.includes('\u0000')) return v;
      changed = true;
      return v.replaceAll('\u0000', '');
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return { value: walk(value), changed };
}

/**
 * Processes stored gateway events. Each event is handled in one transaction together with marking it
 * done, so a crash either keeps it pending (and it is handled again) or completes it. Handlers are
 * idempotent and order-independent, so several workers can process events concurrently.
 *
 * A handler failure never blocks other events: the event is rolled back to a savepoint, scheduled for
 * a retry with backoff, and reported to operators as an `inconsistency`. After MAX_ATTEMPTS it is
 * parked as `failed`, with its raw content kept.
 */
export class InboxProcessor {
  private readonly waker = new Waker();

  constructor(
    private readonly deps: {
      pool: Pool;
      listener: PgListener;
      log: Logger;
      handlers: EventHandlers;
      concurrency?: number;
      pollMs?: number;
    },
  ) {
    deps.listener.on(EVENTS_CHANNEL, () => this.waker.wake());
  }

  wake(): void {
    this.waker.wake();
  }

  async run(signal: AbortSignal): Promise<void> {
    const workers = Array.from({ length: this.deps.concurrency ?? 4 }, () => this.worker(signal));
    await Promise.all(workers);
  }

  private async worker(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      let processed = false;
      try {
        processed = await this.processOne();
        failures = 0;
      } catch (err) {
        failures++;
        this.deps.log.warn({ err: String(err) }, 'inbox processing failed (database unavailable?)');
      }
      if (processed) {
        this.waker.wake();
        continue;
      }
      await this.waker.wait(failures > 0 ? Math.min(250 * 2 ** failures, 5_000) : (this.deps.pollMs ?? 250), signal);
    }
  }

  /** Handles one due event. Returns false when there was nothing to do. */
  async processOne(): Promise<boolean> {
    const client = await this.deps.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ event_id: number; type: string; raw: Buffer; attempts: number }>(
        `SELECT event_id, type, raw, attempts FROM gateway_events
          WHERE status = 'pending' AND next_attempt_at <= now()
          ORDER BY event_id LIMIT 1 FOR UPDATE SKIP LOCKED`,
      );
      const row = rows[0];
      if (!row) {
        await client.query('COMMIT');
        return false;
      }
      await client.query('SAVEPOINT handle');
      try {
        await this.handle(client, row);
        await client.query(`UPDATE gateway_events SET status = 'done', processed_at = now() WHERE event_id = $1`, [
          row.event_id,
        ]);
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT handle');
        await this.recordFailure(client, row, err);
      }
      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async handle(tx: PoolClient, row: { event_id: number; type: string; raw: Buffer }) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.raw.toString('utf8'));
    } catch {
      throw new PermanentEventError('event payload is not valid JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new PermanentEventError('event payload is not an object');
    }
    const { value, changed } = sanitize(parsed);
    if (changed) {
      await emitWs(tx, 'inconsistency', {
        kind: 'event_content_sanitized',
        ref: `event:${row.event_id}`,
        message: 'Event contained NUL characters that cannot be stored; they were removed.',
      });
    }
    const handler = this.deps.handlers[row.type];
    if (!handler) return;
    failpoints.hit('inbox.handle');
    failpoints.hit(`inbox.handle.${row.type}`);
    await handler(tx, { eventId: row.event_id, type: row.type, data: value as Record<string, unknown> });
  }

  private async recordFailure(
    tx: PoolClient,
    row: { event_id: number; type: string; attempts: number },
    err: unknown,
  ): Promise<void> {
    const attempts = row.attempts + 1;
    const permanent = err instanceof PermanentEventError || attempts >= MAX_ATTEMPTS;
    const message = String((err as Error)?.message ?? err);
    const backoffMs = Math.min(MAX_BACKOFF_MS, 200 * 2 ** row.attempts);
    await tx.query(
      `UPDATE gateway_events
          SET attempts = $2, last_error = $3, status = $4,
              next_attempt_at = now() + make_interval(secs => $5)
        WHERE event_id = $1`,
      [row.event_id, attempts, message, permanent ? 'failed' : 'pending', backoffMs / 1000],
    );
    this.deps.log.warn({ eventId: row.event_id, type: row.type, attempts, err: message }, 'event handling failed');
    if (attempts === 1 || permanent) {
      await emitWs(tx, 'inconsistency', {
        kind: permanent ? 'event_dead_lettered' : 'event_processing_failed',
        ref: `event:${row.event_id}`,
        message: permanent
          ? `Gateway ${row.type} event ${row.event_id} could not be applied after ${attempts} attempt(s): ${message}. Raw content is kept for manual replay.`
          : `Applying gateway ${row.type} event ${row.event_id} failed: ${message}. Will retry.`,
      });
    }
  }
}

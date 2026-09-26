import type pg from 'pg';
import type { Pool } from '../db/pool';
import type { Logger } from '../lib/logger';
import { sleep } from '../lib/async';
import { failpoints } from '../lib/failpoints';
import { LOCK_KEYS, runWhileLeader } from '../infra/leader';
import { consumeSse, type SseFrame } from '../integrations/sseClient';
import { emitWs } from '../realtime/outbox';

export const EVENTS_CHANNEL = 'gateway_events';
const CURSOR_KEY = 'event_cursor';

/** Events received this long ago can no longer be overtaken by a lower id (reorder window is 1s). */
const REORDER_SAFETY_MS = 2_000;
const FLUSH_INTERVAL_MS = 20;

interface PendingEvent {
  eventId: number;
  type: string;
  raw: Buffer;
  receivedAt: Date;
}

export interface IngestOptions {
  pool: Pool;
  connectionString: string;
  eventsUrl: (since: number) => string;
  log: Logger;
  /** Called after new events are persisted, to wake local inbox processors. */
  onPersisted: () => void;
}

/**
 * Consumes the gateway's SSE stream (on the leader instance only) and appends every frame to the
 * gateway_events inbox, nothing more. Business processing happens in InboxProcessor.
 *
 * Never losing an event rests on the gateway keeping full history: we only need a resume cursor that
 * never moves past an event we have not stored. The cursor advances to the highest stored id that was
 * received more than REORDER_SAFETY_MS ago and that is below every id still waiting to be stored.
 * Replays caused by a conservative cursor are absorbed by the inbox primary key.
 */
export class EventIngestor {
  private cursor = 0;
  private savedCursor = 0;
  private pending = new Map<number, PendingEvent>();
  private recentlyStored: { eventId: number; at: number }[] = [];
  private failureStreak = 0;
  private pendingNotices: { kind: string; ref: string; message: string }[] = [];

  constructor(private readonly opts: IngestOptions) {}

  run(signal: AbortSignal): Promise<void> {
    return runWhileLeader({
      connectionString: this.opts.connectionString,
      lockKey: LOCK_KEYS.eventIngest,
      name: 'event-ingest',
      log: this.opts.log,
      signal,
      fn: (_client: pg.Client, leaderSignal) => this.lead(leaderSignal),
    });
  }

  private async lead(signal: AbortSignal): Promise<void> {
    this.pending.clear();
    this.recentlyStored = [];
    this.cursor = this.savedCursor = await this.loadCursor();
    const flusher = this.flushLoop(signal);
    let backoff = 250;
    while (!signal.aborted) {
      const since = this.safeCursor();
      const streamAbort = new AbortController();
      const stop = () => streamAbort.abort();
      signal.addEventListener('abort', stop, { once: true });
      try {
        this.opts.log.info({ since }, 'connecting to gateway event stream');
        await consumeSse(this.opts.eventsUrl(since), streamAbort.signal, (f) => this.accept(f));
        backoff = 250;
      } catch (err) {
        if (!signal.aborted) this.opts.log.warn({ err: String(err) }, 'event stream error');
      } finally {
        signal.removeEventListener('abort', stop);
      }
      if (!signal.aborted) {
        await sleep(backoff, signal);
        backoff = Math.min(backoff * 2, 5_000);
      }
    }
    await flusher;
  }

  private accept(frame: SseFrame) {
    let eventId = Number(frame.id);
    if (!Number.isSafeInteger(eventId) || eventId <= 0) {
      try {
        eventId = Number((JSON.parse(frame.data) as { eventId?: unknown }).eventId);
      } catch {
        eventId = NaN;
      }
    }
    if (!Number.isSafeInteger(eventId) || eventId <= 0) {
      this.opts.log.error({ frame }, 'gateway frame without a usable eventId');
      this.pendingNotices.push({
        kind: 'event_unidentifiable',
        ref: `frame:${frame.event}`,
        message: `Gateway frame without eventId dropped: ${frame.data.slice(0, 200)}`,
      });
      return;
    }
    if (eventId <= this.cursor || this.pending.has(eventId)) return;
    this.pending.set(eventId, {
      eventId,
      type: frame.event,
      raw: Buffer.from(frame.data, 'utf8'),
      receivedAt: new Date(),
    });
  }

  private async flushLoop(signal: AbortSignal): Promise<void> {
    let lastCursorSave = 0;
    while (!signal.aborted) {
      await this.flushPending();
      if (Date.now() - lastCursorSave > 500) {
        lastCursorSave = Date.now();
        await this.saveCursor().catch((err) => this.opts.log.warn({ err }, 'saving event cursor failed'));
      }
      const delay = this.failureStreak > 0 ? Math.min(200 * 2 ** this.failureStreak, 5_000) : FLUSH_INTERVAL_MS;
      await sleep(delay, signal);
    }
  }

  private async flushPending(): Promise<void> {
    if (this.pending.size === 0 && this.pendingNotices.length === 0) return;
    const batch = [...this.pending.values()].sort((a, b) => a.eventId - b.eventId).slice(0, 500);
    const notices = this.pendingNotices.splice(0);
    try {
      failpoints.hit('ingest.insert');
      const client = await this.opts.pool.connect();
      try {
        await client.query('BEGIN');
        if (batch.length > 0) {
          await client.query(
            `INSERT INTO gateway_events (event_id, type, raw, received_at)
             SELECT * FROM unnest($1::bigint[], $2::text[], $3::bytea[], $4::timestamptz[])
             ON CONFLICT (event_id) DO NOTHING`,
            [batch.map((e) => e.eventId), batch.map((e) => e.type), batch.map((e) => e.raw), batch.map((e) => e.receivedAt)],
          );
          await client.query(`NOTIFY ${EVENTS_CHANNEL}`);
        }
        for (const n of notices) await emitWs(client, 'inconsistency', n);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      // Keep everything in memory and retry; the cursor cannot move past these events, so even a
      // crash now only means they are fetched again from the gateway.
      this.pendingNotices.unshift(...notices);
      if (this.failureStreak++ === 0) {
        this.opts.log.error({ err: String(err), count: batch.length }, 'storing gateway events failed');
        this.pendingNotices.push({
          kind: 'event_store_failed',
          ref: `events:${batch[0]?.eventId ?? '?'}-${batch[batch.length - 1]?.eventId ?? '?'}`,
          message: `Could not store ${batch.length} gateway event(s): ${String((err as Error).message ?? err)}. Retrying.`,
        });
      }
      return;
    }
    if (this.failureStreak > 0) this.opts.log.info('storing gateway events recovered');
    this.failureStreak = 0;
    const now = Date.now();
    for (const e of batch) {
      this.pending.delete(e.eventId);
      this.recentlyStored.push({ eventId: e.eventId, at: e.receivedAt.getTime() });
    }
    if (batch.length > 0) this.opts.onPersisted();
    this.advanceCursor(now);
  }

  private advanceCursor(now: number) {
    let minPending = Infinity;
    for (const id of this.pending.keys()) minPending = Math.min(minPending, id);
    let next = this.cursor;
    const keep: typeof this.recentlyStored = [];
    for (const r of this.recentlyStored) {
      if (r.at <= now - REORDER_SAFETY_MS && r.eventId < minPending) next = Math.max(next, r.eventId);
      else keep.push(r);
    }
    this.cursor = next;
    this.recentlyStored = keep.filter((r) => r.eventId > next);
  }

  /** Resume point for (re)connecting: never beyond an event that is not yet stored. */
  private safeCursor(): number {
    let minPending = Infinity;
    for (const id of this.pending.keys()) minPending = Math.min(minPending, id);
    return Math.min(this.cursor, minPending - 1);
  }

  private async loadCursor(): Promise<number> {
    const { rows } = await this.opts.pool.query<{ value: { since: number } }>('SELECT value FROM kv WHERE key = $1', [
      CURSOR_KEY,
    ]);
    return rows[0]?.value.since ?? 0;
  }

  private async saveCursor(): Promise<void> {
    this.advanceCursor(Date.now());
    if (this.cursor <= this.savedCursor) return;
    const value = this.cursor;
    await this.opts.pool.query(
      `INSERT INTO kv (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
       WHERE (kv.value->>'since')::bigint < $3`,
      [CURSOR_KEY, JSON.stringify({ since: value }), value],
    );
    this.savedCursor = value;
  }
}

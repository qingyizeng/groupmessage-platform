import type { Pool } from '../db/pool';

/**
 * Periodic housekeeping:
 * - WebSocket events older than the retention are no longer replayable (a client resuming from
 *   before that point is told to resync);
 * - processed gateway events older than a week are dropped, but only at or below the persisted
 *   resume cursor: the ingestor discards any frame at or below the cursor, so a late duplicate of a
 *   dropped event can never be mistaken for a new one. Dead-lettered events are kept for inspection;
 * - expired access-token revocations are no longer needed.
 */
export async function runMaintenance(pool: Pool, opts: { wsRetentionHours: number; eventRetentionDays?: number }) {
  const ws = await pool.query(
    `DELETE FROM ws_outbox WHERE seq IS NOT NULL AND created_at < now() - make_interval(hours => $1)`,
    [opts.wsRetentionHours],
  );
  const events = await pool.query(
    `DELETE FROM gateway_events
      WHERE status = 'done' AND processed_at < now() - make_interval(days => $1)
        AND event_id <= COALESCE((SELECT (value->>'since')::bigint FROM kv WHERE key = 'event_cursor'), 0)`,
    [opts.eventRetentionDays ?? 7],
  );
  const revoked = await pool.query('DELETE FROM revoked_access_tokens WHERE expires_at < now()');
  return {
    wsEventsPruned: ws.rowCount ?? 0,
    gatewayEventsPruned: events.rowCount ?? 0,
    revocationsPurged: revoked.rowCount ?? 0,
  };
}

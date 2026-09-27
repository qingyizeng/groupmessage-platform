import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTx } from '../src/db/tx';
import { runMaintenance } from '../src/domain/maintenance';
import { emitWs } from '../src/realtime/outbox';
import { createTestRuntime, login, waitFor, type TestRuntime } from './helpers/app';
import { openWs } from './helpers/wsClient';

describe('websocket heartbeat and retention', () => {
  let t: TestRuntime;
  let token: string;

  beforeAll(async () => {
    t = await createTestRuntime({ env: { WS_PING_MS: '300' } });
    token = (await login(t.app, 'admin')).accessToken;
  });
  afterAll(async () => {
    await t.close();
  });

  const event = (ref: string) => withTx(t.db.pool, (tx) => emitWs(tx, 'inconsistency', { kind: 't', ref, message: '' }));
  const published = () =>
    waitFor(async () => (await t.db.pool.query('SELECT 1 FROM ws_outbox WHERE seq IS NULL')).rowCount === 0);

  it('authenticated clients receive application-level pings', async () => {
    const c = await openWs(t.baseUrl, token);
    await c.waitFor((f) => f.type === 'ping', 2000);
    c.close();
  });

  it('a connection that stops answering protocol pings is terminated', async () => {
    const ws = new WebSocket(`${t.baseUrl.replace(/^http/, 'ws')}/ws`, { autoPong: false });
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ type: 'auth', accessToken: token }));
    const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));
    const started = Date.now();
    await closed;
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('events older than the retention are pruned; resuming from before them asks for a resync', async () => {
    await event('old-1');
    await event('old-2');
    await published();
    await t.db.pool.query(`UPDATE ws_outbox SET created_at = now() - interval '2 days'`);
    await event('fresh');
    await published();
    const { rows } = await t.db.pool.query<{ seq: number }>(`SELECT seq FROM ws_outbox WHERE payload->>'ref' = 'fresh'`);
    const freshSeq = rows[0]!.seq;

    const result = await runMaintenance(t.db.pool, { wsRetentionHours: 24 });
    expect(result.wsEventsPruned).toBeGreaterThanOrEqual(2);
    const left = await t.db.pool.query('SELECT payload FROM ws_outbox');
    expect(left.rows.map((r) => r.payload.ref)).toEqual(['fresh']);

    const stale = await openWs(t.baseUrl, token, 0);
    await stale.waitFor((f) => f.type === 'resync_required');
    stale.close();
    const recent = await openWs(t.baseUrl, token, freshSeq - 1);
    const frame = await recent.waitFor((f) => f.payload?.ref === 'fresh');
    expect(frame.seq).toBe(freshSeq);
    expect(recent.control.some((f) => f.type === 'resync_required')).toBe(false);
    recent.close();
  });

  it('expired access-token revocations are purged', async () => {
    await t.db.pool.query(
      `INSERT INTO revoked_access_tokens (jti, expires_at) VALUES (gen_random_uuid(), now() - interval '1 hour'),
                                                                   (gen_random_uuid(), now() + interval '1 hour')`,
    );
    const result = await runMaintenance(t.db.pool, { wsRetentionHours: 24 });
    expect(result.revocationsPurged).toBe(1);
    const { rows } = await t.db.pool.query('SELECT count(*)::int AS n FROM revoked_access_tokens');
    expect(rows[0].n).toBe(1);
  });
});

describe('gateway event retention', () => {
  let t: TestRuntime;
  beforeAll(async () => {
    t = await createTestRuntime();
  });
  afterAll(async () => {
    await t.close();
  });

  it('drops old processed events at or below the resume cursor, keeps the rest', async () => {
    for (let i = 0; i < 6; i++) t.gw.state.emit('noop', { i });
    await waitFor(async () => (await t.db.pool.query(`SELECT 1 FROM gateway_events WHERE status = 'done'`)).rowCount === 6);
    await waitFor(async () => {
      const { rows } = await t.db.pool.query(`SELECT value FROM kv WHERE key = 'event_cursor'`);
      return rows[0]?.value.since === 6;
    }, { timeout: 6000 });
    await t.db.pool.query(`UPDATE kv SET value = '{"since": 4}' WHERE key = 'event_cursor'`);
    await t.db.pool.query(`UPDATE gateway_events SET processed_at = now() - interval '8 days' WHERE event_id <> 2`);
    await t.db.pool.query(`UPDATE gateway_events SET status = 'failed' WHERE event_id = 3`);
    const result = await runMaintenance(t.db.pool, { wsRetentionHours: 24 });
    expect(result.gatewayEventsPruned).toBe(2);
    const { rows } = await t.db.pool.query<{ event_id: number }>('SELECT event_id FROM gateway_events ORDER BY event_id');
    // 1 and 4 pruned; 2 is recent, 3 is dead-lettered, 5 and 6 are above the cursor.
    expect(rows.map((r) => r.event_id)).toEqual([2, 3, 5, 6]);
  });
});

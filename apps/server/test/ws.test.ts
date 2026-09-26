import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTx } from '../src/db/tx';
import { emitWs } from '../src/realtime/outbox';
import { Runtime } from '../src/runtime';
import { createTestRuntime, login, waitFor, type TestRuntime } from './helpers/app';
import { openWs } from './helpers/wsClient';

describe('websocket push', () => {
  let t: TestRuntime;
  let admin: string;

  beforeAll(async () => {
    t = await createTestRuntime();
    admin = (await login(t.app, 'admin')).accessToken;
  });
  afterAll(async () => {
    await t.close();
  });

  const inconsistency = (i: number) =>
    withTx(t.db.pool, (tx) => emitWs(tx, 'inconsistency', { kind: 'test', ref: `r${i}`, message: `m${i}` }));

  it('rejects connections without a valid token', async () => {
    const bad = await openWs(t.baseUrl, 'not-a-token');
    expect(bad.control[0]).toMatchObject({ type: 'auth', success: false });
    expect(await bad.closed).toBe(4401);

    const silent = await openWs(t.baseUrl, null);
    silent.ws.send('hello');
    expect(await silent.closed).toBe(4401);
  });

  it('pushes committed events with monotonically increasing seq', async () => {
    const c = await openWs(t.baseUrl, admin);
    expect(c.control[0]).toEqual({ type: 'auth', success: true });
    await t.app.inject({ method: 'POST', url: '/api/accounts/acc_01/connect', headers: { authorization: `Bearer ${admin}` } });
    const frame = await c.waitFor((f) => f.type === 'account_status_changed');
    expect(frame.payload).toMatchObject({ accountId: 'acc_01', from: 'idle', to: 'online' });
    for (let i = 0; i < 5; i++) await inconsistency(i);
    await c.waitFor((f) => f.payload?.ref === 'r4');
    const seqs = c.events.map((f) => f.seq!);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    c.close();
  });

  it('never pushes an event from a rolled-back transaction', async () => {
    const c = await openWs(t.baseUrl, admin);
    await withTx(t.db.pool, async (tx) => {
      await emitWs(tx, 'inconsistency', { kind: 'test', ref: 'rolled-back', message: '' });
      throw new Error('abort');
    }).catch(() => undefined);
    await inconsistency(100);
    await c.waitFor((f) => f.payload?.ref === 'r100');
    expect(c.events.some((f) => f.payload?.ref === 'rolled-back')).toBe(false);
    c.close();
  });

  it('replays missed events after reconnecting with sinceSeq, without duplicates', async () => {
    const first = await openWs(t.baseUrl, admin);
    await inconsistency(200);
    const lastSeen = (await first.waitFor((f) => f.payload?.ref === 'r200')).seq!;
    first.close();
    await first.closed;

    for (let i = 201; i <= 210; i++) await inconsistency(i);
    await waitFor(async () => (await t.db.pool.query('SELECT 1 FROM ws_outbox WHERE seq IS NULL')).rowCount === 0);

    const second = await openWs(t.baseUrl, admin, lastSeen);
    const live = inconsistency(211);
    await second.waitFor((f) => f.payload?.ref === 'r211');
    await live;
    const refs = second.events.map((f) => f.payload?.ref);
    expect(refs).toEqual(Array.from({ length: 11 }, (_, i) => `r${201 + i}`));
    const seqs = second.events.map((f) => f.seq!);
    expect(seqs[0]).toBe(lastSeen + 1);
    seqs.forEach((s, i) => i > 0 && expect(s).toBe(seqs[i - 1]! + 1));
    second.close();
  });

  it('asks the client to resync when sinceSeq is unknown', async () => {
    const c = await openWs(t.baseUrl, admin, 10_000_000);
    const frame = await c.waitFor((f) => f.type === 'resync_required');
    expect(frame).toMatchObject({ type: 'resync_required' });
    c.close();
  });

  it('assigns gap-free seq numbers under concurrent writers', async () => {
    const c = await openWs(t.baseUrl, admin);
    const N = 60;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        withTx(t.db.pool, async (tx) => {
          await emitWs(tx, 'inconsistency', { kind: 'burst', ref: `b${i}`, message: '' });
          await new Promise((r) => setTimeout(r, Math.random() * 30));
        }),
      ),
    );
    await waitFor(() => c.events.filter((f) => f.payload?.kind === 'burst').length === N, { timeout: 8000 });
    const seqs = c.events.map((f) => f.seq!);
    seqs.forEach((s, i) => i > 0 && expect(s).toBe(seqs[i - 1]! + 1));
    c.close();
  });

  it('delivers the same stream to clients on another instance', async () => {
    const second = await Runtime.create({ ...t.ctx });
    const secondUrl = await second.start({ port: 0, host: '127.0.0.1' });
    try {
      const a = await openWs(t.baseUrl, admin);
      const b = await openWs(secondUrl, admin);
      await inconsistency(300);
      const fa = await a.waitFor((f) => f.payload?.ref === 'r300');
      const fb = await b.waitFor((f) => f.payload?.ref === 'r300');
      expect(fb.seq).toBe(fa.seq);
      a.close();
      b.close();
    } finally {
      await second.stop();
    }
  });

  it('viewer may subscribe (read-only)', async () => {
    const viewer = (await login(t.app, 'viewer')).accessToken;
    const c = await openWs(t.baseUrl, viewer);
    expect(c.control[0]).toEqual({ type: 'auth', success: true });
    c.close();
  });
});

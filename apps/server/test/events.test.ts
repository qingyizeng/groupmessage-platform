import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { failpoints } from '../src/lib/failpoints';
import { createTestRuntime, login, waitFor, type TestRuntime } from './helpers/app';

describe('gateway event ingestion', () => {
  let t: TestRuntime;

  beforeAll(async () => {
    t = await createTestRuntime();
  });
  afterAll(async () => {
    await t.close();
  });
  afterEach(() => {
    failpoints.clear();
    t.gw.state.duplicateEvents = false;
    t.gw.state.reorderWindowMs = 0;
  });

  const emit = (n: number, type = 'noop') => {
    for (let i = 0; i < n; i++) t.gw.state.emit(type, { i });
  };
  const counts = async () => {
    const { rows } = await t.db.pool.query<{ total: number; done: number; max: number }>(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'done')::int AS done, COALESCE(max(event_id), 0)::int AS max
         FROM gateway_events`,
    );
    return rows[0]!;
  };
  const allStored = (n = t.gw.state.events.length) =>
    waitFor(async () => {
      const c = await counts();
      return c.total === n && c.done === n && c.max === n;
    }, { timeout: 8000, message: `all ${n} events stored and processed` });
  const outbox = async (type: string) =>
    (await t.db.pool.query<{ payload: any }>('SELECT payload FROM ws_outbox WHERE type = $1 ORDER BY id', [type])).rows.map(
      (r) => r.payload,
    );

  it('stores events that happened before the server first connected', async () => {
    emit(5);
    await allStored();
  });

  it('absorbs duplicated deliveries', async () => {
    t.gw.state.duplicateEvents = true;
    emit(30);
    await allStored();
  });

  it('handles reordered deliveries without losing events', async () => {
    t.gw.state.reorderWindowMs = 500;
    emit(40);
    await allStored();
  });

  it('catches up on events produced while the server was down', async () => {
    await t.stopServer();
    emit(25);
    await t.startServer();
    await allStored();
    const cursor = await waitFor(async () => {
      const { rows } = await t.db.pool.query<{ value: { since: number } }>(`SELECT value FROM kv WHERE key = 'event_cursor'`);
      return rows[0]?.value.since === t.gw.state.events.length ? rows[0].value.since : null;
    }, { timeout: 5000, message: 'cursor persisted' });
    expect(cursor).toBe(t.gw.state.events.length);
  });

  it('reconnects and catches up after the stream drops', async () => {
    t.gw.state.dropSubscribers();
    emit(10);
    await allStored();
  });

  it('keeps events and reports an inconsistency when storing them fails, then recovers', async () => {
    failpoints.arm('ingest.insert', 3);
    emit(7);
    await allStored();
    const notices = await outbox('inconsistency');
    expect(notices.some((n) => n.kind === 'event_store_failed')).toBe(true);
  });

  it('a failing handler does not block other events; it is retried and reported', async () => {
    const admin = (await login(t.app, 'admin')).accessToken;
    for (const id of ['acc_01', 'acc_02']) {
      await t.app.inject({ method: 'POST', url: `/api/accounts/${id}/connect`, headers: { authorization: `Bearer ${admin}` } });
    }
    failpoints.arm('inbox.handle.account_status', 2);
    t.gw.state.makeTerminal('acc_01', 'suspended', true);
    emit(5);
    await waitFor(async () => (await counts()).done >= t.gw.state.events.length - 1, { message: 'others processed' });
    await waitFor(
      async () =>
        (await t.db.pool.query(`SELECT 1 FROM accounts WHERE id = 'acc_01' AND status = 'suspended'`)).rowCount === 1,
      { timeout: 8000, message: 'failed event eventually applied' },
    );
    const notices = await outbox('inconsistency');
    expect(notices.some((n) => n.kind === 'event_processing_failed')).toBe(true);
    await allStored();
  });

  it('strips NUL characters that PostgreSQL cannot store and reports it', async () => {
    t.gw.state.emit('message', {
      groupId: 'g-unmanaged',
      msgId: 'm',
      senderPlatformUserId: 'pu_x',
      sentAt: new Date().toISOString(),
      text: 'bad\u0000text',
    });
    await allStored();
    const notices = await outbox('inconsistency');
    expect(notices.some((n) => n.kind === 'event_content_sanitized')).toBe(true);
  });

  it('parks a malformed event immediately, reports it, and keeps processing others', async () => {
    t.gw.state.emit('message', { groupId: 'g', text: 'no msgId or sender' });
    const badId = t.gw.state.events.length;
    emit(3);
    await waitFor(async () => {
      const { rows } = await t.db.pool.query<{ status: string; attempts: number }>(
        'SELECT status, attempts FROM gateway_events WHERE event_id = $1',
        [badId],
      );
      return rows[0]?.status === 'failed' && rows[0].attempts === 1;
    }, { message: 'malformed event parked' });
    const notices = await outbox('inconsistency');
    expect(notices.some((n) => n.kind === 'event_dead_lettered' && n.ref === `event:${badId}`)).toBe(true);
    await waitFor(async () => (await counts()).done === t.gw.state.events.length - 1, { message: 'others done' });
    await t.db.pool.query('DELETE FROM gateway_events WHERE event_id = $1', [badId]);
    await t.db.pool.query('INSERT INTO gateway_events (event_id, type, raw, status) VALUES ($1, $2, $3, $4)', [
      badId,
      'noop',
      Buffer.from('{}'),
      'done',
    ]);
  });

  it('only one of two server instances consumes the stream', async () => {
    const before = t.gw.state.subscribers.size;
    expect(before).toBe(1);
    const { Runtime } = await import('../src/runtime');
    const second = await Runtime.create({ ...t.ctx, config: { ...t.ctx.config, INSTANCE_ID: 'second' } });
    await second.start({ port: 0, host: '127.0.0.1' });
    try {
      emit(10);
      await allStored();
      expect(t.gw.state.subscribers.size).toBe(1);
      await t.stopServer();
      emit(5);
      await allStored();
      expect(t.gw.state.subscribers.size).toBe(1);
    } finally {
      await second.stop();
      await t.startServer();
    }
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformUserIdFor } from '@gmp/mock-gateway';
import { withTx } from '../src/db/tx';
import { markRateLimited } from '../src/domain/accounts/transitions';
import { createTestRuntime, login, waitFor, type TestRuntime } from './helpers/app';

describe('accounts', () => {
  let t: TestRuntime;
  let admin: string;

  beforeAll(async () => {
    t = await createTestRuntime();
    admin = (await login(t.app, 'admin')).accessToken;
  });
  afterAll(async () => {
    await t.close();
  });

  const api = (method: 'GET' | 'POST', url: string, payload?: unknown, token = admin) =>
    t.app.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${token}` } });
  const status = async (id: string) =>
    (await t.db.pool.query<{ status: string }>('SELECT status FROM accounts WHERE id = $1', [id])).rows[0]!.status;
  const outbox = async (type: string) =>
    (
      await t.db.pool.query<{ payload: any }>('SELECT payload FROM ws_outbox WHERE type = $1 ORDER BY id', [type])
    ).rows.map((r) => r.payload);
  const gwAccount = (id: string) => t.gw.state.accounts.get(id);

  it('lists the seeded accounts as idle', async () => {
    const res = await api('GET', '/api/accounts');
    expect(res.statusCode).toBe(200);
    const list = res.json();
    expect(list).toHaveLength(8);
    expect(list[0]).toEqual({ id: 'acc_01', status: 'idle', platformUserId: null, rateLimitedUntil: null });
  });

  it('connect stores the platformUserId and goes online', async () => {
    const res = await api('POST', '/api/accounts/acc_01/connect');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'online', platformUserId: platformUserIdFor('acc_01') });
    expect(gwAccount('acc_01')?.online).toBe(true);
    expect(await outbox('account_status_changed')).toContainEqual(
      expect.objectContaining({ accountId: 'acc_01', from: 'idle', to: 'online' }),
    );

    const again = await api('POST', '/api/accounts/acc_01/connect');
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('ILLEGAL_TRANSITION');
  });

  it('validates transition requests in the documented order', async () => {
    const missing = await api('POST', '/api/accounts/acc_01/transition', { to: 'idle' });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe('VALIDATION_ERROR');

    const unknown = await api('POST', '/api/accounts/nope/transition', { to: 'idle', expectedFrom: 'online' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('ACCOUNT_NOT_FOUND');

    const same = await api('POST', '/api/accounts/acc_01/transition', { to: 'online', expectedFrom: 'online' });
    expect(same.statusCode).toBe(409);
    expect(same.json().error.code).toBe('ILLEGAL_TRANSITION');

    const offTable = await api('POST', '/api/accounts/acc_01/transition', { to: 'rate_limited', expectedFrom: 'idle' });
    expect(offTable.json().error.code).toBe('ILLEGAL_TRANSITION');

    const stale = await api('POST', '/api/accounts/acc_01/transition', { to: 'online', expectedFrom: 'idle' });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('CAS_CONFLICT');
  });

  it('marking offline calls gateway disconnect; reconnect via transition calls connect', async () => {
    const res = await api('POST', '/api/accounts/acc_01/transition', { to: 'disconnected', expectedFrom: 'online' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'disconnected' });
    await waitFor(() => gwAccount('acc_01')?.online === false, { message: 'gateway disconnect' });

    const back = await api('POST', '/api/accounts/acc_01/transition', { to: 'online', expectedFrom: 'disconnected' });
    expect(back.json()).toEqual({ status: 'online' });
    expect(gwAccount('acc_01')?.online).toBe(true);

    const release = await api('POST', '/api/accounts/acc_01/transition', { to: 'idle', expectedFrom: 'online' });
    expect(release.json()).toEqual({ status: 'idle' });
    await waitFor(() => gwAccount('acc_01')?.online === false);
  });

  it('a reconnect cancels a still-pending gateway disconnect', async () => {
    await api('POST', '/api/accounts/acc_06/connect');
    t.gw.state.faults.push({
      id: 999,
      endpoint: 'disconnect',
      remaining: 1,
      action: { type: 'error', status: 503, code: 'UNAVAILABLE' },
    });
    await api('POST', '/api/accounts/acc_06/transition', { to: 'disconnected', expectedFrom: 'online' });
    await waitFor(async () =>
      (await t.db.pool.query(`SELECT 1 FROM scheduled_tasks WHERE kind='gateway_disconnect' AND ref='acc_06' AND attempts > 0`)).rowCount,
    );
    await api('POST', '/api/accounts/acc_06/connect');
    await new Promise((r) => setTimeout(r, 1200));
    expect(await status('acc_06')).toBe('online');
    expect(gwAccount('acc_06')?.online).toBe(true);
  });

  it('concurrent changes: exactly one succeeds, the others get CAS_CONFLICT', async () => {
    await api('POST', '/api/accounts/acc_02/connect');
    const targets = ['disconnected', 'idle', 'disconnected', 'idle', 'suspended', 'rate_limited'];
    const results = await Promise.all(
      targets.map((to) => api('POST', '/api/accounts/acc_02/transition', { to, expectedFrom: 'online' })),
    );
    const ok = results.filter((r) => r.statusCode === 200);
    const conflicts = results.filter((r) => r.statusCode === 409 && r.json().error.code === 'CAS_CONFLICT');
    expect(ok).toHaveLength(1);
    expect(conflicts).toHaveLength(targets.length - 1);
    expect(await status('acc_02')).toBe(ok[0]!.json().status);
  });

  it('gateway account_status event makes the account terminal; repeats are ignored', async () => {
    await api('POST', '/api/accounts/acc_03/connect');
    await api('POST', '/api/accounts/acc_04/connect');
    t.gw.state.makeTerminal('acc_03', 'suspended', true);
    await waitFor(async () => (await status('acc_03')) === 'suspended', { message: 'acc_03 suspended' });
    expect(await outbox('account_terminal')).toContainEqual({ accountId: 'acc_03', status: 'suspended' });

    t.gw.state.emit('account_status', { accountId: 'acc_03', status: 'suspended' });
    t.gw.state.emit('account_status', { accountId: 'acc_03', status: 'session_expired' });
    t.gw.state.makeTerminal('acc_04', 'session_expired', true);
    await waitFor(async () => (await status('acc_04')) === 'session_expired', { message: 'later events still processed' });
    expect(await status('acc_03')).toBe('suspended');
    expect((await outbox('account_terminal')).filter((p) => p.accountId === 'acc_03')).toHaveLength(1);

    const reconnect = await api('POST', '/api/accounts/acc_03/connect');
    expect(reconnect.json().error.code).toBe('ILLEGAL_TRANSITION');
    const failed = await t.db.pool.query(`SELECT 1 FROM gateway_events WHERE status <> 'done'`);
    expect(failed.rowCount).toBe(0);
  });

  it('a terminal error from the gateway on connect makes the account terminal', async () => {
    t.gw.state.makeTerminal('acc_05', 'session_expired', false);
    const res = await api('POST', '/api/accounts/acc_05/connect');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'ACCOUNT_UNAVAILABLE', gatewayCode: 'SESSION_EXPIRED', status: 'session_expired' });
    expect(await status('acc_05')).toBe('session_expired');
    const illegal = await api('POST', '/api/accounts/acc_05/transition', { to: 'online', expectedFrom: 'session_expired' });
    expect(illegal.json().error.code).toBe('ILLEGAL_TRANSITION');
  });

  it('gateway unavailable on connect leaves the status unchanged', async () => {
    t.gw.state.faults.push({
      id: 1000,
      endpoint: 'connect',
      remaining: 1,
      action: { type: 'error', status: 503, code: 'UNAVAILABLE' },
    });
    const res = await api('POST', '/api/accounts/acc_07/connect');
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('GATEWAY_ERROR');
    expect(await status('acc_07')).toBe('idle');
  });

  it('rate_limited returns to online when the window expires', async () => {
    await api('POST', '/api/accounts/acc_07/connect');
    await withTx(t.db.pool, (tx) => markRateLimited(tx, 'acc_07', 1, 'test'));
    const listed = (await api('GET', '/api/accounts')).json().find((a: any) => a.id === 'acc_07');
    expect(listed.status).toBe('rate_limited');
    expect(new Date(listed.rateLimitedUntil).getTime()).toBeGreaterThan(Date.now());
    await withTx(t.db.pool, (tx) => markRateLimited(tx, 'acc_07', 1, 'test'));
    await waitFor(async () => (await status('acc_07')) === 'online', { timeout: 4000 });
    const changes = (await outbox('account_status_changed')).filter((p) => p.accountId === 'acc_07');
    expect(changes.map((p) => `${p.from}->${p.to}`)).toEqual(['idle->online', 'online->rate_limited', 'rate_limited->online']);
  });

  it('expiry does nothing if the account left rate_limited meanwhile', async () => {
    await withTx(t.db.pool, (tx) => markRateLimited(tx, 'acc_07', 1, 'test'));
    await api('POST', '/api/accounts/acc_07/transition', { to: 'disconnected', expectedFrom: 'rate_limited' });
    await new Promise((r) => setTimeout(r, 1500));
    expect(await status('acc_07')).toBe('disconnected');
  });

  it('viewer cannot change accounts but can list them', async () => {
    const viewer = (await login(t.app, 'viewer')).accessToken;
    expect((await api('GET', '/api/accounts', undefined, viewer)).statusCode).toBe(200);
    const res = await api('POST', '/api/accounts/acc_08/connect', undefined, viewer);
    expect(res.statusCode).toBe(403);
    expect(await status('acc_08')).toBe('idle');
  });
});

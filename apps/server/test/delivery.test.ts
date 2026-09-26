import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FAST_TIMINGS, platformUserIdFor } from '@gmp/mock-gateway';
import { withTx } from '../src/db/tx';
import { markRateLimited } from '../src/domain/accounts/transitions';
import { failpoints } from '../src/lib/failpoints';
import { createTestRuntime, login, waitFor, type TestRuntime } from './helpers/app';
import { Scenario } from './helpers/scenario';

describe('outbound delivery', () => {
  let t: TestRuntime;
  let s: Scenario;

  beforeAll(async () => {
    t = await createTestRuntime();
    s = await new Scenario(t).init();
  });
  afterAll(async () => {
    await t.close();
  });
  afterEach(async () => {
    failpoints.clear();
    await s.clearFaults();
    t.gw.state.timings = { ...FAST_TIMINGS };
    t.gw.state.duplicateEvents = false;
    t.gw.state.reorderWindowMs = 0;
  });

  it('S1: accepted after 202, sent after message_sent', async () => {
    const g = await s.group('acc_01', ['acc_02']);
    t.gw.state.timings = { ...FAST_TIMINGS, sendAckMs: [5, 5], sentEventMs: [600, 600] };
    const id = await s.send(g.groupId, 'acc_02', 'hello');
    const accepted = await s.waitStatus(id, 'accepted');
    expect(accepted.msg_id).toBeNull();
    const sent = await s.waitStatus(id, 'sent');
    expect(sent.msg_id).toBe(s.gatewayView(id).landed[0]!.msgId);
    expect(sent.sort_ts.toISOString()).toBe(s.gatewayView(id).landed[0]!.sentAt);
    const { items } = (await s.api('GET', `/api/groups/${g.groupId}/messages`)).json();
    expect(items.filter((m: any) => m.clientMsgId === id)).toHaveLength(1);
  });

  it('S2/S3: duplicated and reordered events give one row per message; own echoes are isOwn', async () => {
    const g = await s.group('acc_03', ['acc_04']);
    t.gw.state.duplicateEvents = true;
    t.gw.state.reorderWindowMs = 300;
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push(await s.send(g.groupId, i % 2 ? 'acc_03' : 'acc_04', `own ${i}`));
    for (let i = 0; i < 5; i++) await s.external(g.gatewayGroupId, 'pu_external', `ext ${i}`);
    for (const id of ids) await s.waitStatus(id, 'sent');
    await waitFor(async () => {
      const { items } = (await s.api('GET', `/api/groups/${g.groupId}/messages?limit=100`)).json();
      return items.length === 13;
    }, { message: '13 timeline rows' });
    await new Promise((r) => setTimeout(r, 400));
    const { items } = (await s.api('GET', `/api/groups/${g.groupId}/messages?limit=100`)).json();
    expect(items).toHaveLength(13);
    expect(new Set(items.map((m: any) => m.msgId)).size).toBe(13);
    expect(items.filter((m: any) => m.isOwn)).toHaveLength(8);
    expect(items.filter((m: any) => m.isOwn).every((m: any) => m.clientMsgId && m.deliveryStatus === 'sent')).toBe(true);
    expect(items.filter((m: any) => !m.isOwn).every((m: any) => m.deliveryStatus === null)).toBe(true);
    const hidden = await t.db.pool.query('SELECT 1 FROM messages WHERE group_id = $1 AND echo_pending', [g.groupId]);
    expect(hidden.rowCount).toBe(0);
  });

  it('S4: rate limit keeps messages queued, sends nothing during the window, then sends in order', async () => {
    const g = await s.group('acc_05', ['acc_06']);
    await s.fault({ endpoint: 'send', accountId: 'acc_06', action: { type: 'rate_limit', retryAfterSeconds: 1 } });
    const ids = [await s.send(g.groupId, 'acc_06', 'r1'), await s.send(g.groupId, 'acc_06', 'r2'), await s.send(g.groupId, 'acc_06', 'r3')];
    await waitFor(async () => (await s.accountStatus('acc_06')) === 'rate_limited', { message: 'rate_limited' });
    expect((await s.message(ids[0]!)).delivery_status).toBe('queued');
    for (const id of ids) await s.waitStatus(id, 'sent', 6000);
    expect(await s.accountStatus('acc_06')).toBe('online');

    const sends = t.gw.state.calls.filter((c) => c.endpoint === 'send' && c.accountId === 'acc_06');
    const limitedAt = sends[0]!.at;
    expect(sends[0]!.status).toBe(429);
    expect(sends.filter((c) => c.at > limitedAt && c.at < limitedAt + 1000)).toHaveLength(0);
    const landed = t.gw.state.groups.get(g.gatewayGroupId)!.messages.filter((m) => ids.includes(m.clientMsgId ?? ''));
    expect(landed.map((m) => m.text)).toEqual(['r1', 'r2', 'r3']);
  });

  it('504 whose message lands 1.5s later: unknown, then sent without a resend', async () => {
    const g = await s.group('acc_07', ['acc_08']);
    await s.fault({ endpoint: 'send', action: { type: 'timeout', effect: true, landAfterMs: 1500 } });
    const id = await s.send(g.groupId, 'acc_08', 'maybe');
    await s.waitStatus(id, 'unknown');
    const unknownAt = Date.now();
    await s.waitStatus(id, 'sent');
    expect(Date.now() - unknownAt).toBeLessThan(5000);
    const view = s.gatewayView(id);
    expect(view.calls).toHaveLength(1);
    expect(view.landed).toHaveLength(1);
  });

  it('504 that did not send: confirmed unsent after 2s, re-sent exactly once', async () => {
    const g = await s.group('acc_01', ['acc_03']);
    await s.fault({ endpoint: 'send', action: { type: 'timeout', effect: false } });
    const id = await s.send(g.groupId, 'acc_03', 'retry me');
    await s.waitStatus(id, 'unknown');
    const unknownAt = Date.now();
    await s.waitStatus(id, ['accepted', 'sent']);
    expect(Date.now() - unknownAt).toBeLessThan(5000);
    await s.waitStatus(id, 'sent');
    const view = s.gatewayView(id);
    expect(view.calls).toHaveLength(2);
    expect(view.calls[1]!.at - view.calls[0]!.at).toBeGreaterThanOrEqual(2000);
    expect(view.landed).toHaveLength(1);
    expect((await s.message(id)).attempt).toBe(2);
  });

  it('504 twice: failed with NETWORK_TIMEOUT after one resend', async () => {
    const g = await s.group('acc_02', ['acc_04']);
    await s.fault({ endpoint: 'send', times: 2, action: { type: 'timeout', effect: false } });
    const id = await s.send(g.groupId, 'acc_04', 'doomed');
    const failed = await s.waitStatus(id, 'failed', 10_000);
    expect(failed.fail_code).toBe('NETWORK_TIMEOUT');
    const view = s.gatewayView(id);
    expect(view.calls).toHaveLength(2);
    expect(view.landed).toHaveLength(0);
  });

  it('stays unknown while by-client-id is unavailable and resolves within 2s after it recovers', async () => {
    const g = await s.group('acc_05', ['acc_07']);
    await s.fault({ endpoint: 'send', action: { type: 'timeout', effect: true, landAfterMs: 200 } });
    await s.fault({ endpoint: 'byClientId', times: -1, action: { type: 'error', status: 503, code: 'UNAVAILABLE' } });
    t.gw.state.timings = { ...FAST_TIMINGS, sentEventMs: [5, 5] };
    // Hold back message_sent too, so only the lookup can resolve it.
    const origEmit = t.gw.state.emit.bind(t.gw.state);
    t.gw.state.emit = (type, data) => (type === 'message_sent' ? undefined : origEmit(type, data));
    try {
      const id = await s.send(g.groupId, 'acc_07', 'lookup');
      await s.waitStatus(id, 'unknown');
      await new Promise((r) => setTimeout(r, 3000));
      expect((await s.message(id)).delivery_status).toBe('unknown');
      await s.clearFaults();
      const recoveredAt = Date.now();
      await s.waitStatus(id, 'sent', 3000);
      expect(Date.now() - recoveredAt).toBeLessThan(2000);
      expect(s.gatewayView(id).calls).toHaveLength(1);
    } finally {
      t.gw.state.emit = origEmit;
    }
  });

  it('SENDER_NOT_IN_GROUP / ACCOUNT_OFFLINE fail the message only', async () => {
    const g = await s.group('acc_01', ['acc_02']);
    await s.fault({ endpoint: 'send', action: { type: 'error', status: 403, code: 'SENDER_NOT_IN_GROUP' } });
    const id = await s.send(g.groupId, 'acc_02', 'x');
    expect((await s.waitStatus(id, 'failed')).fail_code).toBe('SENDER_NOT_IN_GROUP');
    await s.fault({ endpoint: 'send', action: { type: 'error', status: 409, code: 'ACCOUNT_OFFLINE' } });
    const id2 = await s.send(g.groupId, 'acc_02', 'y');
    expect((await s.waitStatus(id2, 'failed')).fail_code).toBe('ACCOUNT_OFFLINE');
    expect(await s.accountStatus('acc_02')).toBe('online');
    const group = await t.db.pool.query('SELECT status FROM groups WHERE id = $1', [g.groupId]);
    expect(group.rows[0].status).toBe('active');
  });

  it('GROUP_WRITE_FORBIDDEN: message failed, group unreachable, queued messages of the group cancelled', async () => {
    const g = await s.group('acc_03', ['acc_04', 'acc_05']);
    await withTx(t.db.pool, (tx) => markRateLimited(tx, 'acc_05', 30, 'test'));
    const queued = await s.send(g.groupId, 'acc_05', 'waiting');
    t.gw.state.groups.get(g.gatewayGroupId)!.writable = false;
    const id = await s.send(g.groupId, 'acc_04', 'blocked');
    expect((await s.waitStatus(id, 'failed')).fail_code).toBe('GROUP_WRITE_FORBIDDEN');
    const cancelled = await s.waitStatus(queued, 'cancelled');
    expect(cancelled.fail_code).toBe('GROUP_UNREACHABLE');
    const group = await t.db.pool.query('SELECT status FROM groups WHERE id = $1', [g.groupId]);
    expect(group.rows[0].status).toBe('unreachable');
    expect(await s.accountStatus('acc_04')).toBe('online');
    const again = await s.api('POST', `/api/groups/${g.groupId}/send`, { accountId: 'acc_04', text: 'z' });
    expect(again.json().error.code).toBe('GROUP_UNREACHABLE');
    await withTx(t.db.pool, async (tx) => {
      await tx.query(`UPDATE accounts SET status = 'online', rate_limited_until = NULL WHERE id = 'acc_05'`);
      await tx.query(`DELETE FROM scheduled_tasks WHERE ref = 'acc_05'`);
    });
  });

  it('message_failed after acceptance applies the same consequences', async () => {
    const g = await s.group('acc_06', ['acc_07']);
    await s.fault({ endpoint: 'send', action: { type: 'fail_after_accept', code: 'GROUP_WRITE_FORBIDDEN' } });
    const id = await s.send(g.groupId, 'acc_07', 'x');
    expect((await s.waitStatus(id, 'failed')).fail_code).toBe('GROUP_WRITE_FORBIDDEN');
    await waitFor(async () => (await t.db.pool.query(`SELECT 1 FROM groups WHERE id = $1 AND status = 'unreachable'`, [g.groupId])).rowCount);
  });

  it('ACCOUNT_SUSPENDED on send: account terminal, its queued messages cancelled, membership removed', async () => {
    const g = await s.group('acc_01', ['acc_08']);
    await s.fault({ endpoint: 'send', accountId: 'acc_08', action: { type: 'delay', ms: 300 } });
    await s.fault({ endpoint: 'send', accountId: 'acc_08', action: { type: 'error', status: 403, code: 'ACCOUNT_SUSPENDED' } });
    const first = await s.send(g.groupId, 'acc_08', 'one');
    await s.waitStatus(first, ['accepted', 'sent']);
    const second = await s.send(g.groupId, 'acc_08', 'two');
    const third = await s.send(g.groupId, 'acc_08', 'three');
    expect((await s.waitStatus(second, 'failed')).fail_code).toBe('ACCOUNT_SUSPENDED');
    expect((await s.waitStatus(third, 'cancelled')).fail_code).toBe('ACCOUNT_TERMINAL');
    expect(await s.accountStatus('acc_08')).toBe('suspended');
    const member = await t.db.pool.query(
      `SELECT present FROM group_members WHERE group_id = $1 AND account_id = 'acc_08'`,
      [g.groupId],
    );
    expect(member.rows[0].present).toBe(false);
    const res = await s.api('POST', `/api/groups/${g.groupId}/send`, { accountId: 'acc_08', text: 'x' });
    expect(res.json().error.code).toBe('ACCOUNT_UNAVAILABLE');
  });

  it('operator marking an account terminal cancels its queued messages', async () => {
    const g = await s.group('acc_02', ['acc_03']);
    await withTx(t.db.pool, (tx) => markRateLimited(tx, 'acc_03', 30, 'test'));
    const id = await s.send(g.groupId, 'acc_03', 'never');
    const res = await s.api('POST', '/api/accounts/acc_03/transition', { to: 'session_expired', expectedFrom: 'rate_limited' });
    expect(res.statusCode).toBe(200);
    expect((await s.waitStatus(id, 'cancelled')).fail_code).toBe('ACCOUNT_TERMINAL');
    expect(s.gatewayView(id).calls).toHaveLength(0);
  });

  it('crash after marking dispatching but before sending: recovered, sent exactly once', async () => {
    const g = await s.group('acc_04', ['acc_05']);
    failpoints.arm('delivery.before_send', 1);
    const id = await s.send(g.groupId, 'acc_05', 'crash-before');
    await waitFor(async () => (await s.message(id)).phase !== 'queued', { message: 'claimed' });
    await t.restart();
    await s.waitStatus(id, 'sent', 12_000);
    const view = s.gatewayView(id);
    expect(view.landed).toHaveLength(1);
    expect(view.calls).toHaveLength(1);
  });

  it('crash after the gateway accepted but before recording it: recovered as sent, no resend', async () => {
    const g = await s.group('acc_06', ['acc_07']);
    failpoints.arm('delivery.after_send', 1);
    const id = await s.send(g.groupId, 'acc_07', 'crash-after');
    await waitFor(() => s.gatewayView(id).calls.length === 1, { message: 'send reached gateway' });
    await t.restart();
    await s.waitStatus(id, 'sent', 12_000);
    const view = s.gatewayView(id);
    expect(view.landed).toHaveLength(1);
    expect(view.calls).toHaveLength(1);
  });
});

describe('operator send validation', () => {
  let t: TestRuntime;
  let s: Scenario;
  beforeAll(async () => {
    t = await createTestRuntime();
    s = await new Scenario(t).init();
  });
  afterAll(async () => {
    await t.close();
  });

  it('rejects unusable accounts and non-members; accepts rate-limited accounts as queued', async () => {
    const g = await s.group('acc_01', ['acc_02']);
    const send = (accountId: string) => s.api('POST', `/api/groups/${g.groupId}/send`, { accountId, text: 'hi' });

    expect((await send('acc_08')).json().error.code).toBe('ACCOUNT_UNAVAILABLE');
    await s.connect('acc_03');
    expect((await send('acc_03')).json().error.code).toBe('ACCOUNT_NOT_IN_GROUP');

    await withTx(t.db.pool, (tx) => markRateLimited(tx, 'acc_02', 30, 'test'));
    const res = await send('acc_02');
    expect(res.statusCode).toBe(202);
    expect((await s.message(res.json().clientMsgId)).delivery_status).toBe('queued');

    const unknownGroup = await s.api('POST', '/api/groups/00000000-0000-0000-0000-000000000000/send', {
      accountId: 'acc_01',
      text: 'x',
    });
    expect(unknownGroup.statusCode).toBe(404);
    const empty = await s.api('POST', `/api/groups/${g.groupId}/send`, { accountId: 'acc_01', text: '   ' });
    expect(empty.json().error.code).toBe('VALIDATION_ERROR');

    const viewer = (await login(t.app, 'viewer')).accessToken;
    const denied = await s.api('POST', `/api/groups/${g.groupId}/send`, { accountId: 'acc_01', text: 'x' }, viewer);
    expect(denied.statusCode).toBe(403);
    expect(platformUserIdFor('acc_01')).toBeTruthy();
  });
});

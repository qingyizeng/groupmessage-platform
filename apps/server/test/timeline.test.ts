import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTx } from '../src/db/tx';
import { markRateLimited } from '../src/domain/accounts/transitions';
import { applyMemberEvent, findGroup } from '../src/domain/groups/groupRepo';
import { createTestRuntime, login, waitFor, type TestRuntime } from './helpers/app';
import { Scenario } from './helpers/scenario';

describe('timeline and membership', () => {
  let t: TestRuntime;
  let s: Scenario;

  beforeAll(async () => {
    t = await createTestRuntime();
    s = await new Scenario(t).init();
  });
  afterAll(async () => {
    await t.close();
  });

  const page = async (groupId: string, before?: string, limit = 50, token?: string) => {
    const q = new URLSearchParams({ limit: String(limit), ...(before ? { before } : {}) });
    const res = await s.api('GET', `/api/groups/${groupId}/messages?${q}`, undefined, token);
    expect(res.statusCode).toBe(200);
    return res.json() as { items: any[]; nextCursor: string | null };
  };

  it('own messages appear from queued on, with the acceptance time as sentAt', async () => {
    const g = await s.group('acc_01', ['acc_02']);
    await withTx(t.db.pool, (tx) => markRateLimited(tx, 'acc_02', 30, 'test'));
    const before = Date.now();
    const id = await s.send(g.groupId, 'acc_02', 'queued one');
    const { items } = await page(g.groupId);
    const row = items.find((m) => m.clientMsgId === id);
    expect(row).toMatchObject({ isOwn: true, deliveryStatus: 'queued', msgId: null, failCode: null, text: 'queued one' });
    expect(new Date(row.sentAt).getTime()).toBeGreaterThanOrEqual(before - 5);
    expect(new Date(row.sentAt).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('pages newest first without duplicates or gaps while new messages keep arriving', async () => {
    const g = await s.group('acc_03', ['acc_04']);
    for (let i = 0; i < 120; i++) await s.external(g.gatewayGroupId, 'pu_ext', `old ${i}`);
    await waitFor(async () => (await page(g.groupId, undefined, 200)).items.length === 120, { message: '120 stored' });

    const seen: any[] = [];
    let cursor: string | undefined;
    let n = 0;
    do {
      const p = await page(g.groupId, cursor, 50);
      seen.push(...p.items);
      cursor = p.nextCursor ?? undefined;
      for (let i = 0; i < 10; i++) await s.external(g.gatewayGroupId, 'pu_ext', `new ${n}-${i}`);
      n++;
    } while (cursor);

    const olds = seen.filter((m) => m.text.startsWith('old '));
    expect(olds).toHaveLength(120);
    expect(new Set(seen.map((m) => m.id)).size).toBe(seen.length);
    const keys = seen.map((m) => [new Date(m.sentAt).getTime(), m.id] as const);
    for (let i = 1; i < keys.length; i++) {
      const [ta, ia] = keys[i - 1]!;
      const [tb, ib] = keys[i]!;
      expect(ta > tb || (ta === tb && ia > ib)).toBe(true);
    }
    expect(olds.every((m) => m.isOwn === false && m.deliveryStatus === null)).toBe(true);
  });

  it('sorts backfilled messages by their original sentAt', async () => {
    const g = await s.group('acc_05', ['acc_06']);
    await s.external(g.gatewayGroupId, 'pu_ext', 'recent');
    await s.gw('POST', `/_control/groups/${g.gatewayGroupId}/backfill`, {
      accountId: 'acc_06',
      text: 'from the past',
      sentAtMsAgo: 3_600_000,
    });
    // Unmatched own echoes stay hidden until they are known not to belong to a pending send.
    await waitFor(async () => (await t.db.pool.query('SELECT 1 FROM messages WHERE echo_pending')).rowCount === 1, {
      message: 'echo stored hidden',
    });
    expect((await page(g.groupId)).items.map((m) => m.text)).toEqual(['recent']);
    await t.db.pool.query(`UPDATE messages SET created_at = now() - interval '1 hour' WHERE echo_pending`);
    await waitFor(async () => (await page(g.groupId)).items.length === 2, { timeout: 8000, message: 'orphan revealed' });
    const { items } = await page(g.groupId);
    expect(items.map((m) => m.text)).toEqual(['recent', 'from the past']);
    expect(items[1]).toMatchObject({ isOwn: true, deliveryStatus: 'sent' });
  });

  it('validates the cursor and the limit; viewers can read', async () => {
    const g = await s.group('acc_07', ['acc_08']);
    expect((await s.api('GET', `/api/groups/${g.groupId}/messages?before=garbage`)).statusCode).toBe(400);
    expect((await s.api('GET', `/api/groups/${g.groupId}/messages?limit=0`)).statusCode).toBe(400);
    expect((await s.api('GET', `/api/groups/nope/messages`)).statusCode).toBe(404);
    const viewer = (await login(t.app, 'viewer')).accessToken;
    await page(g.groupId, undefined, 50, viewer);
  });

  it('member events are order-independent: the newest event id wins', async () => {
    const g = await s.group('acc_01', ['acc_03']);
    const group = (await findGroup(t.db.pool, g.groupId))!;
    const presence = async () =>
      (await t.db.pool.query(`SELECT present FROM group_members WHERE group_id = $1 AND platform_user_id = 'pu_x'`, [g.groupId]))
        .rows[0]?.present;
    await withTx(t.db.pool, (tx) => applyMemberEvent(tx, group, 'pu_x', true, 1_000_003));
    await withTx(t.db.pool, (tx) => applyMemberEvent(tx, group, 'pu_x', true, 1_000_009));
    await withTx(t.db.pool, (tx) => applyMemberEvent(tx, group, 'pu_x', false, 1_000_007));
    expect(await presence()).toBe(true);
    await withTx(t.db.pool, (tx) => applyMemberEvent(tx, group, 'pu_x', false, 1_000_010));
    await withTx(t.db.pool, (tx) => applyMemberEvent(tx, group, 'pu_x', true, 1_000_008));
    expect(await presence()).toBe(false);
  });

  it('member_joined / member_left events from the gateway update membership', async () => {
    const g = await s.group('acc_02', ['acc_04']);
    await s.gw('POST', `/_control/groups/${g.gatewayGroupId}/external-join`, { platformUserId: 'pu_guest' });
    const isPresent = async (pu: string) =>
      (await t.db.pool.query('SELECT present FROM group_members WHERE group_id = $1 AND platform_user_id = $2', [g.groupId, pu]))
        .rows[0]?.present;
    await waitFor(async () => (await isPresent('pu_guest')) === true, { message: 'guest joined' });
    await s.gw('POST', `/_control/groups/${g.gatewayGroupId}/external-leave`, { platformUserId: 'pu_guest' });
    await waitFor(async () => (await isPresent('pu_guest')) === false, { message: 'guest left' });
  });
});

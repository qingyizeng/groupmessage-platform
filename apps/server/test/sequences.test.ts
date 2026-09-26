import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FAST_TIMINGS } from '@gmp/mock-gateway';
import { withTx } from '../src/db/tx';
import { markRateLimited } from '../src/domain/accounts/transitions';
import { createTestRuntime, login, waitFor, type TestRuntime } from './helpers/app';
import { Scenario } from './helpers/scenario';

describe('scheduled sequences', () => {
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
    await s.clearFaults();
    t.gw.state.timings = { ...FAST_TIMINGS };
  });

  const createSequence = async (steps: { accountRole: 'admin' | 'member'; text: string; delaySeconds: number }[]) => {
    const res = await s.api('POST', '/api/sequences', { name: 'seq', steps: steps.map((st, i) => ({ index: i + 1, ...st })) });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  };
  const start = (groupId: string, sequenceId: string, vars: object = {}, stepVars: object = {}) =>
    s.api('POST', `/api/groups/${groupId}/sequence-runs`, { sequenceId, vars, stepVars });
  const run = async (runId: string) => (await s.api('GET', `/api/sequence-runs/${runId}`)).json();
  const settle = (runId: string, timeout = 10_000) =>
    waitFor(async () => {
      const r = await run(runId);
      return r.status !== 'running' ? r : null;
    }, { timeout, message: `sequence run ${runId} settled` });
  const landed = (gg: string) => t.gw.state.groups.get(gg)!.messages;

  /** creator acc_01, admin acc_02, members acc_03 / acc_04. */
  const setupGroup = async (creator = 'acc_01', admin = 'acc_02', members = ['acc_03', 'acc_04']) => {
    const g = await s.group(creator, [admin, ...members]);
    await t.db.pool.query(`UPDATE group_members SET role = 'admin' WHERE group_id = $1 AND account_id = $2`, [g.groupId, admin]);
    return g;
  };

  it('validates sequence definitions', async () => {
    const bad = await s.api('POST', '/api/sequences', { name: 'x', steps: [{ index: 2, accountRole: 'owner', text: '', delaySeconds: -1 }] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('VALIDATION_ERROR');
    expect(bad.json().error.errors.length).toBeGreaterThanOrEqual(3);
    const viewer = (await login(t.app, 'viewer')).accessToken;
    const denied = await s.api('POST', '/api/sequences', { name: 'x', steps: [] }, viewer);
    expect(denied.statusCode).toBe(403);
  });

  it('S8: unresolved placeholder in step 3 → 422 with stepIndex/key; nothing is sent or recorded', async () => {
    const g = await setupGroup();
    const seq = await createSequence([
      { accountRole: 'admin', text: '{event} 开始', delaySeconds: 0 },
      { accountRole: 'member', text: '资料在 {location}', delaySeconds: 0 },
      { accountRole: 'member', text: '主持人 {host}', delaySeconds: 0 },
    ]);
    const res = await start(g.groupId, seq, { event: '周会' }, { '2': { location: '共享盘' } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatchObject({ code: 'UNRESOLVED_PLACEHOLDER', stepIndex: 3, key: 'host' });
    expect(typeof res.json().error.requestId).toBe('string');
    const runs = await t.db.pool.query('SELECT 1 FROM sequence_runs WHERE group_id = $1', [g.groupId]);
    expect(runs.rowCount).toBe(0);
    await new Promise((r) => setTimeout(r, 300));
    expect(landed(g.gatewayGroupId)).toHaveLength(0);

    const ok = await start(g.groupId, seq, { event: '周会', host: 'Ann' }, { '2': { location: '共享盘' } });
    expect(ok.statusCode).toBe(201);
    await settle(ok.json().runId);
  });

  it('S7: two concurrent starts → exactly one 201 and one 409', async () => {
    const g = await setupGroup('acc_05', 'acc_06', ['acc_07']);
    const seq = await createSequence([{ accountRole: 'admin', text: 'hi', delaySeconds: 1 }]);
    const results = await Promise.all([start(g.groupId, seq), start(g.groupId, seq)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.statusCode === 409)!.json().error.code).toBe('SEQUENCE_ALREADY_RUNNING');
    const runId = results.find((r) => r.statusCode === 201)!.json().runId;
    expect((await s.api('GET', `/api/groups/${g.groupId}`)).json().activeSequenceRunId).toBe(runId);
    await settle(runId);
    expect((await s.api('GET', `/api/groups/${g.groupId}`)).json().activeSequenceRunId).toBeNull();
  });

  it('sends resolved texts on schedule, each step delaySeconds after the previous message_sent', async () => {
    const g = await setupGroup();
    t.gw.state.timings = { ...FAST_TIMINGS, sentEventMs: [300, 300] };
    const seq = await createSequence([
      { accountRole: 'admin', text: '{event} 将于 {time} 开始', delaySeconds: 1 },
      { accountRole: 'member', text: '提醒：{event} 的资料已上传到 {location}', delaySeconds: 1 },
      { accountRole: 'member', text: '{event} 结束', delaySeconds: 0 },
    ]);
    const startedAt = Date.now();
    const res = await start(g.groupId, seq, { event: '周会', time: '10:00', location: '共享盘' }, { '2': { location: '共享盘/Q2' } });
    const r = await settle(res.json().runId);
    expect(r.status).toBe('finished');
    expect(r.steps.map((st: any) => st.status)).toEqual(['sent', 'sent', 'sent']);
    expect(r.steps.map((st: any) => st.text)).toEqual(['周会 将于 10:00 开始', '提醒：周会 的资料已上传到 共享盘/Q2', '周会 结束']);
    expect(r.steps[1].varSources).toEqual({ event: 'default', location: 'step:2' });
    expect(r.steps[2].resolvedVars).toEqual({ event: '周会' });

    // Account choice: admin step prefers the admin; member steps use the first member by id.
    expect(r.steps.map((st: any) => st.accountId)).toEqual(['acc_02', 'acc_03', 'acc_03']);
    const sent = r.steps.map((st: any) => Date.parse(st.sentAt));
    const scheduled = r.steps.map((st: any) => Date.parse(st.scheduledAt));
    expect(scheduled[0] - startedAt).toBeGreaterThanOrEqual(950);
    expect(scheduled[1] - sent[0]).toBe(1000);
    expect(scheduled[2] - sent[1]).toBe(0);
    const texts = landed(g.gatewayGroupId).map((m) => m.text);
    expect(texts).toEqual(['周会 将于 10:00 开始', '提醒：周会 的资料已上传到 共享盘/Q2', '周会 结束']);
    const messages = (await s.api('GET', `/api/groups/${g.groupId}/messages`)).json().items;
    expect(messages.every((m: any) => m.source === 'sequence')).toBe(true);
  });

  it('skips a step without a matching account; progress continues', async () => {
    const g = await s.group('acc_05', ['acc_06']);
    await t.db.pool.query(`UPDATE group_members SET role = 'admin' WHERE group_id = $1 AND account_id = 'acc_06'`, [g.groupId]);
    const seq = await createSequence([
      { accountRole: 'member', text: 'needs a member', delaySeconds: 0 },
      { accountRole: 'admin', text: 'admin speaks', delaySeconds: 0 },
    ]);
    const r = await settle((await start(g.groupId, seq)).json().runId);
    expect(r.status).toBe('finished');
    expect(r.steps[0]).toMatchObject({ status: 'skipped', accountId: null });
    expect(r.steps[0].skippedAt).toBeTruthy();
    expect(r.steps[1]).toMatchObject({ status: 'sent', accountId: 'acc_06' });
  });

  it('a rate-limited account postpones the step instead of skipping it', async () => {
    const g = await setupGroup('acc_01', 'acc_02', ['acc_07']);
    await withTx(t.db.pool, (tx) => markRateLimited(tx, 'acc_07', 1, 'test'));
    const seq = await createSequence([{ accountRole: 'member', text: 'after the limit', delaySeconds: 0 }]);
    const res = await start(g.groupId, seq);
    await new Promise((r) => setTimeout(r, 400));
    expect((await run(res.json().runId)).steps[0]).toMatchObject({ status: 'pending', accountId: 'acc_07' });
    const r = await settle(res.json().runId);
    expect(r.steps[0].status).toBe('sent');
    expect(Date.parse(r.steps[0].sentAt)).toBeGreaterThan(Date.parse(r.createdAt) + 900);
  });

  it('a step whose account became terminal is skipped; a failed send fails the run', async () => {
    const g = await setupGroup('acc_03', 'acc_04', ['acc_08']);
    await withTx(t.db.pool, (tx) => markRateLimited(tx, 'acc_08', 30, 'test'));
    const seq = await createSequence([
      { accountRole: 'member', text: 'stuck', delaySeconds: 0 },
      { accountRole: 'admin', text: 'next one', delaySeconds: 0 },
      { accountRole: 'admin', text: 'will fail', delaySeconds: 1 },
    ]);
    const runId = (await start(g.groupId, seq)).json().runId;
    await waitFor(async () => (await run(runId)).steps[0].accountId === 'acc_08');
    await s.api('POST', '/api/accounts/acc_08/transition', { to: 'suspended', expectedFrom: 'rate_limited' });
    await waitFor(async () => (await run(runId)).steps[1].status === 'sent');
    await s.fault({ endpoint: 'send', action: { type: 'error', status: 403, code: 'SENDER_NOT_IN_GROUP' } });
    const r = await settle(runId);
    expect(r.status).toBe('failed');
    expect(r.steps.map((st: any) => [st.status, st.failCode])).toEqual([
      ['skipped', 'ACCOUNT_TERMINAL'],
      ['sent', null],
      ['failed', 'SENDER_NOT_IN_GROUP'],
    ]);
  });

  it('the group becoming unreachable stops the run', async () => {
    const g = await setupGroup('acc_01', 'acc_02', ['acc_05']);
    const seq = await createSequence([
      { accountRole: 'admin', text: 'first', delaySeconds: 0 },
      { accountRole: 'member', text: 'second', delaySeconds: 1 },
    ]);
    const runId = (await start(g.groupId, seq)).json().runId;
    await waitFor(async () => (await run(runId)).steps[0].status === 'sent');
    t.gw.state.groups.get(g.gatewayGroupId)!.writable = false;
    await s.send(g.groupId, 'acc_05', 'trip the forbidden flag');
    const r = await settle(runId);
    expect(r.status).toBe('stopped');
    expect(r.steps[1].status).not.toBe('sent');
    const again = await start(g.groupId, seq);
    expect(again.json().error.code).toBe('GROUP_UNREACHABLE');
  });

  it('after a restart only the earliest overdue step is re-planned (restart + delaySeconds)', async () => {
    const g = await s.group('acc_06', ['acc_07']);
    await t.db.pool.query(`UPDATE group_members SET role = 'admin' WHERE group_id = $1 AND account_id = 'acc_07'`, [g.groupId]);
    const seq = await createSequence([
      { accountRole: 'admin', text: 'one', delaySeconds: 1 },
      { accountRole: 'admin', text: 'two', delaySeconds: 1 },
      { accountRole: 'admin', text: 'three', delaySeconds: 1 },
    ]);
    const runId = (await start(g.groupId, seq)).json().runId;
    await t.stopServer();
    await new Promise((r) => setTimeout(r, 3_500));
    const restartedAt = Date.now();
    await t.startServer();
    const r = await settle(runId, 15_000);
    expect(r.status).toBe('finished');
    const sent = r.steps.map((st: any) => Date.parse(st.sentAt));
    // Not fired on restart: step 1 goes out one delay after the restart, then each step one delay later.
    expect(sent[0] - restartedAt).toBeGreaterThanOrEqual(950);
    expect(sent[1] - sent[0]).toBeGreaterThanOrEqual(1000);
    expect(sent[2] - sent[1]).toBeGreaterThanOrEqual(1000);
  });

  it('run APIs: 404s and listing', async () => {
    expect((await s.api('GET', '/api/sequence-runs/nope')).json().error.code).toBe('SEQUENCE_RUN_NOT_FOUND');
    const g = await setupGroup('acc_02', 'acc_04', ['acc_05']);
    expect((await start(g.groupId, '00000000-0000-0000-0000-000000000000')).json().error.code).toBe('SEQUENCE_NOT_FOUND');
    const seq = await createSequence([{ accountRole: 'admin', text: 'x', delaySeconds: 0 }]);
    const runId = (await start(g.groupId, seq)).json().runId;
    await settle(runId);
    const list = (await s.api('GET', `/api/groups/${g.groupId}/sequence-runs`)).json();
    expect(list[0]).toMatchObject({ id: runId, status: 'finished', sequenceId: seq });
    expect((await s.api('GET', '/api/sequences')).json().some((q: any) => q.id === seq)).toBe(true);
  });
});

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FAST_TIMINGS, platformUserIdFor } from '@gmp/mock-gateway';
import { failpoints } from '../src/lib/failpoints';
import { createTestRuntime, login, waitFor, type TestRuntime } from './helpers/app';
import { Scenario } from './helpers/scenario';

describe('group lifecycle', () => {
  let t: TestRuntime;
  let s: Scenario;

  beforeAll(async () => {
    t = await createTestRuntime();
    s = await new Scenario(t).init();
    await s.connect('acc_01', 'acc_02', 'acc_03', 'acc_04', 'acc_05', 'acc_06');
  });
  afterAll(async () => {
    await t.close();
  });
  afterEach(async () => {
    failpoints.clear();
    await s.clearFaults();
    t.gw.state.timings = { ...FAST_TIMINGS };
  });

  const create = async (creatorAccountId: string, memberAccountIds: string[]) => {
    const res = await s.api('POST', '/api/groups', { creatorAccountId, memberAccountIds });
    expect(res.statusCode).toBe(202);
    return res.json().jobId as string;
  };
  const job = async (jobId: string) => (await s.api('GET', `/api/jobs/${jobId}`)).json();
  const settle = (jobId: string, timeout = 10_000) =>
    waitFor(async () => {
      const j = await job(jobId);
      return j.status !== 'running' ? j : null;
    }, { timeout, message: `job ${jobId} settled` });
  const group = async (groupId: string) => (await s.api('GET', `/api/groups/${groupId}`)).json();
  const gwGroup = (gatewayGroupId: string) => t.gw.state.groups.get(gatewayGroupId)!;
  const calls = (endpoint: string, groupId?: string) =>
    t.gw.state.calls.filter((c) => c.endpoint === endpoint && (!groupId || c.groupId === groupId));

  it('validates the request', async () => {
    const bad = async (body: unknown) => (await s.api('POST', '/api/groups', body)).json().error.code;
    expect(await bad({ creatorAccountId: 'acc_01', memberAccountIds: [] })).toBe('VALIDATION_ERROR');
    expect(await bad({ creatorAccountId: 'acc_01', memberAccountIds: ['acc_01'] })).toBe('VALIDATION_ERROR');
    expect(await bad({ creatorAccountId: 'acc_01', memberAccountIds: ['acc_02', 'acc_02'] })).toBe('VALIDATION_ERROR');
    expect(await bad({ creatorAccountId: 'acc_01', memberAccountIds: ['nope'] })).toBe('VALIDATION_ERROR');
    const offline = await s.api('POST', '/api/groups', { creatorAccountId: 'acc_01', memberAccountIds: ['acc_08'] });
    expect(offline.statusCode).toBe(422);
    expect(offline.json().error).toMatchObject({ code: 'ACCOUNT_NOT_ONLINE', accountIds: ['acc_08'] });
    const viewer = (await login(t.app, 'viewer')).accessToken;
    const denied = await s.api('POST', '/api/groups', { creatorAccountId: 'acc_01', memberAccountIds: ['acc_02'] }, viewer);
    expect(denied.statusCode).toBe(403);
  });

  it('creates the group, joins members and promotes the first one to admin', async () => {
    const jobId = await create('acc_01', ['acc_02', 'acc_03']);
    const j = await settle(jobId);
    expect(j).toMatchObject({ status: 'finished', errors: [] });
    const g = await group(j.groupId);
    expect(g).toMatchObject({
      status: 'active',
      creatorAccountId: 'acc_01',
      agentEnabled: false,
      autoKickEnabled: false,
      activeAgentRunId: null,
      activeSequenceRunId: null,
    });
    expect(g.members).toEqual([
      { accountId: 'acc_01', platformUserId: platformUserIdFor('acc_01'), role: 'creator' },
      { accountId: 'acc_02', platformUserId: platformUserIdFor('acc_02'), role: 'admin' },
      { accountId: 'acc_03', platformUserId: platformUserIdFor('acc_03'), role: 'member' },
    ]);
    expect(gwGroup(g.gatewayGroupId).promoted.has(platformUserIdFor('acc_02'))).toBe(true);
    expect(calls('promote', g.gatewayGroupId)).toHaveLength(1);
    const list = (await s.api('GET', '/api/groups')).json();
    expect(list.map((x: any) => x.id)).toContain(j.groupId);
  });

  it('waits for a not-yet-ready invite and renews an expired one once', async () => {
    t.gw.state.timings = { ...FAST_TIMINGS, inviteReadyAfterMs: [800] };
    await s.fault({ endpoint: 'join', accountId: 'acc_05', action: { type: 'error', status: 409, code: 'INVITE_NOT_READY' } });
    await s.fault({ endpoint: 'join', accountId: 'acc_06', action: { type: 'error', status: 410, code: 'INVITE_EXPIRED' } });
    const started = Date.now();
    const j = await settle(await create('acc_04', ['acc_05', 'acc_06']));
    expect(j.status).toBe('finished');
    const g = await group(j.groupId);
    const joins = calls('join', g.gatewayGroupId);
    expect(Math.min(...joins.map((c) => c.at)) - started).toBeGreaterThanOrEqual(700);
    expect(calls('invite', g.gatewayGroupId)).toHaveLength(2);
    expect(g.members.map((m: any) => m.role)).toEqual(['creator', 'admin', 'member']);
    expect(await s.accountStatus('acc_06')).toBe('online');
  });

  it('ALREADY_MEMBER counts as joined and goes straight to promote', async () => {
    await s.fault({ endpoint: 'join', accountId: 'acc_02', action: { type: 'already_member' } });
    const j = await settle(await create('acc_01', ['acc_02']));
    expect(j).toMatchObject({ status: 'finished', errors: [] });
    const g = await group(j.groupId);
    expect(g.members.find((m: any) => m.accountId === 'acc_02')?.role).toBe('admin');
  });

  it('NOT_MEMBER_YET is retried once; promote is called at most twice', async () => {
    await s.fault({ endpoint: 'promote', action: { type: 'error', status: 409, code: 'NOT_MEMBER_YET' } });
    const ok = await settle(await create('acc_03', ['acc_04']));
    expect(ok.status).toBe('finished');
    const g1 = await group(ok.groupId);
    expect(calls('promote', g1.gatewayGroupId)).toHaveLength(2);

    await s.fault({ endpoint: 'promote', times: 5, action: { type: 'error', status: 409, code: 'NOT_MEMBER_YET' } });
    const bad = await settle(await create('acc_03', ['acc_05']));
    expect(bad).toMatchObject({ status: 'failed', errors: [{ step: 'promote', code: 'NOT_MEMBER_YET' }] });
    const g2 = await group(bad.groupId);
    expect(calls('promote', g2.gatewayGroupId)).toHaveLength(2);
  });

  it('member_joined that never arrives fails the job with JOIN_TIMEOUT', async () => {
    await s.fault({ endpoint: 'join', accountId: 'acc_06', action: { type: 'never_join' } });
    const j = await settle(await create('acc_01', ['acc_05', 'acc_06']));
    expect(j).toMatchObject({ status: 'failed', errors: [{ step: 'join:acc_06', code: 'JOIN_TIMEOUT' }] });
    const g = await group(j.groupId);
    expect(g.members.map((m: any) => [m.accountId, m.role])).toEqual([
      ['acc_01', 'creator'],
      ['acc_05', 'admin'],
    ]);
  });

  it('a join error is reported per account', async () => {
    await s.fault({ endpoint: 'join', accountId: 'acc_04', action: { type: 'error', status: 409, code: 'ACCOUNT_OFFLINE' } });
    const j = await settle(await create('acc_02', ['acc_03', 'acc_04']));
    expect(j).toMatchObject({ status: 'failed', errors: [{ step: 'join:acc_04', code: 'ACCOUNT_OFFLINE' }] });
  });

  it('resumes after a restart without creating a second group', async () => {
    failpoints.arm('job.create_group.after_create', 1);
    const before = t.gw.state.groups.size;
    const jobId = await create('acc_04', ['acc_05']);
    await waitFor(() => t.gw.state.groups.size === before + 1, { message: 'gateway group created' });
    await t.restart();
    const j = await settle(jobId);
    expect(j.status).toBe('finished');
    expect(t.gw.state.groups.size).toBe(before + 1);
    expect((await group(j.groupId)).members.map((m: any) => m.role)).toEqual(['creator', 'admin']);
  });

  it('PATCH updates the flags; viewers cannot', async () => {
    const j = await settle(await create('acc_01', ['acc_02']));
    const res = await s.api('PATCH', `/api/groups/${j.groupId}`, { agentEnabled: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ agentEnabled: true, autoKickEnabled: false });
    expect((await s.api('PATCH', `/api/groups/${j.groupId}`, {})).statusCode).toBe(400);
    expect((await s.api('PATCH', `/api/groups/${j.groupId}`, { agentEnabled: 'yes' })).statusCode).toBe(400);
    const viewer = (await login(t.app, 'viewer')).accessToken;
    expect((await s.api('PATCH', `/api/groups/${j.groupId}`, { autoKickEnabled: true }, viewer)).statusCode).toBe(403);
    expect((await s.api('GET', `/api/groups/${j.groupId}`, undefined, viewer)).statusCode).toBe(200);
    expect((await s.api('GET', '/api/groups/00000000-0000-0000-0000-000000000000')).statusCode).toBe(404);
    expect((await s.api('GET', '/api/jobs/00000000-0000-0000-0000-000000000000')).statusCode).toBe(404);
  });

  it('leave-all: everyone leaves, the owner last; group becomes left with no members', async () => {
    const created = await settle(await create('acc_01', ['acc_02', 'acc_03']));
    const g = await group(created.groupId);
    await s.external(g.gatewayGroupId, 'pu_guest', 'hi');
    const res = await s.api('POST', `/api/groups/${g.id}/leave-all`);
    expect(res.statusCode).toBe(202);
    const j = await settle(res.json().jobId);
    expect(j).toMatchObject({ status: 'finished', errors: [] });
    expect(await group(g.id)).toMatchObject({ status: 'left', members: [] });
    const leaves = calls('leave', g.gatewayGroupId);
    expect(leaves.map((c) => c.accountId)).toEqual(['acc_02', 'acc_03', 'acc_01']);
    const remaining = [...gwGroup(g.gatewayGroupId).members];
    expect(remaining.some((pu) => ['acc_01', 'acc_02', 'acc_03'].map(platformUserIdFor).includes(pu))).toBe(false);
    expect((await s.api('POST', `/api/groups/${g.id}/leave-all`)).json().error.code).toBe('GROUP_LEFT');
  });

  it('leave-all: a failed non-owner leave is recorded, others continue, the owner stays', async () => {
    const created = await settle(await create('acc_04', ['acc_05', 'acc_06', 'acc_02']));
    const g = await group(created.groupId);
    await s.fault({ endpoint: 'leave', accountId: 'acc_05', action: { type: 'error', status: 500, code: 'INTERNAL' } });
    const j = await settle((await s.api('POST', `/api/groups/${g.id}/leave-all`)).json().jobId);
    expect(j).toMatchObject({ status: 'failed', errors: [{ step: 'leave:acc_05', code: 'INTERNAL' }] });
    const after = await group(g.id);
    expect(after.status).toBe('active');
    expect(after.members.map((m: any) => m.accountId).sort()).toEqual(['acc_04', 'acc_05']);
    const gwMembers = [...gwGroup(g.gatewayGroupId).members].sort();
    expect(gwMembers).toEqual([platformUserIdFor('acc_04'), platformUserIdFor('acc_05')].sort());
    expect(calls('leave', g.gatewayGroupId).map((c) => c.accountId)).not.toContain('acc_04');
  });
});

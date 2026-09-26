import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FAST_TIMINGS } from '@gmp/mock-gateway';
import { createTestRuntime, login, waitFor, type TestRuntime } from './helpers/app';
import { Scenario } from './helpers/scenario';

describe('agent runs', () => {
  let t: TestRuntime;
  let s: Scenario;
  let n = 0;

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
    t.gw.state.duplicateEvents = false;
    t.agent.state.audits.clear();
  });

  /** A fresh agent-enabled group: creator acc_01 (can kick), member acc_02 (sends). */
  const agentGroup = async (autoKick = false) => {
    const g = await s.group('acc_01', ['acc_02']);
    await s.enableAgent(g.groupId, autoKick);
    return g;
  };
  const say = (g: { gatewayGroupId: string }, text: string, who = `pu_user_${++n}`) =>
    s.external(g.gatewayGroupId, who, text);
  const turnsOf = (runId: string) => t.agent.state.turnCalls.filter((c) => c.runId === runId);
  const auditsOf = (groupId: string) => t.agent.state.auditCalls.filter((c) => c.groupId === groupId);
  const gatewayMessages = (gg: string) => t.gw.state.groups.get(gg)!.messages;

  it('default agent: reads, replies once and finishes; its own reply does not trigger a new run', async () => {
    const g = await agentGroup();
    await say(g, 'hello there');
    const [run] = await s.settledRuns(g.groupId);
    expect(run).toMatchObject({ status: 'finished', endReason: 'final', stepCount: 3 });
    expect(run.triggerMessages).toHaveLength(1);
    expect(run.triggerMessages[0]).toMatchObject({ text: 'hello there' });

    const detail = await s.run(run.id);
    expect(detail.steps.map((st: any) => [st.kind, st.name])).toEqual([
      ['tool_use', 'get_recent_messages'],
      ['tool_use', 'send_message'],
      ['final', 'finish'],
    ]);
    expect(detail.steps[1]).toMatchObject({ isError: false, auditVerdict: 'pass', errorCode: null });
    expect(JSON.parse(detail.steps[1].resultSummary)).toMatchObject({ deliveryStatus: expect.stringMatching(/accepted|sent/) });
    for (const st of detail.steps) expect(st.rawResponse).toBeTruthy();
    expect(detail.summary).toBeTruthy();

    await waitFor(() => gatewayMessages(g.gatewayGroupId).some((m) => m.text === '收到：hello there'));
    await new Promise((r) => setTimeout(r, 500));
    expect(await s.runs(g.groupId)).toHaveLength(1);
    const own = (await s.api('GET', `/api/groups/${g.groupId}/messages`)).json().items.filter((m: any) => m.isOwn);
    expect(own).toHaveLength(1);
  });

  it('S2: duplicated events do not trigger twice', async () => {
    const g = await agentGroup();
    t.gw.state.duplicateEvents = true;
    await say(g, 'once');
    await s.settledRuns(g.groupId);
    await new Promise((r) => setTimeout(r, 500));
    expect(await s.runs(g.groupId)).toHaveLength(1);
  });

  it('messages arriving during a run go, all together, into the next run', async () => {
    const g = await agentGroup();
    s.script(g.groupId, [{ delayMs: 800, toolUse: { name: 'finish', input: { summary: 'slow' } } }]);
    await say(g, 'first');
    await waitFor(async () => (await s.runs(g.groupId)).length === 1);
    await say(g, 'second');
    await say(g, 'third');
    const runs = await s.settledRuns(g.groupId, 2);
    expect(runs[0].triggerMessages.map((m: any) => m.text)).toEqual(['first']);
    expect(runs[1].triggerMessages.map((m: any) => m.text)).toEqual(['second', 'third']);
    const running = await t.db.pool.query(`SELECT count(*)::int AS c FROM agent_runs WHERE group_id = $1`, [g.groupId]);
    expect(running.rows[0].c).toBe(2);
  });

  it('group DTO exposes the running run', async () => {
    const g = await agentGroup();
    s.script(g.groupId, [{ delayMs: 700, toolUse: { name: 'finish', input: { summary: 'x' } } }]);
    await say(g, 'hi');
    const active = await waitFor(async () => (await s.api('GET', `/api/groups/${g.groupId}`)).json().activeAgentRunId);
    expect((await s.run(active)).status).toBe('running');
    await s.settledRuns(g.groupId);
    expect((await s.api('GET', `/api/groups/${g.groupId}`)).json().activeAgentRunId).toBeNull();
  });

  it('S5: same idempotency_key after a 504 that landed → one gateway message, second call reports sent without audit', async () => {
    const g = await agentGroup();
    await s.fault({ endpoint: 'send', action: { type: 'timeout', effect: true, landAfterMs: 1500 } });
    s.script(g.groupId, [
      { toolUse: { name: 'send_message', input: { text: 'only once', idempotency_key: 'k-1' } } },
      { toolUse: { name: 'send_message', input: { text: 'only once', idempotency_key: 'k-1' } } },
      { toolUse: { name: 'finish', input: { summary: 'done' } } },
    ]);
    await say(g, 'trigger');
    const [run] = await s.settledRuns(g.groupId, 1, 15_000);
    expect(run).toMatchObject({ status: 'finished', endReason: 'final' });
    expect(gatewayMessages(g.gatewayGroupId).filter((m) => m.text === 'only once')).toHaveLength(1);
    const { steps } = await s.run(run.id);
    expect(JSON.parse(steps[0].resultSummary)).toMatchObject({ deliveryStatus: 'sent' });
    expect(steps[1]).toMatchObject({ isError: false, auditVerdict: null });
    expect(JSON.parse(steps[1].resultSummary)).toMatchObject({ deliveryStatus: 'sent' });
    expect(auditsOf(g.groupId)).toHaveLength(1);
  });

  it('S6: bad JSON, then an unknown tool, then end_turn → final; every step has kind and raw response', async () => {
    const g = await agentGroup();
    s.script(g.groupId, [
      { raw: 'this is not json' },
      { toolUse: { name: 'do_magic', input: {} } },
      { endTurn: 'all done' },
    ]);
    await say(g, 'go');
    const [run] = await s.settledRuns(g.groupId);
    expect(run).toMatchObject({ status: 'finished', endReason: 'final', summary: 'all done' });
    const { steps } = await s.run(run.id);
    expect(steps.map((st: any) => [st.kind, st.errorCode])).toEqual([
      ['protocol_error', 'BAD_JSON'],
      ['tool_use', 'UNKNOWN_TOOL'],
      ['final', null],
    ]);
    expect(steps[0]).toMatchObject({ toolUseId: null, name: null, input: null, isError: true, rawResponse: 'this is not json' });
    expect(steps.every((st: any) => st.rawResponse)).toBe(true);

    const calls = turnsOf(run.id);
    const second = calls[1]!.messages;
    expect(second[second.length - 1]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: expect.stringMatching(/^PROTOCOL_ERROR BAD_JSON: /) }],
    });
    const third = calls[2]!.messages;
    expect(third[third.length - 2]!.role).toBe('assistant');
    expect(third[third.length - 1]!.content[0]).toMatchObject({ type: 'tool_result', is_error: true });
    expect(JSON.parse(third[third.length - 1]!.content[0]!.content!).code).toBe('UNKNOWN_TOOL');
  });

  it('fenced or text-wrapped JSON and wrong shapes are BAD_JSON; three in a row end the run', async () => {
    const g = await agentGroup();
    const valid = JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'x' }] });
    s.script(g.groupId, [
      { raw: '```json\n' + valid + '\n```' },
      { raw: 'Sure! ' + valid },
      { raw: JSON.stringify({ stop_reason: 'tool_use', content: [{ type: 'text', text: 'mismatch' }] }) },
    ]);
    await say(g, 'go');
    const [run] = await s.settledRuns(g.groupId);
    expect(run).toMatchObject({ status: 'failed', endReason: 'protocol_errors', stepCount: 3 });
    expect(turnsOf(run.id)).toHaveLength(3);
  });

  it('a valid response resets the consecutive protocol error count', async () => {
    const g = await agentGroup();
    s.script(g.groupId, [
      { raw: '{', status: 200 },
      { raw: '{}', status: 500 },
      { toolUse: { name: 'get_recent_messages', input: { limit: 5 } } },
      { raw: 'nope' },
      { raw: JSON.stringify({ stop_reason: 'end_turn', content: [] }) },
      { endTurn: 'recovered' },
    ]);
    await say(g, 'go');
    const [run] = await s.settledRuns(g.groupId);
    expect(run).toMatchObject({ status: 'finished', endReason: 'final', stepCount: 6 });
  });

  it('duplicate tool_use id is a protocol error; invalid input is reported as INVALID_INPUT', async () => {
    const g = await agentGroup();
    s.script(g.groupId, [
      { toolUse: { id: 'same', name: 'get_recent_messages', input: { limit: 3 } } },
      { toolUse: { id: 'same', name: 'get_recent_messages', input: { limit: 4 } } },
      { toolUse: { name: 'send_message', input: { text: 'no key' } } },
      { toolUse: { name: 'finish', input: { summary: 'ok' } } },
    ]);
    await say(g, 'go');
    const [run] = await s.settledRuns(g.groupId);
    const { steps } = await s.run(run.id);
    expect(steps.map((st: any) => [st.kind, st.errorCode])).toEqual([
      ['tool_use', null],
      ['protocol_error', 'DUPLICATE_TOOL_USE_ID'],
      ['tool_use', 'INVALID_INPUT'],
      ['final', null],
    ]);
    expect(steps[1].toolUseId).toBeNull();
  });

  it('a turn that does not answer in time is a TURN_TIMEOUT protocol error', async () => {
    const g = await agentGroup();
    s.script(g.groupId, [{ hang: true }, { endTurn: 'late but fine' }]);
    await say(g, 'go');
    const [run] = await s.settledRuns(g.groupId);
    const { steps } = await s.run(run.id);
    expect(steps.map((st: any) => [st.kind, st.errorCode])).toEqual([
      ['protocol_error', 'TURN_TIMEOUT'],
      ['final', null],
    ]);
    expect(run.status).toBe('finished');
  });

  it('stops after 12 steps with budget_exhausted', async () => {
    const g = await agentGroup();
    s.script(
      g.groupId,
      Array.from({ length: 20 }, (_, i) => ({ toolUse: { name: 'get_recent_messages', input: { limit: i + 1 } } })),
    );
    await say(g, 'go');
    const [run] = await s.settledRuns(g.groupId);
    expect(run).toMatchObject({ status: 'failed', endReason: 'budget_exhausted', stepCount: 12 });
    expect(turnsOf(run.id)).toHaveLength(12);
  });

  it('repeated identical get_recent_messages: hint on the second, error on the third', async () => {
    const g = await agentGroup();
    const same = { toolUse: { name: 'get_recent_messages', input: { limit: 10 } } };
    s.script(g.groupId, [same, same, same]);
    await say(g, 'go');
    const [run] = await s.settledRuns(g.groupId);
    const { steps } = await s.run(run.id);
    expect(steps[1].resultSummary).toContain('hint');
    expect(steps[2]).toMatchObject({ isError: true, errorCode: 'INVALID_INPUT' });
    expect(run.status).toBe('finished');
    expect(run.stepCount).toBeLessThanOrEqual(12);
  });

  it('get_recent_messages caps limit at 50, truncates long texts and stays within 8KB', async () => {
    const g = await agentGroup();
    s.script(g.groupId, [{ delayMs: 600, toolUse: { name: 'get_recent_messages', input: { limit: 100000 } } }, { endTurn: 'x' }]);
    await say(g, 'x'.repeat(2000));
    for (let i = 0; i < 60; i++) await say(g, `filler ${i}`, 'pu_filler');
    const runs = await s.settledRuns(g.groupId, 1);
    const call = turnsOf(runs[0].id)[1]!.messages;
    const result = call[call.length - 1]!.content[0]!;
    expect(Buffer.byteLength(result.content!)).toBeLessThanOrEqual(8192);
    const parsed = JSON.parse(result.content!);
    expect(parsed.messages.length).toBeLessThanOrEqual(50);
    expect(parsed.messages.every((m: any) => [...m.text].length <= 500)).toBe(true);
  });

  it('audit fail → AUDIT_REJECTED and nothing sent; the key is not consumed', async () => {
    const g = await agentGroup();
    s.audits([{ verdict: 'fail', reason: 'rude' }], g.groupId);
    s.script(g.groupId, [
      { toolUse: { name: 'send_message', input: { text: 'rude words', idempotency_key: 'k' } } },
      { toolUse: { name: 'send_message', input: { text: 'polite words', idempotency_key: 'k' } } },
      { toolUse: { name: 'finish', input: { summary: 'ok' } } },
    ]);
    await say(g, 'go');
    const [run] = await s.settledRuns(g.groupId);
    const { steps } = await s.run(run.id);
    expect(steps[0]).toMatchObject({ isError: true, errorCode: 'AUDIT_REJECTED', auditVerdict: 'fail' });
    expect(steps[1]).toMatchObject({ isError: false, auditVerdict: 'pass' });
    await waitFor(() => gatewayMessages(g.gatewayGroupId).some((m) => m.text === 'polite words'));
    expect(gatewayMessages(g.gatewayGroupId).some((m) => m.text === 'rude words')).toBe(false);
  });

  it('unclear audits are retried (not steps); three unclear answers block the run', async () => {
    const g = await agentGroup();
    s.audits([{ status: 500 }, { raw: 'not json' }, { verdict: 'pass' }], g.groupId);
    s.script(g.groupId, [
      { toolUse: { name: 'send_message', input: { text: 'third time lucky', idempotency_key: 'a' } } },
      { toolUse: { name: 'finish', input: { summary: 'ok' } } },
    ]);
    await say(g, 'go');
    const [ok] = await s.settledRuns(g.groupId);
    expect(ok).toMatchObject({ status: 'finished', stepCount: 2 });
    expect(auditsOf(g.groupId)).toHaveLength(3);

    const g2 = await agentGroup();
    s.audits([{ verdict: 'maybe' }, { raw: '{"reason":"no verdict"}' }, { hang: true }], g2.groupId);
    s.script(g2.groupId, [{ toolUse: { name: 'send_message', input: { text: 'blocked text', idempotency_key: 'b' } } }]);
    await say(g2, 'go');
    const [blocked] = await s.settledRuns(g2.groupId);
    expect(blocked).toMatchObject({ status: 'blocked', endReason: 'audit_blocked' });
    const { steps } = await s.run(blocked.id);
    expect(steps[0]).toMatchObject({ isError: true, auditVerdict: 'unavailable' });
    expect(gatewayMessages(g2.gatewayGroupId).some((m) => m.text === 'blocked text')).toBe(false);
    const events = await t.db.pool.query(`SELECT payload FROM ws_outbox WHERE type = 'agent_run' AND payload->>'runId' = $1`, [
      blocked.id,
    ]);
    expect(events.rows.map((r) => r.payload.status)).toContain('blocked');
  });

  it('kick: POLICY_DENIED without auto-kick (no audit); with auto-kick the creator removes the user', async () => {
    const g = await agentGroup(false);
    await s.gw('POST', `/_control/groups/${g.gatewayGroupId}/external-join`, { platformUserId: 'pu_spammer' });
    s.script(g.groupId, [
      { toolUse: { name: 'kick_user', input: { platform_user_id: 'pu_spammer', reason: 'spam' } } },
      { toolUse: { name: 'finish', input: { summary: 'x' } } },
    ]);
    await say(g, '广告', 'pu_spammer');
    const [denied] = await s.settledRuns(g.groupId);
    expect((await s.run(denied.id)).steps[0]).toMatchObject({ errorCode: 'POLICY_DENIED', auditVerdict: null });
    expect(auditsOf(g.groupId)).toHaveLength(0);

    await s.enableAgent(g.groupId, true);
    await say(g, '广告 again', 'pu_spammer');
    const runs = await s.settledRuns(g.groupId, 2);
    const kickStep = (await s.run(runs[1].id)).steps.find((st: any) => st.name === 'kick_user');
    expect(kickStep).toMatchObject({ isError: false, auditVerdict: 'pass' });
    expect(t.gw.state.groups.get(g.gatewayGroupId)!.members.has('pu_spammer')).toBe(false);
    const kickAudit = auditsOf(g.groupId).find((a) => a.text.includes('kick'))!;
    expect(JSON.parse(kickAudit.text)).toEqual({ action: 'kick', platform_user_id: 'pu_spammer', reason: 'spam' });
    const kick = t.gw.state.calls.find((c) => c.endpoint === 'kick' && c.groupId === g.gatewayGroupId)!;
    expect(kick.accountId).toBe('acc_01');
  });

  it('kick after the owner left → OWNER_LEFT; no creator/admin online → NO_AVAILABLE_ACCOUNT', async () => {
    const g = await s.group('acc_03', ['acc_04']);
    await s.enableAgent(g.groupId, true);
    await t.db.pool.query(`UPDATE group_members SET role = 'admin' WHERE group_id = $1 AND account_id = 'acc_04'`, [g.groupId]);
    t.gw.state.groups.get(g.gatewayGroupId)!.promoted.add(t.gw.state.account('acc_04').platformUserId);
    await s.gw('POST', `/_control/groups/${g.gatewayGroupId}/external-join`, { platformUserId: 'pu_target' });
    await s.gw('POST', `/groups/${g.gatewayGroupId}/leave`, { accountId: 'acc_03' });
    await waitFor(async () =>
      (await t.db.pool.query(`SELECT 1 FROM group_members WHERE group_id = $1 AND account_id = 'acc_03' AND NOT present`, [g.groupId])).rowCount,
    );
    s.script(g.groupId, [
      { toolUse: { name: 'kick_user', input: { platform_user_id: 'pu_target', reason: 'r' } } },
      { toolUse: { name: 'finish', input: { summary: 'x' } } },
    ]);
    await say(g, 'kick please');
    const [run] = await s.settledRuns(g.groupId);
    expect((await s.run(run.id)).steps[0]).toMatchObject({ isError: true, errorCode: 'OWNER_LEFT' });
    expect(await s.accountStatus('acc_04')).toBe('online');

    await s.api('POST', '/api/accounts/acc_04/transition', { to: 'disconnected', expectedFrom: 'online' });
    s.script(g.groupId, [
      { toolUse: { name: 'kick_user', input: { platform_user_id: 'pu_target', reason: 'r' } } },
      { toolUse: { name: 'finish', input: { summary: 'x' } } },
    ]);
    await say(g, 'kick again');
    const runs = await s.settledRuns(g.groupId, 2);
    expect((await s.run(runs[1].id)).steps[0]).toMatchObject({ isError: true, errorCode: 'NO_AVAILABLE_ACCOUNT' });
    await s.connect('acc_04');
  });

  it('disabling the agent cancels the running run after the current step and drops pending triggers', async () => {
    const g = await agentGroup();
    s.script(g.groupId, [
      { delayMs: 800, toolUse: { name: 'get_recent_messages', input: { limit: 1 } } },
      { toolUse: { name: 'finish', input: { summary: 'should not get here' } } },
    ]);
    await say(g, 'go');
    await waitFor(async () => (await s.runs(g.groupId)).length === 1);
    await say(g, 'pending one');
    await new Promise((r) => setTimeout(r, 200));
    await s.api('PATCH', `/api/groups/${g.groupId}`, { agentEnabled: false });
    const [run] = await s.settledRuns(g.groupId);
    expect(run).toMatchObject({ status: 'cancelled', endReason: 'cancelled', stepCount: 1 });
    await new Promise((r) => setTimeout(r, 500));
    expect(await s.runs(g.groupId)).toHaveLength(1);
  });

  it('a group becoming unreachable cancels the run; send_message reports GROUP_UNREACHABLE', async () => {
    const g = await agentGroup();
    t.gw.state.groups.get(g.gatewayGroupId)!.writable = false;
    s.script(g.groupId, [
      { toolUse: { name: 'send_message', input: { text: 'into the void', idempotency_key: 'v' } } },
      { toolUse: { name: 'finish', input: { summary: 'x' } } },
    ]);
    await say(g, 'go');
    const [run] = await s.settledRuns(g.groupId);
    expect(run).toMatchObject({ status: 'cancelled', endReason: 'cancelled', stepCount: 1 });
    expect((await s.run(run.id)).steps[0]).toMatchObject({ isError: true, errorCode: 'GROUP_UNREACHABLE' });
    await say(g, 'no more runs');
    await new Promise((r) => setTimeout(r, 500));
    expect(await s.runs(g.groupId)).toHaveLength(1);
  });

  it('agent run API: 404s, list shape, viewer can read', async () => {
    expect((await s.api('GET', '/api/agent-runs/nope')).statusCode).toBe(404);
    expect((await s.api('GET', '/api/agent-runs/00000000-0000-0000-0000-000000000000')).json().error.code).toBe(
      'AGENT_RUN_NOT_FOUND',
    );
    const g = await agentGroup();
    await say(g, 'hi');
    const [run] = await s.settledRuns(g.groupId);
    const viewer = (await login(t.app, 'viewer')).accessToken;
    const list = (await s.api('GET', `/api/groups/${g.groupId}/agent-runs`, undefined, viewer)).json();
    expect(list[0]).toMatchObject({ id: run.id, groupId: g.groupId, status: 'finished', endReason: 'final' });
    expect(list[0].steps).toBeUndefined();
    expect((await s.api('GET', `/api/agent-runs/${run.id}`, undefined, viewer)).json().steps).toHaveLength(3);
  });
});

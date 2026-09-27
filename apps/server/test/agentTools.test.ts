import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { failpoints } from '../src/lib/failpoints';
import { createTestRuntime, waitFor, type TestRuntime } from './helpers/app';
import { Scenario } from './helpers/scenario';

/** Edge cases of send_message / kick_user execution (A5.4, A5.5, A5.7, 2.2 tool results). */
describe('agent tool execution', () => {
  let t: TestRuntime;
  let s: Scenario;

  beforeAll(async () => {
    t = await createTestRuntime({ env: { AGENT_SEND_WAIT_MS: '1500' } });
    s = await new Scenario(t).init();
  });
  afterAll(async () => {
    await t.close();
  });
  afterEach(async () => {
    failpoints.clear();
    await s.clearFaults();
  });

  const agentGroup = async (creator: string, member: string, autoKick = false) => {
    const g = await s.group(creator, [member]);
    await s.enableAgent(g.groupId, autoKick);
    return g;
  };
  const trigger = (g: { gatewayGroupId: string }, text = 'go', who = 'pu_user') => s.external(g.gatewayGroupId, who, text);
  const steps = async (runId: string) => (await s.run(runId)).steps as any[];
  const sendCalls = (text: string) => t.gw.state.calls.filter((c) => c.endpoint === 'send' && (c.body as any)?.text === text);
  const audits = (text: string) => t.agent.state.auditCalls.filter((a) => a.text === text);

  it('SEND_FAILED when the account turns out to be suspended; the run continues', async () => {
    const g = await agentGroup('acc_01', 'acc_02');
    await s.fault({ endpoint: 'send', accountId: 'acc_02', action: { type: 'error', status: 403, code: 'ACCOUNT_SUSPENDED' } });
    s.script(g.groupId, [
      { toolUse: { name: 'send_message', input: { text: 'will fail', idempotency_key: 'a' } } },
      { toolUse: { name: 'finish', input: { summary: 'continued' } } },
    ]);
    await trigger(g);
    const [run] = await s.settledRuns(g.groupId);
    expect(run).toMatchObject({ status: 'finished', endReason: 'final', summary: 'continued' });
    expect((await steps(run.id))[0]).toMatchObject({ name: 'send_message', isError: true, errorCode: 'SEND_FAILED' });
    expect(await s.accountStatus('acc_02')).toBe('suspended');
  });

  it('SEND_FAILED when the account becomes terminal while the message waits in its queue', async () => {
    const g = await agentGroup('acc_03', 'acc_04');
    await s.fault({ endpoint: 'send', accountId: 'acc_04', action: { type: 'rate_limit', retryAfterSeconds: 30 } });
    s.script(g.groupId, [
      { toolUse: { name: 'send_message', input: { text: 'stuck in queue', idempotency_key: 'b' } } },
      { toolUse: { name: 'finish', input: { summary: 'ok' } } },
    ]);
    await trigger(g);
    await waitFor(async () => (await s.accountStatus('acc_04')) === 'rate_limited');
    await s.api('POST', '/api/accounts/acc_04/transition', { to: 'session_expired', expectedFrom: 'rate_limited' });
    const [run] = await s.settledRuns(g.groupId);
    expect(run.status).toBe('finished');
    expect((await steps(run.id))[0]).toMatchObject({ isError: true, errorCode: 'SEND_FAILED' });
  });

  it('SEND_TIMEOUT when delivery cannot be confirmed; the same key reports status without re-audit or re-send', async () => {
    const g = await agentGroup('acc_05', 'acc_06');
    await s.fault({ endpoint: 'send', accountId: 'acc_06', action: { type: 'rate_limit', retryAfterSeconds: 30 } });
    s.script(g.groupId, [
      { toolUse: { name: 'send_message', input: { text: 'slow one', idempotency_key: 'c' } } },
      { toolUse: { name: 'send_message', input: { text: 'slow one', idempotency_key: 'c' } } },
      { toolUse: { name: 'finish', input: { summary: 'ok' } } },
    ]);
    await trigger(g);
    const [run] = await s.settledRuns(g.groupId);
    const [first, second] = await steps(run.id);
    expect(first).toMatchObject({ isError: true, errorCode: 'SEND_TIMEOUT', auditVerdict: 'pass' });
    expect(second).toMatchObject({ isError: true, errorCode: 'SEND_TIMEOUT', auditVerdict: null });
    expect(audits('slow one')).toHaveLength(1);
    expect(sendCalls('slow one')).toHaveLength(1);
    const msgs = await t.db.pool.query(`SELECT 1 FROM messages WHERE text = 'slow one'`);
    expect(msgs.rowCount).toBe(1);
  });

  it('NO_AVAILABLE_ACCOUNT when no online member can send; it counts as a step, not a protocol error', async () => {
    const g = await agentGroup('acc_07', 'acc_08');
    for (const a of ['acc_07', 'acc_08']) {
      await s.api('POST', `/api/accounts/${a}/transition`, { to: 'disconnected', expectedFrom: 'online' });
    }
    s.script(g.groupId, [
      { toolUse: { name: 'send_message', input: { text: 'nobody', idempotency_key: 'd' } } },
      { toolUse: { name: 'finish', input: { summary: 'ok' } } },
    ]);
    await trigger(g);
    const [run] = await s.settledRuns(g.groupId);
    expect(run).toMatchObject({ status: 'finished', stepCount: 2 });
    expect((await steps(run.id))[0]).toMatchObject({ kind: 'tool_use', errorCode: 'NO_AVAILABLE_ACCOUNT' });
    const { rows } = await t.db.pool.query('SELECT consecutive_protocol_errors FROM agent_runs WHERE id = $1', [run.id]);
    expect(rows[0].consecutive_protocol_errors).toBe(0);
    await s.connect('acc_07', 'acc_08');
  });

  it('kick with a 504: checks the member list, re-kicks only if the user is still there', async () => {
    const g = await agentGroup('acc_01', 'acc_03', true);
    const kicks = () => t.gw.state.calls.filter((c) => c.endpoint === 'kick' && c.groupId === g.gatewayGroupId);
    for (const pu of ['pu_a', 'pu_b']) {
      await s.gw('POST', `/_control/groups/${g.gatewayGroupId}/external-join`, { platformUserId: pu });
    }
    await s.fault({ endpoint: 'kick', action: { type: 'timeout', effect: true } });
    s.script(g.groupId, [
      { toolUse: { name: 'kick_user', input: { platform_user_id: 'pu_a', reason: 'spam' } } },
      { toolUse: { name: 'finish', input: { summary: 'ok' } } },
    ]);
    await trigger(g, 'x', 'pu_a');
    const [first] = await s.settledRuns(g.groupId);
    expect((await steps(first.id))[0]).toMatchObject({ isError: false, resultSummary: '{"kicked":true}' });
    expect(kicks()).toHaveLength(1);

    await s.fault({ endpoint: 'kick', action: { type: 'timeout', effect: false } });
    s.script(g.groupId, [
      { toolUse: { name: 'kick_user', input: { platform_user_id: 'pu_b', reason: 'spam' } } },
      { toolUse: { name: 'finish', input: { summary: 'ok' } } },
    ]);
    await trigger(g, 'y', 'pu_b');
    const runs = await s.settledRuns(g.groupId, 2);
    expect((await steps(runs[1].id))[0]).toMatchObject({ isError: false });
    expect(kicks()).toHaveLength(3);
    expect(t.gw.state.groups.get(g.gatewayGroupId)!.members.has('pu_b')).toBe(false);
  });

  it('a retried tool-result transaction appends the tool_result to the conversation once', async () => {
    const g = await agentGroup('acc_07', 'acc_08');
    failpoints.arm('agent.tool_result_tx', 1, '40001');
    await trigger(g, 'retry me');
    const [run] = await s.settledRuns(g.groupId);
    expect(run).toMatchObject({ status: 'finished', stepCount: 3 });
    const calls = t.agent.state.turnCalls.filter((c) => c.runId === run.id);
    expect(calls[1]!.messages).toHaveLength(3);
    expect(calls[2]!.messages).toHaveLength(5);
    const { rows } = await t.db.pool.query('SELECT count(*)::int AS n FROM agent_run_messages WHERE run_id = $1', [run.id]);
    // context, 2 × (tool_use + tool_result), and the final finish tool_use.
    expect(rows[0].n).toBe(6);
  });
});

describe('agent wall clock bounds the send wait', () => {
  let t: TestRuntime;
  let s: Scenario;
  beforeAll(async () => {
    t = await createTestRuntime({ env: { AGENT_RUN_WALL_MS: '2500', AGENT_SEND_WAIT_MS: '5000' } });
    s = await new Scenario(t).init();
  });
  afterAll(async () => {
    await t.close();
  });

  it('stops waiting for delivery when the run runs out of time', async () => {
    const g = await s.group('acc_01', ['acc_02']);
    await s.enableAgent(g.groupId);
    await s.fault({ endpoint: 'send', action: { type: 'rate_limit', retryAfterSeconds: 30 } });
    s.script(g.groupId, [{ delayMs: 1000, toolUse: { name: 'send_message', input: { text: 'late', idempotency_key: 'w' } } }]);
    const started = Date.now();
    await s.external(g.gatewayGroupId, 'pu_u', 'go');
    const [run] = await s.settledRuns(g.groupId);
    expect(run).toMatchObject({ status: 'failed', endReason: 'wall_clock' });
    expect(Date.now() - started).toBeLessThan(4000);
  });
});

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { failpoints } from '../src/lib/failpoints';
import { Runtime } from '../src/runtime';
import { createTestRuntime, waitFor, type TestRuntime } from './helpers/app';
import { Scenario } from './helpers/scenario';

describe('agent run recovery', () => {
  let t: TestRuntime;
  let s: Scenario;

  beforeAll(async () => {
    t = await createTestRuntime();
    s = await new Scenario(t).init();
  });
  afterAll(async () => {
    await t.close();
  });
  afterEach(() => failpoints.clear());

  const agentGroup = async (autoKick = false) => {
    const g = await s.group('acc_01', ['acc_02']);
    await s.enableAgent(g.groupId, autoKick);
    return g;
  };
  const runIdsSeenByAgent = (groupId: string) =>
    new Set(t.agent.state.turnCalls.filter((c) => JSON.parse(c.messages[0]!.content[0]!.text!).groupId === groupId).map((c) => c.runId));

  it('crash after the message was enqueued: same run resumes, message sent once, not audited again', async () => {
    const g = await agentGroup();
    s.script(g.groupId, [
      { toolUse: { name: 'send_message', input: { text: 'exactly once', idempotency_key: 'k' } } },
      { toolUse: { name: 'finish', input: { summary: 'done' } } },
    ]);
    failpoints.arm('agent.after_enqueue', 1);
    await s.external(g.gatewayGroupId, 'pu_u', 'go');
    await waitFor(async () =>
      (await t.db.pool.query(`SELECT 1 FROM agent_tool_calls WHERE phase = 'executing' AND name = 'send_message'`)).rowCount,
    );
    await t.restart();
    const [run] = await s.settledRuns(g.groupId);
    expect(run).toMatchObject({ status: 'finished', endReason: 'final', stepCount: 2 });
    const { steps } = await s.run(run.id);
    expect(steps[0]).toMatchObject({ name: 'send_message', isError: false, auditVerdict: 'pass' });
    expect(t.gw.state.groups.get(g.gatewayGroupId)!.messages.filter((m) => m.text === 'exactly once')).toHaveLength(1);
    expect(t.agent.state.auditCalls.filter((a) => a.text === 'exactly once')).toHaveLength(1);
    expect(runIdsSeenByAgent(g.groupId)).toEqual(new Set([run.id]));
  });

  it('crash after the kick happened: resumed as kicked, the gateway sees one kick', async () => {
    const g = await agentGroup(true);
    await s.gw('POST', `/_control/groups/${g.gatewayGroupId}/external-join`, { platformUserId: 'pu_bad' });
    s.script(g.groupId, [
      { toolUse: { name: 'kick_user', input: { platform_user_id: 'pu_bad', reason: 'spam' } } },
      { toolUse: { name: 'finish', input: { summary: 'kicked' } } },
    ]);
    failpoints.arm('agent.before_tool_result', 1);
    await s.external(g.gatewayGroupId, 'pu_bad', 'spam spam');
    await waitFor(() => !t.gw.state.groups.get(g.gatewayGroupId)!.members.has('pu_bad'), { message: 'kicked' });
    await t.restart();
    const [run] = await s.settledRuns(g.groupId);
    expect(run).toMatchObject({ status: 'finished', endReason: 'final' });
    expect((await s.run(run.id)).steps[0]).toMatchObject({ name: 'kick_user', isError: false });
    expect(t.gw.state.calls.filter((c) => c.endpoint === 'kick' && c.groupId === g.gatewayGroupId)).toHaveLength(1);
  });

  it('crash before a turn: the turn is requested again under the same runId; steps stay contiguous', async () => {
    const g = await agentGroup();
    failpoints.arm('agent.before_turn', 1);
    await s.external(g.gatewayGroupId, 'pu_u', 'hello');
    const [run] = await s.settledRuns(g.groupId);
    expect(run).toMatchObject({ status: 'finished', endReason: 'final', stepCount: 3 });
    expect((await s.run(run.id)).steps.map((st: any) => st.seq)).toEqual([1, 2, 3]);
    expect(runIdsSeenByAgent(g.groupId)).toEqual(new Set([run.id]));
  });

  it('two server instances never run two agent runs for one group at once', async () => {
    const second = await Runtime.create({ ...t.ctx, config: { ...t.ctx.config, INSTANCE_ID: 'second' } });
    await second.start({ port: 0, host: '127.0.0.1' });
    try {
      const groups = [await agentGroup(), await agentGroup(), await agentGroup()];
      for (let i = 0; i < 4; i++) {
        for (const g of groups) await s.external(g.gatewayGroupId, `pu_${i}`, `msg ${i}`);
        await new Promise((r) => setTimeout(r, 60));
      }
      for (const g of groups) {
        await waitFor(
          async () => {
            const { rows } = await t.db.pool.query(
              `SELECT count(*) FILTER (WHERE status = 'running')::int AS running,
                      count(*)::int AS total,
                      (SELECT count(*)::int FROM agent_triggers WHERE group_id = $1 AND run_id IS NULL AND NOT discarded) AS pending
                 FROM agent_runs WHERE group_id = $1`,
              [g.groupId],
            );
            expect(rows[0].running).toBeLessThanOrEqual(1);
            return rows[0].running === 0 && rows[0].pending === 0 && rows[0].total > 0;
          },
          { timeout: 15_000, message: 'group runs settled' },
        );
        const runs = await s.runs(g.groupId);
        expect(runs.every((r) => r.status === 'finished')).toBe(true);
        const triggered = runs.flatMap((r) => r.triggerMessages.map((m: any) => m.text)).sort();
        expect(triggered).toEqual(['msg 0', 'msg 1', 'msg 2', 'msg 3']);
      }
    } finally {
      await second.stop();
    }
  });
});

describe('agent wall clock', () => {
  let t: TestRuntime;
  let s: Scenario;

  beforeAll(async () => {
    t = await createTestRuntime({ env: { AGENT_RUN_WALL_MS: '3000' } });
    s = await new Scenario(t).init();
  });
  afterAll(async () => {
    await t.close();
  });

  const slowTurns = (n: number, delayMs: number) =>
    Array.from({ length: n }, (_, i) => ({ delayMs, toolUse: { name: 'get_recent_messages', input: { limit: i + 1 } } }));

  it('ends with wall_clock once the time budget is used up', async () => {
    const g = await s.group('acc_03', ['acc_04']);
    await s.enableAgent(g.groupId);
    s.script(g.groupId, slowTurns(10, 700));
    const started = Date.now();
    await s.external(g.gatewayGroupId, 'pu_u', 'go');
    const [run] = await s.settledRuns(g.groupId);
    expect(run).toMatchObject({ status: 'failed', endReason: 'wall_clock' });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(run.stepCount).toBeLessThanOrEqual(5);
  });

  it('time spent waiting for audits counts; a tool whose audit runs out of time is not executed', async () => {
    const g = await s.group('acc_05', ['acc_06']);
    await s.enableAgent(g.groupId);
    s.audits([{ delayMs: 450, verdict: 'pass' }, { delayMs: 450, verdict: 'pass' }], g.groupId);
    s.script(g.groupId, [
      { delayMs: 1200, toolUse: { name: 'send_message', input: { text: 'in time', idempotency_key: '1' } } },
      { delayMs: 900, toolUse: { name: 'send_message', input: { text: 'too late', idempotency_key: '2' } } },
    ]);
    await s.external(g.gatewayGroupId, 'pu_u', 'go');
    const [run] = await s.settledRuns(g.groupId);
    expect(run).toMatchObject({ status: 'failed', endReason: 'wall_clock', stepCount: 2 });
    const texts = t.gw.state.groups.get(g.gatewayGroupId)!.messages.map((m) => m.text);
    expect(texts).toContain('in time');
    expect(texts).not.toContain('too late');
  });

  it('downtime is not counted: after a restart the run continues', async () => {
    const g = await s.group('acc_07', ['acc_08']);
    await s.enableAgent(g.groupId);
    s.script(g.groupId, slowTurns(10, 600));
    await s.external(g.gatewayGroupId, 'pu_u', 'go');
    const runId = await waitFor(async () => (await s.runs(g.groupId))[0]?.id);
    await waitFor(async () => (await s.run(runId)).stepCount >= 1);
    await t.stopServer();
    await new Promise((r) => setTimeout(r, 3500));
    const turnsBefore = t.agent.state.turnCalls.filter((c) => c.runId === runId).length;
    await t.startServer();
    const [run] = await s.settledRuns(g.groupId);
    expect(run.id).toBe(runId);
    expect(run.endReason).toBe('wall_clock');
    expect(t.agent.state.turnCalls.filter((c) => c.runId === runId).length).toBeGreaterThan(turnsBefore);
  });
});

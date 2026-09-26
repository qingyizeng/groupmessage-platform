import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildLlmAgent } from '@gmp/llm-agent';
import type { FastifyInstance } from 'fastify';
import { createTestRuntime, type TestRuntime } from './helpers/app';
import { Scenario } from './helpers/scenario';

/**
 * C2 compatibility: the platform talks to the Claude-backed agent service (with a stubbed Claude
 * client that answers like the model would, thinking blocks included) and the run completes.
 */
describe('platform ↔ llm-agent', () => {
  let t: TestRuntime;
  let s: Scenario;
  let llm: FastifyInstance;
  const calls: any[] = [];

  beforeAll(async () => {
    const script = [
      (id: string) => ({
        stop_reason: 'tool_use',
        content: [
          { type: 'thinking', thinking: '', signature: 's1' },
          { type: 'tool_use', id: `toolu_${id}_1`, name: 'get_recent_messages', input: { limit: 10 } },
        ],
      }),
      (id: string) => ({
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'Replying.' },
          { type: 'tool_use', id: `toolu_${id}_2`, name: 'send_message', input: { text: '您好，会议 10 点开始。', idempotency_key: 'reply-1' } },
        ],
      }),
      (id: string) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `toolu_${id}_3`, name: 'finish', input: { summary: 'answered' } }] }),
    ];
    let turn = 0;
    const client = {
      beta: {
        messages: {
          create: async (params: any) => {
            calls.push(params);
            if (params.output_config?.format) {
              return { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"verdict":"pass","reason":"fine"}' }] };
            }
            return script[turn++ % script.length]!(String(turn));
          },
        },
      },
    };
    llm = buildLlmAgent({ client: client as any, model: 'claude-opus-5', effort: 'low' });
    const llmUrl = await llm.listen({ port: 0, host: '127.0.0.1' });
    t = await createTestRuntime({ env: { AGENT_URL: llmUrl } });
    s = await new Scenario(t).init();
  });
  afterAll(async () => {
    await t.close();
    await llm.close();
  });

  it('runs a full agent run through the Claude adapter', async () => {
    const g = await s.group('acc_01', ['acc_02']);
    await s.enableAgent(g.groupId);
    await s.external(g.gatewayGroupId, 'pu_visitor', '几点开会？');
    const [run] = await s.settledRuns(g.groupId);
    expect(run).toMatchObject({ status: 'finished', endReason: 'final', summary: 'answered', stepCount: 3 });
    const { steps } = await s.run(run.id);
    expect(steps.map((st: any) => [st.kind, st.name, st.auditVerdict])).toEqual([
      ['tool_use', 'get_recent_messages', null],
      ['tool_use', 'send_message', 'pass'],
      ['final', 'finish', null],
    ]);
    // The thinking block of turn 1 went back to Claude on turn 2, unchanged.
    const turn2 = calls.filter((c) => !c.output_config?.format)[1];
    expect(turn2.messages[1].content.map((b: any) => b.type)).toEqual(['thinking', 'tool_use']);
    expect(t.gw.state.groups.get(g.gatewayGroupId)!.messages.some((m) => m.text === '您好，会议 10 点开始。')).toBe(true);
  });
});

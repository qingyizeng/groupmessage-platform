import { describe, expect, it } from 'vitest';
import { AssistantTurnCache, buildLlmAgent, toApiMessages, toPlatformTurn } from '../src/agent';

const schema = (props: string[]) => ({
  type: 'object',
  properties: Object.fromEntries(props.map((p) => [p, { type: 'string' }])),
  required: props,
});
const TOOLS = [
  { name: 'get_recent_messages', description: 'd', input_schema: schema(['limit']) },
  { name: 'send_message', description: 'd', input_schema: schema(['text', 'idempotency_key']) },
  { name: 'kick_user', description: 'd', input_schema: schema(['platform_user_id', 'reason']) },
  { name: 'finish', description: 'd', input_schema: schema(['summary']) },
];
const ctx = { role: 'user', content: [{ type: 'text', text: '{"groupId":"g","triggerMessages":[],"policy":{"autoKickEnabled":false},"ownPlatformUserIds":[]}' }] };

/** Stub of the SDK client: records requests and returns queued responses (or throws). */
function stubClient(responses: unknown[]) {
  const requests: any[] = [];
  const client = {
    beta: {
      messages: {
        create: async (params: unknown) => {
          requests.push(params);
          const next = responses.shift();
          if (next instanceof Error) throw next;
          return next;
        },
      },
    },
  };
  return { client: client as any, requests };
}

describe('llm-agent', () => {
  it('rejects tool lists that are not the four tools', async () => {
    const { client } = stubClient([]);
    const app = buildLlmAgent({ client, model: 'claude-opus-5', effort: 'low' });
    const res = await app.inject({ method: 'POST', url: '/agent/turn', payload: { runId: 'r', tools: TOOLS.slice(1), messages: [ctx] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('TOOLS_INVALID');
  });

  it('asks for at most one tool call and returns exactly the tool_use block', async () => {
    const { client, requests } = stubClient([
      {
        stop_reason: 'tool_use',
        content: [
          { type: 'thinking', thinking: '', signature: 'sig' },
          { type: 'text', text: 'Let me read first.' },
          { type: 'tool_use', id: 'toolu_1', name: 'get_recent_messages', input: { limit: 10 } },
        ],
      },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'All good.' }] },
    ]);
    const app = buildLlmAgent({ client, model: 'claude-opus-5', effort: 'low' });
    const first = await app.inject({ method: 'POST', url: '/agent/turn', payload: { runId: 'r', tools: TOOLS, messages: [ctx] } });
    expect(first.json()).toEqual({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_recent_messages', input: { limit: 10 } }],
    });
    expect(requests[0]).toMatchObject({
      model: 'claude-opus-5',
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      output_config: { effort: 'low' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    expect(requests[0].tools.map((t: any) => t.name)).toEqual(TOOLS.map((t) => t.name));

    // Next turn: the platform sends back only the tool_use block; the thinking block is restored.
    const history = [
      ctx,
      { role: 'assistant', content: [first.json().content[0]] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"messages":[]}' }] },
      { role: 'user', content: [{ type: 'text', text: 'PROTOCOL_ERROR BAD_JSON: ...' }] },
    ];
    const second = await app.inject({ method: 'POST', url: '/agent/turn', payload: { runId: 'r', tools: TOOLS, messages: history } });
    expect(second.json()).toEqual({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'All good.' }] });
    const sent = requests[1].messages;
    expect(sent.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(sent[1].content.map((b: any) => b.type)).toEqual(['thinking', 'text', 'tool_use']);
    expect(sent[2].content.map((b: any) => b.type)).toEqual(['tool_result', 'text']);
  });

  it('maps refusals and upstream errors to responses the platform understands', async () => {
    expect(toPlatformTurn({ stop_reason: 'refusal', content: [] } as any).content[0]).toMatchObject({ type: 'text' });
    const err = Object.assign(new Error('overloaded'), { status: 529 });
    const { client } = stubClient([err]);
    const app = buildLlmAgent({ client, model: 'm', effort: 'low' });
    const res = await app.inject({ method: 'POST', url: '/agent/turn', payload: { runId: 'r', tools: TOOLS, messages: [ctx] } });
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
  });

  it('audit returns the structured verdict; unparseable output is not a verdict', async () => {
    const { client, requests } = stubClient([
      { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"verdict":"fail","reason":"spam"}' }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] },
    ]);
    const app = buildLlmAgent({ client, model: 'm', effort: 'low' });
    const ok = await app.inject({ method: 'POST', url: '/agent/audit', payload: { text: 'buy now', groupId: 'g' } });
    expect(ok.json()).toEqual({ verdict: 'fail', reason: 'spam' });
    expect(requests[0].output_config.format).toMatchObject({ type: 'json_schema' });
    const bad = await app.inject({ method: 'POST', url: '/agent/audit', payload: { text: 'x', groupId: 'g' } });
    expect(bad.statusCode).toBe(503);
  });

  it('merges adjacent same-role messages and leaves uncached turns as they are', () => {
    const out = toApiMessages(
      [
        ctx as any,
        { role: 'assistant', content: [{ type: 'tool_use', id: 'unknown', name: 'finish', input: {} }] },
        { role: 'user', content: 'a' },
        { role: 'user', content: 'b' },
      ],
      new AssistantTurnCache(),
    );
    expect(out).toHaveLength(3);
    expect((out[1]!.content as any[])[0].id).toBe('unknown');
    expect((out[2]!.content as any[]).map((b) => b.text)).toEqual(['a', 'b']);
  });
});

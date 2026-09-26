import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildMockAgent, type MockAgent } from '../src/agent';

const schema = (props: string[]) => ({
  type: 'object',
  properties: Object.fromEntries(props.map((p) => [p, { type: 'string' }])),
  required: props,
});
const TOOLS = [
  { name: 'get_recent_messages', description: '', input_schema: schema(['limit']) },
  { name: 'send_message', description: '', input_schema: schema(['text', 'idempotency_key']) },
  { name: 'kick_user', description: '', input_schema: schema(['platform_user_id', 'reason']) },
  { name: 'finish', description: '', input_schema: schema(['summary']) },
];
const context = (text: string) => ({
  role: 'user',
  content: [
    {
      type: 'text',
      text: JSON.stringify({
        groupId: 'g1',
        triggerMessages: [{ msgId: 'm', senderPlatformUserId: 'pu', text, sentAt: '' }],
        policy: { autoKickEnabled: true },
        ownPlatformUserIds: [],
      }),
    },
  ],
});

describe('mock agent', () => {
  let a: MockAgent;
  let url: string;
  beforeAll(async () => {
    a = buildMockAgent();
    url = await a.app.listen({ port: 0, host: '127.0.0.1' });
  });
  afterAll(async () => {
    await a.app.close();
  });
  const turn = (body: unknown) =>
    fetch(`${url}/agent/turn`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('rejects tool lists that are not exactly the four tools with full `required`', async () => {
    const bad1 = await turn({ runId: 'r', tools: TOOLS.slice(0, 3), messages: [context('x')] });
    expect(bad1.status).toBe(400);
    const partial = TOOLS.map((t) => (t.name === 'send_message' ? { ...t, input_schema: { ...t.input_schema, required: ['text'] } } : t));
    expect((await turn({ runId: 'r', tools: partial, messages: [context('x')] })).status).toBe(400);
    expect((await turn({ runId: 'r', tools: TOOLS, messages: [context('x')] })).status).toBe(200);
  });

  it('default agent reads first, then kicks spam when allowed', async () => {
    const first = (await (await turn({ runId: 'r2', tools: TOOLS, messages: [context('买广告')] })).json()) as any;
    expect(first.content[0]).toMatchObject({ type: 'tool_use', name: 'get_recent_messages' });
    const messages = [
      context('买广告'),
      { role: 'assistant', content: first.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: first.content[0].id, content: '{"messages":[]}' }] },
    ];
    const second = (await (await turn({ runId: 'r2', tools: TOOLS, messages })).json()) as any;
    expect(second.content[0]).toMatchObject({ name: 'kick_user', input: { platform_user_id: 'pu' } });
  });
});

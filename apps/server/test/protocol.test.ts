import { describe, expect, it } from 'vitest';
import { parseTurnResponse, truncateRaw } from '../src/domain/agent/protocol';
import { TOOLS, validateToolInput } from '../src/domain/agent/tools';

const toolUse = { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'finish', input: { summary: 's' } }] };
const endTurn = { stop_reason: 'end_turn', content: [{ type: 'text', text: 'bye' }] };

describe('turn response validation', () => {
  it('accepts the two valid shapes', () => {
    expect(parseTurnResponse(200, JSON.stringify(toolUse))).toMatchObject({ ok: true, stopReason: 'tool_use' });
    expect(parseTurnResponse(200, JSON.stringify(endTurn))).toMatchObject({ ok: true, stopReason: 'end_turn' });
    expect(parseTurnResponse(200, `  ${JSON.stringify(endTurn)}\n`)).toMatchObject({ ok: true });
  });

  it.each([
    ['non-2xx', 500, JSON.stringify(endTurn)],
    ['not JSON', 200, 'hello'],
    ['markdown fence', 200, '```json\n' + JSON.stringify(endTurn) + '\n```'],
    ['text before', 200, 'Here you go: ' + JSON.stringify(endTurn)],
    ['text after', 200, JSON.stringify(endTurn) + ' thanks'],
    ['array', 200, '[]'],
    ['missing stop_reason', 200, JSON.stringify({ content: endTurn.content })],
    ['two blocks', 200, JSON.stringify({ ...endTurn, content: [...endTurn.content, ...endTurn.content] })],
    ['zero blocks', 200, JSON.stringify({ ...endTurn, content: [] })],
    ['tool_use with text block', 200, JSON.stringify({ stop_reason: 'tool_use', content: endTurn.content })],
    ['end_turn with tool block', 200, JSON.stringify({ stop_reason: 'end_turn', content: toolUse.content })],
    ['tool_use without id', 200, JSON.stringify({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'finish', input: {} }] })],
    ['input not an object', 200, JSON.stringify({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'x', name: 'finish', input: 'x' }] })],
  ])('rejects %s as BAD_JSON', (_label, status, raw) => {
    expect(parseTurnResponse(status as number, raw as string).ok).toBe(false);
  });

  it('truncates raw bodies to 2KB without splitting characters', () => {
    const raw = '汉'.repeat(1000);
    const cut = truncateRaw(raw)!;
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(2048);
    expect(cut).toBe('汉'.repeat(Math.floor(2048 / 3)));
  });
});

describe('tool definitions', () => {
  it('are exactly the four tools, each requiring all of its inputs', () => {
    expect(TOOLS.map((t) => t.name)).toEqual(['get_recent_messages', 'send_message', 'kick_user', 'finish']);
    for (const t of TOOLS) expect([...t.input_schema.required].sort()).toEqual(Object.keys(t.input_schema.properties).sort());
  });

  it('validates inputs against the schemas', () => {
    expect(validateToolInput('get_recent_messages', { limit: 100000 })).toBeNull();
    expect(validateToolInput('get_recent_messages', { limit: '10' })).not.toBeNull();
    expect(validateToolInput('send_message', { text: 'x' })).not.toBeNull();
    expect(validateToolInput('send_message', { text: 'x', idempotency_key: 'k', extra: 1 })).not.toBeNull();
    expect(validateToolInput('kick_user', { platform_user_id: 'p', reason: 'r' })).toBeNull();
  });
});

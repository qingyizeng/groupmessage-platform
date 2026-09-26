/**
 * Validation of /agent/turn responses (section 2.2). A response is valid only if the whole body is
 * a JSON object (no markdown fence, no surrounding text), has a stop_reason, exactly one content
 * block, and the block type matches the stop_reason.
 */

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface TextBlock {
  type: 'text';
  text: string;
}

export type TurnParse =
  | { ok: true; stopReason: 'tool_use'; block: ToolUseBlock }
  | { ok: true; stopReason: 'end_turn'; block: TextBlock }
  | { ok: false; reason: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseTurnResponse(status: number, raw: string): TurnParse {
  if (status < 200 || status >= 300) return { ok: false, reason: `agent responded with HTTP ${status}` };
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'response body is not valid JSON' };
  }
  if (!isObject(body)) return { ok: false, reason: 'response is not a JSON object' };
  const { stop_reason: stopReason, content } = body;
  if (stopReason !== 'tool_use' && stopReason !== 'end_turn') {
    return { ok: false, reason: 'stop_reason must be "tool_use" or "end_turn"' };
  }
  if (!Array.isArray(content) || content.length !== 1) {
    return { ok: false, reason: 'content must contain exactly one block' };
  }
  const block = content[0];
  if (!isObject(block)) return { ok: false, reason: 'content block is not an object' };
  if (stopReason === 'tool_use') {
    if (block.type !== 'tool_use') return { ok: false, reason: 'stop_reason tool_use requires a tool_use block' };
    if (typeof block.id !== 'string' || block.id.length === 0) return { ok: false, reason: 'tool_use.id missing' };
    if (typeof block.name !== 'string' || block.name.length === 0) return { ok: false, reason: 'tool_use.name missing' };
    if (!isObject(block.input)) return { ok: false, reason: 'tool_use.input must be an object' };
    return {
      ok: true,
      stopReason,
      block: { type: 'tool_use', id: block.id, name: block.name, input: block.input },
    };
  }
  if (block.type !== 'text') return { ok: false, reason: 'stop_reason end_turn requires a text block' };
  if (typeof block.text !== 'string') return { ok: false, reason: 'text block without text' };
  return { ok: true, stopReason, block: { type: 'text', text: block.text } };
}

const RAW_LIMIT = 2048;

/** Truncates to at most 2KB of UTF-8, never splitting a character. */
export function truncateRaw(raw: string | null): string | null {
  if (raw === null) return null;
  const bytes = Buffer.from(raw, 'utf8');
  if (bytes.length <= RAW_LIMIT) return raw;
  let end = RAW_LIMIT;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

export function truncateChars(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(0, max).join('');
}

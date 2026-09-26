import Fastify, { type FastifyInstance } from 'fastify';

/**
 * Simulation of the Agent service in section 2.2.
 *
 * - Scripted mode: POST /_control/scripts queues a list of turn responses (raw bodies, tool calls,
 *   end_turn, delays, hangs) for the next run matching a group. Used to reproduce misbehaviour.
 * - Default mode: a deterministic rule agent (read messages → reply or kick → finish).
 */

export const TOOL_NAMES = ['get_recent_messages', 'send_message', 'kick_user', 'finish'] as const;

export interface TurnStep {
  /** Response body sent verbatim (e.g. invalid JSON, JSON wrapped in a markdown fence). */
  raw?: string;
  /** HTTP status for `raw` (default 200). */
  status?: number;
  toolUse?: { name: string; input: unknown; id?: string };
  endTurn?: string;
  delayMs?: number;
  /** Never respond. */
  hang?: boolean;
}

export interface AuditStep {
  status?: number;
  raw?: string;
  verdict?: string;
  reason?: string;
  delayMs?: number;
  hang?: boolean;
}

interface Script {
  groupId?: string;
  turns: TurnStep[];
  runId?: string;
  next: number;
}

interface RunInfo {
  groupId: string | null;
  script?: Script;
  turns: number;
  toolUseSeq: number;
}

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

interface Message {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

export interface TriggerContext {
  groupId: string;
  triggerMessages: { msgId: string; senderPlatformUserId: string; text: string; sentAt: string }[];
  policy: { autoKickEnabled: boolean };
  ownPlatformUserIds: string[];
}

export class MockAgentState {
  scripts: Script[] = [];
  audits = new Map<string, AuditStep[]>();
  runs = new Map<string, RunInfo>();
  turnCalls: { runId: string; at: number; messages: Message[] }[] = [];
  auditCalls: { at: number; text: string; groupId: string }[] = [];

  reset() {
    this.scripts = [];
    this.audits.clear();
    this.runs.clear();
    this.turnCalls = [];
    this.auditCalls = [];
  }

  run(runId: string, messages: Message[]): RunInfo {
    let info = this.runs.get(runId);
    if (!info) {
      const ctx = parseContext(messages);
      info = { groupId: ctx?.groupId ?? null, turns: 0, toolUseSeq: 0 };
      const script = this.scripts.find((s) => !s.runId && (!s.groupId || s.groupId === info!.groupId));
      if (script) {
        script.runId = runId;
        info.script = script;
      }
      this.runs.set(runId, info);
    }
    return info;
  }

  takeAudit(groupId: string): AuditStep | undefined {
    for (const key of [groupId, '*']) {
      const q = this.audits.get(key);
      if (q && q.length > 0) return q.shift();
    }
    return undefined;
  }
}

export function parseContext(messages: Message[]): TriggerContext | null {
  try {
    return JSON.parse(messages[0]?.content[0]?.text ?? '') as TriggerContext;
  } catch {
    return null;
  }
}

function validTools(tools: unknown): boolean {
  if (!Array.isArray(tools) || tools.length !== TOOL_NAMES.length) return false;
  const names = new Set<string>();
  for (const t of tools) {
    const schema = t?.input_schema;
    if (typeof t?.name !== 'string' || !schema || schema.type !== 'object' || typeof schema.properties !== 'object') {
      return false;
    }
    const required: unknown = schema.required;
    if (!Array.isArray(required) || !Object.keys(schema.properties).every((k) => required.includes(k))) return false;
    names.add(t.name);
  }
  return TOOL_NAMES.every((n) => names.has(n));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The deterministic default agent. */
function defaultTurn(runId: string, info: RunInfo, messages: Message[]): object {
  const ctx = parseContext(messages);
  const toolUse = (name: string, input: object) => ({
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: `tu_${runId.slice(0, 8)}_${++info.toolUseSeq}`, name, input }],
  });
  const last = messages[messages.length - 1];
  if (messages.length === 1) return toolUse('get_recent_messages', { limit: 10 });

  const block = last?.content[0];
  if (last?.role === 'user' && block?.type === 'tool_result') {
    const call = messages
      .flatMap((m) => (m.role === 'assistant' ? m.content : []))
      .find((b) => b.type === 'tool_use' && b.id === block.tool_use_id);
    if (block.is_error) {
      let code = 'ERROR';
      try {
        code = JSON.parse(block.content ?? '{}').code ?? code;
      } catch {
        /* keep default */
      }
      return toolUse('finish', { summary: `stopped: ${call?.name} failed with ${code}` });
    }
    if (call?.name === 'get_recent_messages' && ctx) {
      const spam = ctx.triggerMessages.find((m) => /广告|spam/i.test(m.text));
      if (spam && ctx.policy.autoKickEnabled) {
        return toolUse('kick_user', { platform_user_id: spam.senderPlatformUserId, reason: 'spam' });
      }
      const lastText = ctx.triggerMessages[ctx.triggerMessages.length - 1]?.text ?? '';
      return toolUse('send_message', { text: `收到：${lastText}`.slice(0, 200), idempotency_key: `k-${runId}` });
    }
    return toolUse('finish', { summary: `done after ${call?.name ?? 'tool'}` });
  }
  return toolUse('finish', { summary: 'stopping after a protocol error' });
}

export interface MockAgent {
  app: FastifyInstance;
  state: MockAgentState;
}

export function buildMockAgent(opts: { logger?: boolean } = {}): MockAgent {
  const state = new MockAgentState();
  // forceCloseConnections: scripted hangs must not keep close() waiting forever.
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 10 * 1024 * 1024, forceCloseConnections: true });

  app.post<{ Body: { runId?: string; tools?: unknown; messages?: Message[] } }>('/agent/turn', async (req, reply) => {
    const { runId, tools, messages } = req.body ?? {};
    if (!runId || !Array.isArray(messages) || messages.length === 0) {
      return reply.status(400).send({ error: 'BAD_REQUEST' });
    }
    if (!validTools(tools)) return reply.status(400).send({ error: 'TOOLS_INVALID' });
    state.turnCalls.push({ runId, at: Date.now(), messages });
    const info = state.run(runId, messages);
    info.turns++;

    const step = info.script && info.script.next < info.script.turns.length ? info.script.turns[info.script.next++] : undefined;
    if (!step) return defaultTurn(runId, info, messages);
    if (step.delayMs) await sleep(step.delayMs);
    if (step.hang) {
      await new Promise(() => undefined);
    }
    if (step.raw !== undefined) {
      return reply.status(step.status ?? 200).type('application/json').send(step.raw);
    }
    if (step.toolUse) {
      const id = step.toolUse.id ?? `tu_${runId.slice(0, 8)}_${++info.toolUseSeq}`;
      return {
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id, name: step.toolUse.name, input: step.toolUse.input }],
      };
    }
    if (step.endTurn !== undefined) return { stop_reason: 'end_turn', content: [{ type: 'text', text: step.endTurn }] };
    return defaultTurn(runId, info, messages);
  });

  app.post<{ Body: { text?: string; groupId?: string } }>('/agent/audit', async (req, reply) => {
    const { text = '', groupId = '' } = req.body ?? {};
    state.auditCalls.push({ at: Date.now(), text, groupId });
    const step = state.takeAudit(groupId);
    if (!step) return { verdict: 'pass', reason: 'ok' };
    if (step.delayMs) await sleep(step.delayMs);
    if (step.hang) await new Promise(() => undefined);
    if (step.raw !== undefined) return reply.status(step.status ?? 200).type('application/json').send(step.raw);
    return reply.status(step.status ?? 200).send({ verdict: step.verdict ?? 'pass', reason: step.reason ?? 'scripted' });
  });

  app.post<{ Body: { groupId?: string; turns: TurnStep[] } }>('/_control/scripts', async (req) => {
    state.scripts.push({ groupId: req.body.groupId, turns: req.body.turns, next: 0 });
    return { ok: true };
  });

  app.post<{ Body: { groupId?: string; steps: AuditStep[] } }>('/_control/audits', async (req) => {
    const key = req.body.groupId ?? '*';
    state.audits.set(key, [...(state.audits.get(key) ?? []), ...req.body.steps]);
    return { ok: true };
  });

  app.post('/_control/reset', async () => {
    state.reset();
    return { ok: true };
  });

  app.get('/_control/state', async () => ({
    turnCalls: state.turnCalls.map((c) => ({ runId: c.runId, at: c.at, messageCount: c.messages.length })),
    auditCalls: state.auditCalls,
    pendingScripts: state.scripts.filter((s) => !s.runId).length,
  }));

  return { app, state };
}

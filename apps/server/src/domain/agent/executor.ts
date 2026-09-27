import type { Pool, PoolClient, Queryable } from '../../db/pool';
import { withTx } from '../../db/tx';
import { sleep } from '../../lib/async';
import { failpoints } from '../../lib/failpoints';
import type { Logger } from '../../lib/logger';
import { GatewayError, type GatewayClient } from '../../integrations/gatewayClient';
import { emitWs } from '../../realtime/outbox';
import { enterTerminal, terminalStatusForGatewayCode } from '../accounts/transitions';
import { enqueueOutbound, type MessageRow } from '../messages/outbound';
import type { AgentClient } from './agentClient';
import { parseTurnResponse, truncateChars, truncateRaw, type ToolUseBlock } from './protocol';
import { endRun, type EndReason, type RunRow } from './runRepo';
import { isKnownTool, TOOLS, validateToolInput, type ToolName } from './tools';

export interface AgentLimits {
  maxSteps: number;
  wallMs: number;
  turnTimeoutMs: number;
  auditTimeoutMs: number;
  auditAttempts: number;
  sendWaitMs: number;
  kickConvergeMs: number;
}

interface TranscriptMessage {
  role: 'user' | 'assistant';
  content: unknown[];
}

interface ToolCallRow {
  run_id: string;
  tool_use_id: string;
  step_seq: number;
  name: ToolName;
  input: Record<string, unknown>;
  phase: 'pending' | 'executing' | 'done';
  audit_attempts: number;
  audit_verdict: 'pass' | 'fail' | null;
  outbound_message_id: number | null;
  exec_account_id: string | null;
  exec_started_at: Date | null;
}

type ToolOutcome =
  | { kind: 'ok'; content: Record<string, unknown>; auditVerdict?: string | null }
  | { kind: 'error'; code: string; message: string; hint?: string; auditVerdict?: string | null }
  | { kind: 'blocked' }
  | { kind: 'wall_clock'; auditVerdict?: string | null };

const RESULT_LIMIT = 8 * 1024;
const SUMMARY_LIMIT = 200;
const MESSAGE_TEXT_LIMIT = 500;
const RECENT_LIMIT = 50;

export interface ExecutorDeps {
  pool: Pool;
  agent: AgentClient;
  gateway: GatewayClient;
  log: Logger;
  limits: AgentLimits;
  instanceId: string;
}

/**
 * Drives one agent run to its end. Each step is persisted in two transactions:
 *   T1 — the turn response is stored as a step (and, for a valid tool call, as a pending entry in
 *        agent_tool_calls) together with the transcript append;
 *   T2 — the tool result is appended and the entry is marked done.
 * On resume the executor first finishes any tool call that is not done, using its persisted
 * phase so that an effect that already happened (message enqueued, user kicked) is observed, not
 * repeated. A turn interrupted before T1 is simply requested again.
 */
export class RunExecutor {
  private transcript: TranscriptMessage[] = [];
  private readonly resumedAt = Date.now();
  private elapsedBase: number;
  private gatewayGroupId: string | null = null;

  constructor(
    private readonly deps: ExecutorDeps,
    private readonly run: RunRow,
    private readonly signal: AbortSignal,
  ) {
    this.elapsedBase = run.elapsed_ms;
  }

  elapsed(): number {
    return this.elapsedBase + (Date.now() - this.resumedAt);
  }

  private remaining(): number {
    return this.deps.limits.wallMs - this.elapsed();
  }

  async execute(): Promise<void> {
    const { pool } = this.deps;
    const { rows } = await pool.query<TranscriptMessage>(
      'SELECT role, content FROM agent_run_messages WHERE run_id = $1 ORDER BY idx',
      [this.run.id],
    );
    this.transcript = rows;
    const { rows: g } = await pool.query<{ gateway_group_id: string }>('SELECT gateway_group_id FROM groups WHERE id = $1', [
      this.run.group_id,
    ]);
    this.gatewayGroupId = g[0]?.gateway_group_id ?? null;

    while (!this.signal.aborted) {
      const pending = await this.pendingToolCall();
      if (pending) {
        if (await this.executeTool(pending)) return;
        continue;
      }
      const end = await this.checkEnd();
      if (end === 'gone') return;
      if (end) {
        await withTx(pool, (tx) => endRun(tx, this.run.id, end, { elapsedMs: this.elapsed() }));
        return;
      }
      if (await this.turn()) return;
    }
  }

  // ------------------------------------------------------------------ loop control

  private async checkEnd(): Promise<EndReason | 'gone' | null> {
    const { rows } = await this.deps.pool.query<{
      status: string;
      cancel_requested: boolean;
      step_count: number;
      consecutive_protocol_errors: number;
      agent_enabled: boolean;
      group_status: string;
    }>(
      `SELECT r.status, r.cancel_requested, r.step_count, r.consecutive_protocol_errors, g.agent_enabled, g.status AS group_status
         FROM agent_runs r JOIN groups g ON g.id = r.group_id WHERE r.id = $1`,
      [this.run.id],
    );
    const r = rows[0];
    if (!r || r.status !== 'running') return 'gone';
    if (r.cancel_requested || !r.agent_enabled || r.group_status !== 'active') return 'cancelled';
    if (r.consecutive_protocol_errors >= 3) return 'protocol_errors';
    if (r.step_count >= this.deps.limits.maxSteps) return 'budget_exhausted';
    if (this.remaining() <= 0) return 'wall_clock';
    return null;
  }

  private async pendingToolCall(): Promise<ToolCallRow | undefined> {
    const { rows } = await this.deps.pool.query<ToolCallRow>(
      `SELECT * FROM agent_tool_calls WHERE run_id = $1 AND phase <> 'done' ORDER BY step_seq LIMIT 1`,
      [this.run.id],
    );
    return rows[0];
  }

  // ------------------------------------------------------------------ T1: one /agent/turn round trip

  /** Returns true when the run ended. */
  private async turn(): Promise<boolean> {
    const { limits, agent } = this.deps;
    const remaining = this.remaining();
    const timeout = Math.min(limits.turnTimeoutMs, remaining);
    failpoints.hit('agent.before_turn');
    const out = await agent.turn({ runId: this.run.id, tools: TOOLS, messages: this.transcript }, timeout);
    if (this.signal.aborted) return true;
    // Ran out of wall-clock time while waiting: not a protocol error; the next check ends the run.
    if (out.kind === 'timeout' && timeout < limits.turnTimeoutMs) return false;

    if (out.kind === 'timeout') {
      return this.recordProtocolError('TURN_TIMEOUT', null, `No response within ${limits.turnTimeoutMs / 1000}s.`);
    }
    if (out.kind === 'unreachable') {
      return this.recordProtocolError('BAD_JSON', '', `The agent service could not be reached (${out.message}).`);
    }
    const parsed = parseTurnResponse(out.status, out.raw);
    if (!parsed.ok) {
      return this.recordProtocolError(
        'BAD_JSON',
        out.raw,
        `Your response was not one valid JSON object of the required shape (${parsed.reason}). ` +
          'Reply with a single JSON object with stop_reason and exactly one content block, and nothing else.',
      );
    }
    if (parsed.stopReason === 'end_turn') {
      return this.recordFinal(null, parsed.block.text, out.raw);
    }
    return this.recordToolUse(parsed.block, out.raw);
  }

  private async recordProtocolError(code: string, raw: string | null, sentence: string): Promise<boolean> {
    const text = `PROTOCOL_ERROR ${code}: ${sentence}`;
    await this.stepTx(async (tx, seq) => {
      await this.insertStep(tx, {
        seq,
        kind: 'protocol_error',
        isError: true,
        errorCode: code,
        resultSummary: truncateChars(sentence, SUMMARY_LIMIT),
        raw,
      });
      await this.append(tx, { role: 'user', content: [{ type: 'text', text }] });
      return { protocolError: true };
    });
    return false;
  }

  private async recordFinal(block: ToolUseBlock | null, text: string, raw: string): Promise<boolean> {
    await this.stepTx(async (tx, seq) => {
      await this.insertStep(tx, {
        seq,
        kind: 'final',
        toolUseId: block?.id ?? null,
        name: block?.name ?? null,
        input: block?.input ?? null,
        resultSummary: block ? '{"ok":true}' : truncateChars(text, SUMMARY_LIMIT),
        raw,
      });
      if (block) await this.append(tx, { role: 'assistant', content: [block] });
      await endRun(tx, this.run.id, 'final', { summary: text, elapsedMs: this.elapsed() });
      return { protocolError: false };
    });
    return true;
  }

  private async recordToolUse(block: ToolUseBlock, raw: string): Promise<boolean> {
    const { rowCount: dup } = await this.deps.pool.query(
      'SELECT 1 FROM agent_run_steps WHERE run_id = $1 AND tool_use_id = $2',
      [this.run.id, block.id],
    );
    if (dup) {
      return this.recordProtocolError(
        'DUPLICATE_TOOL_USE_ID',
        raw,
        `tool_use.id "${block.id}" was already used in this run; every tool call needs a new id.`,
      );
    }
    if (!isKnownTool(block.name)) {
      return this.recordRejectedToolUse(block, raw, 'UNKNOWN_TOOL', `Unknown tool "${block.name}".`, {
        hint: `Available tools: ${TOOLS.map((t) => t.name).join(', ')}.`,
      });
    }
    const invalid = validateToolInput(block.name, block.input);
    if (invalid) {
      return this.recordRejectedToolUse(block, raw, 'INVALID_INPUT', `Invalid input for ${block.name}: ${invalid}.`, {
        hint: 'Follow the input_schema of the tool exactly.',
      });
    }
    if (block.name === 'finish') {
      return this.recordFinal(block, String(block.input.summary ?? ''), raw);
    }
    await this.stepTx(async (tx, seq) => {
      await this.insertStep(tx, { seq, kind: 'tool_use', toolUseId: block.id, name: block.name, input: block.input, raw });
      await this.append(tx, { role: 'assistant', content: [block] });
      await tx.query(
        `INSERT INTO agent_tool_calls (run_id, tool_use_id, step_seq, name, input) VALUES ($1, $2, $3, $4, $5)`,
        [this.run.id, block.id, seq, block.name, JSON.stringify(block.input)],
      );
      return { protocolError: false };
    });
    return false;
  }

  /** Unknown tool / invalid input: the tool_use is appended, answered by an error tool_result. */
  private async recordRejectedToolUse(
    block: ToolUseBlock,
    raw: string,
    code: string,
    message: string,
    extra: { hint?: string },
  ): Promise<boolean> {
    const content = JSON.stringify({ code, message, ...extra });
    await this.stepTx(async (tx, seq) => {
      await this.insertStep(tx, {
        seq,
        kind: 'tool_use',
        toolUseId: block.id,
        name: block.name,
        input: block.input,
        isError: true,
        errorCode: code,
        resultSummary: truncateChars(message, SUMMARY_LIMIT),
        raw,
      });
      await this.append(tx, { role: 'assistant', content: [block] });
      await this.append(tx, { role: 'user', content: [{ type: 'tool_result', tool_use_id: block.id, content, is_error: true }] });
      return { protocolError: true };
    });
    return false;
  }

  /** Runs `fn` for the next step number and advances the counters in the same transaction. */
  private async stepTx(fn: (tx: PoolClient, seq: number) => Promise<{ protocolError: boolean }>): Promise<void> {
    const appended: TranscriptMessage[] = [];
    this.pendingAppends = appended;
    try {
      await withTx(this.deps.pool, async (tx) => {
        appended.length = 0;
        const { rows } = await tx.query<{ step_count: number; status: string }>(
          'SELECT step_count, status FROM agent_runs WHERE id = $1 FOR UPDATE',
          [this.run.id],
        );
        if (rows[0]?.status !== 'running') return;
        const seq = rows[0].step_count + 1;
        const { protocolError } = await fn(tx, seq);
        await tx.query(
          `UPDATE agent_runs SET step_count = $2,
                  consecutive_protocol_errors = CASE WHEN $3 THEN consecutive_protocol_errors + 1 ELSE 0 END,
                  elapsed_ms = GREATEST(elapsed_ms, $4), updated_at = now()
            WHERE id = $1`,
          [this.run.id, seq, protocolError, Math.round(this.elapsed())],
        );
        await emitWs(tx, 'agent_step', { runId: this.run.id, groupId: this.run.group_id, seq });
      });
      this.transcript.push(...appended);
    } finally {
      this.pendingAppends = null;
    }
  }

  private pendingAppends: TranscriptMessage[] | null = null;

  private async append(tx: Queryable, msg: TranscriptMessage): Promise<void> {
    const idx = this.transcript.length + (this.pendingAppends?.length ?? 0);
    await tx.query('INSERT INTO agent_run_messages (run_id, idx, role, content) VALUES ($1, $2, $3, $4)', [
      this.run.id,
      idx,
      msg.role,
      JSON.stringify(msg.content),
    ]);
    this.pendingAppends?.push(msg);
  }

  private async insertStep(
    tx: Queryable,
    s: {
      seq: number;
      kind: 'tool_use' | 'final' | 'protocol_error';
      toolUseId?: string | null;
      name?: string | null;
      input?: unknown;
      isError?: boolean;
      errorCode?: string | null;
      resultSummary?: string | null;
      raw: string | null;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO agent_run_steps (run_id, seq, kind, tool_use_id, name, input, is_error, error_code, result_summary, raw_response)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        this.run.id,
        s.seq,
        s.kind,
        s.toolUseId ?? null,
        s.name ?? null,
        s.input === undefined || s.input === null ? null : JSON.stringify(s.input),
        s.isError ?? false,
        s.errorCode ?? null,
        s.resultSummary ?? null,
        truncateRaw(s.raw),
      ],
    );
  }

  // ------------------------------------------------------------------ T2: tool execution

  /** Executes (or resumes) a tool call and records its result. Returns true when the run ended. */
  private async executeTool(call: ToolCallRow): Promise<boolean> {
    let outcome: ToolOutcome;
    switch (call.name) {
      case 'get_recent_messages':
        outcome = await this.recentMessages(call);
        break;
      case 'send_message':
        outcome = await this.sendMessage(call);
        break;
      case 'kick_user':
        outcome = await this.kickUser(call);
        break;
      default:
        outcome = { kind: 'error', code: 'UNKNOWN_TOOL', message: `Unknown tool ${call.name}` };
    }
    if (this.signal.aborted) return true;
    failpoints.hit('agent.before_tool_result');

    if (outcome.kind === 'blocked' || outcome.kind === 'wall_clock') {
      const blocked = outcome.kind === 'blocked';
      await withTx(this.deps.pool, async (tx) => {
        await tx.query(
          `UPDATE agent_run_steps SET is_error = true, error_code = $3, audit_verdict = $4, result_summary = $5, updated_at = now()
            WHERE run_id = $1 AND seq = $2`,
          [
            this.run.id,
            call.step_seq,
            blocked ? 'AUDIT_UNAVAILABLE' : 'WALL_CLOCK',
            outcome.kind === 'wall_clock' ? (outcome.auditVerdict ?? null) : 'unavailable',
            blocked
              ? `Audit gave no clear verdict after ${this.deps.limits.auditAttempts} attempts; tool not executed.`
              : 'Run time limit reached before the tool could run.',
          ],
        );
        await tx.query(`UPDATE agent_tool_calls SET phase = 'done' WHERE run_id = $1 AND tool_use_id = $2`, [
          this.run.id,
          call.tool_use_id,
        ]);
        await endRun(tx, this.run.id, blocked ? 'audit_blocked' : 'wall_clock', { elapsedMs: this.elapsed() });
      });
      return true;
    }

    const isError = outcome.kind === 'error';
    const payload =
      outcome.kind === 'ok'
        ? outcome.content
        : { code: outcome.code, message: outcome.message, ...(outcome.hint ? { hint: outcome.hint } : {}) };
    const content = boundContent(payload);
    const appended: TranscriptMessage = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: call.tool_use_id, content, ...(isError ? { is_error: true } : {}) }],
    };
    await withTx(this.deps.pool, async (tx) => {
      await tx.query('INSERT INTO agent_run_messages (run_id, idx, role, content) VALUES ($1, $2, $3, $4)', [
        this.run.id,
        this.transcript.length,
        appended.role,
        JSON.stringify(appended.content),
      ]);
      await tx.query(
        `UPDATE agent_run_steps SET result_summary = $3, is_error = $4, error_code = $5, audit_verdict = $6, updated_at = now()
          WHERE run_id = $1 AND seq = $2`,
        [
          this.run.id,
          call.step_seq,
          truncateChars(content, SUMMARY_LIMIT),
          isError,
          outcome.kind === 'error' ? outcome.code : null,
          outcome.auditVerdict ?? null,
        ],
      );
      await tx.query(`UPDATE agent_tool_calls SET phase = 'done', result = $3 WHERE run_id = $1 AND tool_use_id = $2`, [
        this.run.id,
        call.tool_use_id,
        content,
      ]);
      await tx.query('UPDATE agent_runs SET elapsed_ms = GREATEST(elapsed_ms, $2), updated_at = now() WHERE id = $1', [
        this.run.id,
        Math.round(this.elapsed()),
      ]);
      await emitWs(tx, 'agent_step', { runId: this.run.id, groupId: this.run.group_id, seq: call.step_seq });
      failpoints.hit('agent.tool_result_tx');
    });
    // Only after commit: withTx may run the callback more than once.
    this.transcript.push(appended);
    return false;
  }

  // ------------------------------------------------------------------ get_recent_messages

  private async recentMessages(call: ToolCallRow): Promise<ToolOutcome> {
    const repeats = await this.identicalPreviousCalls(call);
    if (repeats >= 2) {
      return {
        kind: 'error',
        code: 'INVALID_INPUT',
        message: 'The same get_recent_messages request was repeated three times in a row.',
        hint: 'Nothing new to read. Reply with send_message or end the run with finish.',
      };
    }
    const requested = Number(call.input.limit);
    const limit = Math.max(0, Math.min(RECENT_LIMIT, Math.floor(Number.isFinite(requested) ? requested : RECENT_LIMIT)));
    const { rows } = await this.deps.pool.query<MessageRow>(
      `SELECT * FROM messages WHERE group_id = $1 AND NOT echo_pending ORDER BY sort_ts DESC, id DESC LIMIT $2`,
      [this.run.group_id, limit],
    );
    let truncated = false;
    const messages = rows.reverse().map((m) => {
      const text = truncateChars(m.text, MESSAGE_TEXT_LIMIT);
      if (text !== m.text) truncated = true;
      return {
        msgId: m.msg_id,
        senderPlatformUserId: m.sender_platform_user_id,
        isOwn: m.is_own,
        text,
        sentAt: m.sort_ts.toISOString(),
      };
    });
    const content: Record<string, unknown> = { messages, truncated };
    if (repeats === 1) content.hint = 'Same request as your previous call; nothing else to read. Reply or finish.';
    while (Buffer.byteLength(JSON.stringify(content)) > RESULT_LIMIT && messages.length > 0) {
      messages.shift();
      content.truncated = true;
    }
    return { kind: 'ok', content };
  }

  /** How many immediately preceding steps were the same get_recent_messages call. */
  private async identicalPreviousCalls(call: ToolCallRow): Promise<number> {
    const { rows } = await this.deps.pool.query<{ kind: string; name: string | null; input: unknown }>(
      'SELECT kind, name, input FROM agent_run_steps WHERE run_id = $1 AND seq < $2 ORDER BY seq DESC LIMIT 5',
      [this.run.id, call.step_seq],
    );
    const key = JSON.stringify(call.input);
    let n = 0;
    for (const s of rows) {
      if (s.kind === 'tool_use' && s.name === 'get_recent_messages' && JSON.stringify(s.input) === key) n++;
      else break;
    }
    return n;
  }

  // ------------------------------------------------------------------ send_message

  private async sendMessage(call: ToolCallRow): Promise<ToolOutcome> {
    const text = String(call.input.text);
    const key = String(call.input.idempotency_key);

    // Same key already used in this run (by an earlier call, or by this one before a restart):
    // report that message's status; never audit or send again.
    const { rows: existing } = await this.deps.pool.query<{ id: number }>(
      'SELECT id FROM messages WHERE agent_run_id = $1 AND idempotency_key = $2',
      [this.run.id, key],
    );
    if (existing[0]) {
      const alreadyAudited = call.outbound_message_id === existing[0].id ? call.audit_verdict : null;
      return this.outboundOutcome(await this.waitOutbound(existing[0].id), alreadyAudited);
    }

    const verdict = await this.audit(call, text);
    if (verdict === 'blocked') return { kind: 'blocked' };
    if (verdict === 'wall_clock') return { kind: 'wall_clock', auditVerdict: null };
    if (verdict === 'fail') {
      return { kind: 'error', code: 'AUDIT_REJECTED', message: 'The audit rejected this message.', auditVerdict: 'fail' };
    }

    const enqueued = await withTx(this.deps.pool, async (tx) => {
      const { rows: group } = await tx.query<{ status: string }>('SELECT status FROM groups WHERE id = $1', [
        this.run.group_id,
      ]);
      if (group[0]?.status !== 'active') return { error: 'GROUP_UNREACHABLE' as const };
      // Lock the chosen account so a concurrent terminal transition cannot slip in between.
      const { rows: acc } = await tx.query<{ id: string; platform_user_id: string }>(
        `SELECT a.id, a.platform_user_id FROM group_members gm JOIN accounts a ON a.id = gm.account_id
          WHERE gm.group_id = $1 AND gm.present AND a.status = 'online'
          ORDER BY CASE gm.role WHEN 'member' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, a.id
          LIMIT 1 FOR SHARE OF a`,
        [this.run.group_id],
      );
      if (!acc[0]) return { error: 'NO_AVAILABLE_ACCOUNT' as const };
      const row = await enqueueOutbound(tx, {
        groupId: this.run.group_id,
        accountId: acc[0].id,
        senderPlatformUserId: acc[0].platform_user_id,
        text,
        source: 'agent',
        agentRunId: this.run.id,
        idempotencyKey: key,
      });
      await tx.query(
        `UPDATE agent_tool_calls SET phase = 'executing', outbound_message_id = $3, exec_account_id = $4, exec_started_at = now()
          WHERE run_id = $1 AND tool_use_id = $2`,
        [this.run.id, call.tool_use_id, row.id, acc[0].id],
      );
      return { id: row.id };
    });
    if ('error' in enqueued) {
      return enqueued.error === 'GROUP_UNREACHABLE'
        ? { kind: 'error', code: 'GROUP_UNREACHABLE', message: 'The group is not writable.', auditVerdict: 'pass' }
        : {
            kind: 'error',
            code: 'NO_AVAILABLE_ACCOUNT',
            message: 'No online service account is a member of this group.',
            auditVerdict: 'pass',
          };
    }
    failpoints.hit('agent.after_enqueue');
    return this.outboundOutcome(await this.waitOutbound(enqueued.id), 'pass');
  }

  /** Waits up to sendWaitMs (never past the run's wall-clock limit) for the message to be accepted, sent or to fail. */
  private async waitOutbound(messageId: number) {
    const deadline = Date.now() + Math.min(this.deps.limits.sendWaitMs, Math.max(0, this.remaining()));
    for (;;) {
      const { rows } = await this.deps.pool.query<{
        client_msg_id: string;
        delivery_status: string;
        fail_code: string | null;
      }>('SELECT client_msg_id, delivery_status, fail_code FROM messages WHERE id = $1', [messageId]);
      const m = rows[0]!;
      const settled = ['accepted', 'sent', 'failed', 'cancelled'].includes(m.delivery_status);
      if (settled || Date.now() >= deadline || this.signal.aborted) return m;
      await sleep(100, this.signal);
    }
  }

  private outboundOutcome(
    m: { client_msg_id: string; delivery_status: string; fail_code: string | null },
    auditVerdict: string | null,
  ): ToolOutcome {
    const base = { clientMsgId: m.client_msg_id, deliveryStatus: m.delivery_status };
    switch (m.delivery_status) {
      case 'accepted':
      case 'sent':
        return { kind: 'ok', content: base, auditVerdict };
      case 'failed':
      case 'cancelled':
        if (m.fail_code === 'GROUP_WRITE_FORBIDDEN' || m.fail_code === 'GROUP_UNREACHABLE') {
          return { kind: 'error', code: 'GROUP_UNREACHABLE', message: `Message ${m.delivery_status}: the group is not writable.`, auditVerdict };
        }
        return {
          kind: 'error',
          code: 'SEND_FAILED',
          message: `Message ${m.delivery_status} (${m.fail_code}).`,
          hint: 'The sending account is unavailable; retrying with the same idempotency_key returns this same result.',
          auditVerdict,
        };
      default:
        return {
          kind: 'error',
          code: 'SEND_TIMEOUT',
          message: `Delivery not confirmed within ${this.deps.limits.sendWaitMs / 1000}s (status ${m.delivery_status}); it may still be sent.`,
          hint: 'Call send_message again with the same idempotency_key to get its current status; do not use a new key.',
          auditVerdict,
        };
    }
  }

  // ------------------------------------------------------------------ kick_user

  private async kickUser(call: ToolCallRow): Promise<ToolOutcome> {
    const target = String(call.input.platform_user_id);
    const reason = String(call.input.reason);
    if (call.phase === 'executing' && call.exec_account_id) {
      return this.resumeKick(call, target);
    }
    const { rows: g } = await this.deps.pool.query<{ auto_kick_enabled: boolean }>(
      'SELECT auto_kick_enabled FROM groups WHERE id = $1',
      [this.run.group_id],
    );
    if (!g[0]?.auto_kick_enabled) {
      return { kind: 'error', code: 'POLICY_DENIED', message: 'Auto-kick is disabled for this group.' };
    }
    const accountId = await this.pickKickAccount();
    if (!accountId) {
      return { kind: 'error', code: 'NO_AVAILABLE_ACCOUNT', message: 'No online creator or admin account in this group.' };
    }
    const verdict = await this.audit(call, JSON.stringify({ action: 'kick', platform_user_id: target, reason }));
    if (verdict === 'blocked') return { kind: 'blocked' };
    if (verdict === 'wall_clock') return { kind: 'wall_clock', auditVerdict: null };
    if (verdict === 'fail') {
      return { kind: 'error', code: 'AUDIT_REJECTED', message: 'The audit rejected this kick.', auditVerdict: 'fail' };
    }
    await this.deps.pool.query(
      `UPDATE agent_tool_calls SET phase = 'executing', exec_account_id = $3, exec_started_at = now()
        WHERE run_id = $1 AND tool_use_id = $2`,
      [this.run.id, call.tool_use_id, accountId],
    );
    failpoints.hit('agent.before_kick');
    return this.performKick(accountId, target, 1);
  }

  private async pickKickAccount(): Promise<string | null> {
    const { rows } = await this.deps.pool.query<{ id: string }>(
      `SELECT a.id FROM group_members gm JOIN accounts a ON a.id = gm.account_id
        WHERE gm.group_id = $1 AND gm.present AND gm.role IN ('creator', 'admin') AND a.status = 'online'
        ORDER BY CASE gm.role WHEN 'creator' THEN 0 ELSE 1 END, a.id LIMIT 1`,
      [this.run.group_id],
    );
    return rows[0]?.id ?? null;
  }

  /** After a restart: the kick may already have happened. The member list converges within 2s. */
  private async resumeKick(call: ToolCallRow, target: string): Promise<ToolOutcome> {
    const since = call.exec_started_at ? Date.now() - call.exec_started_at.getTime() : 0;
    if (since < this.deps.limits.kickConvergeMs) await sleep(this.deps.limits.kickConvergeMs - since, this.signal);
    const present = await this.targetPresent(target);
    if (present === false) return { kind: 'ok', content: { kicked: true }, auditVerdict: 'pass' };
    return this.performKick(call.exec_account_id!, target, 1);
  }

  private async targetPresent(target: string): Promise<boolean | null> {
    try {
      const members = await this.deps.gateway.members(this.gatewayGroupId!);
      return members.some((m) => m.platformUserId === target);
    } catch {
      return null;
    }
  }

  private async performKick(accountId: string, target: string, attempt: number): Promise<ToolOutcome> {
    const ok: ToolOutcome = { kind: 'ok', content: { kicked: true }, auditVerdict: 'pass' };
    try {
      await this.deps.gateway.kick(this.gatewayGroupId!, accountId, target);
      return ok;
    } catch (err) {
      if (!(err instanceof GatewayError)) throw err;
      const fail = (code: string, message: string): ToolOutcome => ({ kind: 'error', code, message, auditVerdict: 'pass' });
      if (err.code === 'NOT_MEMBER') return { ...ok, content: { kicked: true, note: 'user was not a member any more' } };
      if (err.code === 'OWNER_LEFT') return fail('OWNER_LEFT', 'The group owner has left; nobody can kick any more.');
      if (err.code === 'NO_PERMISSION') return fail('NO_PERMISSION', 'The executing account may not kick in this group.');
      if (err.outcome === 'unknown' || err.unavailable) {
        await sleep(this.deps.limits.kickConvergeMs, this.signal);
        const present = await this.targetPresent(target);
        if (present === false) return ok;
        if (attempt < 2) return this.performKick(accountId, target, attempt + 1);
        return fail('SEND_TIMEOUT', 'Kick outcome could not be confirmed; the user is still listed as a member.');
      }
      const terminal = terminalStatusForGatewayCode(err.code);
      if (terminal) {
        await withTx(this.deps.pool, (tx) => enterTerminal(tx, accountId, terminal, 'gateway_error'));
        return fail('SEND_FAILED', `The executing account became ${terminal}.`);
      }
      if (err.code === 'ACCOUNT_OFFLINE') return fail('NO_AVAILABLE_ACCOUNT', 'The executing account is offline.');
      return fail('SEND_FAILED', `Kick failed: ${err.code}.`);
    }
  }

  // ------------------------------------------------------------------ audit

  /**
   * Up to `auditAttempts` tries per tool call; the count and a clear verdict are persisted, so a
   * restart neither repeats a decided audit nor grants extra attempts. Time spent counts towards
   * the wall-clock limit.
   */
  private async audit(call: ToolCallRow, text: string): Promise<'pass' | 'fail' | 'blocked' | 'wall_clock'> {
    if (call.audit_verdict) return call.audit_verdict;
    const { limits, agent, pool, log } = this.deps;
    let attempts = call.audit_attempts;
    while (attempts < limits.auditAttempts) {
      const remaining = this.remaining();
      if (remaining <= 0) return 'wall_clock';
      attempts++;
      await pool.query('UPDATE agent_tool_calls SET audit_attempts = $3 WHERE run_id = $1 AND tool_use_id = $2', [
        this.run.id,
        call.tool_use_id,
        attempts,
      ]);
      const { outcome, detail } = await agent.audit(text, this.run.group_id, Math.min(limits.auditTimeoutMs, remaining));
      if (this.signal.aborted) return 'wall_clock';
      if (outcome !== 'unclear') {
        await pool.query('UPDATE agent_tool_calls SET audit_verdict = $3 WHERE run_id = $1 AND tool_use_id = $2', [
          this.run.id,
          call.tool_use_id,
          outcome,
        ]);
        call.audit_verdict = outcome;
        return outcome;
      }
      log.warn({ runId: this.run.id, attempt: attempts, detail }, 'audit gave no clear verdict');
    }
    return this.remaining() <= 0 ? 'wall_clock' : 'blocked';
  }
}

/** Serializes a tool_result payload within 8KB; oversize content is cut and flagged truncated. */
function boundContent(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload);
  if (Buffer.byteLength(json) <= RESULT_LIMIT) return json;
  let partial = json.slice(0, RESULT_LIMIT - 64);
  while (Buffer.byteLength(JSON.stringify({ truncated: true, partial })) > RESULT_LIMIT) {
    partial = partial.slice(0, partial.length - 256);
  }
  return JSON.stringify({ truncated: true, partial });
}

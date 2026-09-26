import type { Queryable } from '../../db/pool';
import { pgCode } from '../../db/tx';
import { toIso } from '../../lib/time';
import { emitWs } from '../../realtime/outbox';
import type { MessageRow } from '../messages/outbound';

export const AGENT_CHANNEL = 'agent';

export type RunStatus = 'running' | 'finished' | 'failed' | 'blocked' | 'cancelled';
export type EndReason = 'final' | 'budget_exhausted' | 'wall_clock' | 'protocol_errors' | 'audit_blocked' | 'cancelled';

export interface RunRow {
  id: string;
  group_id: string;
  status: RunStatus;
  end_reason: EndReason | null;
  summary: string | null;
  trigger_messages: TriggerMessage[];
  step_count: number;
  consecutive_protocol_errors: number;
  elapsed_ms: number;
  cancel_requested: boolean;
  lease_owner: string | null;
  created_at: Date;
  finished_at: Date | null;
}

export interface TriggerMessage {
  msgId: string;
  senderPlatformUserId: string;
  text: string;
  sentAt: string;
}

export interface StepRow {
  seq: number;
  kind: 'tool_use' | 'final' | 'protocol_error';
  tool_use_id: string | null;
  name: string | null;
  input: unknown;
  result_summary: string | null;
  is_error: boolean;
  error_code: string | null;
  audit_verdict: string | null;
  raw_response: string | null;
  created_at: Date;
}

const STATUS_FOR: Record<EndReason, RunStatus> = {
  final: 'finished',
  budget_exhausted: 'failed',
  wall_clock: 'failed',
  protocol_errors: 'failed',
  audit_blocked: 'blocked',
  cancelled: 'cancelled',
};

// ------------------------------------------------------------------ triggers & hooks

/** Inbound-message hook: a non-own message in an agent-enabled, writable group becomes a trigger. */
export async function agentTriggerHook(tx: Queryable, row: MessageRow): Promise<void> {
  if (row.is_own) return;
  const { rows } = await tx.query<{ agent_enabled: boolean; status: string }>(
    'SELECT agent_enabled, status FROM groups WHERE id = $1',
    [row.group_id],
  );
  if (!rows[0]?.agent_enabled || rows[0].status !== 'active') return;
  await tx.query('INSERT INTO agent_triggers (message_id, group_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
    row.id,
    row.group_id,
  ]);
  await tx.query(`NOTIFY ${AGENT_CHANNEL}`);
}

/** Group became unreachable or its agent was switched off: stop after the current step, drop pending triggers. */
export async function stopAgentForGroup(tx: Queryable, groupId: string): Promise<void> {
  await tx.query(
    `UPDATE agent_runs SET cancel_requested = true, updated_at = now() WHERE group_id = $1 AND status = 'running'`,
    [groupId],
  );
  await tx.query(
    'UPDATE agent_triggers SET discarded = true WHERE group_id = $1 AND run_id IS NULL AND NOT discarded',
    [groupId],
  );
  await tx.query(`NOTIFY ${AGENT_CHANNEL}`);
}

export async function agentSettingsHook(tx: Queryable, groupId: string, changes: { agentEnabled?: boolean }) {
  if (changes.agentEnabled === false) await stopAgentForGroup(tx, groupId);
}

// ------------------------------------------------------------------ lifecycle

/**
 * Starts a run for the group if it has pending triggers and no running run. All pending triggers
 * go into this run. Safe under concurrency: the partial unique index lets only one running run
 * exist per group, and a losing attempt is rolled back to its savepoint.
 */
export async function maybeStartRun(tx: Queryable, groupId: string): Promise<string | null> {
  const { rows: g } = await tx.query<{ agent_enabled: boolean; status: string; auto_kick_enabled: boolean }>(
    'SELECT agent_enabled, status, auto_kick_enabled FROM groups WHERE id = $1',
    [groupId],
  );
  if (!g[0]?.agent_enabled || g[0].status !== 'active') return null;

  await tx.query('SAVEPOINT start_run');
  let runId: string;
  try {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO agent_runs (group_id, trigger_messages) VALUES ($1, '[]') RETURNING id`,
      [groupId],
    );
    runId = rows[0]!.id;
  } catch (err) {
    await tx.query('ROLLBACK TO SAVEPOINT start_run');
    if (pgCode(err) === '23505') return null;
    throw err;
  }
  const { rows: claimed } = await tx.query<{ message_id: number }>(
    `UPDATE agent_triggers SET run_id = $2
      WHERE group_id = $1 AND run_id IS NULL AND NOT discarded RETURNING message_id`,
    [groupId, runId],
  );
  if (claimed.length === 0) {
    await tx.query('ROLLBACK TO SAVEPOINT start_run');
    return null;
  }
  const { rows: msgs } = await tx.query<{ msg_id: string; sender_platform_user_id: string; text: string; sort_ts: Date }>(
    `SELECT msg_id, sender_platform_user_id, text, sort_ts FROM messages WHERE id = ANY($1) ORDER BY sort_ts, id`,
    [claimed.map((c) => c.message_id)],
  );
  const triggerMessages: TriggerMessage[] = msgs.map((m) => ({
    msgId: m.msg_id,
    senderPlatformUserId: m.sender_platform_user_id,
    text: m.text,
    sentAt: toIso(m.sort_ts)!,
  }));
  const { rows: own } = await tx.query<{ platform_user_id: string }>(
    `SELECT platform_user_id FROM group_members WHERE group_id = $1 AND present AND account_id IS NOT NULL ORDER BY platform_user_id`,
    [groupId],
  );
  const context = {
    groupId,
    triggerMessages,
    policy: { autoKickEnabled: g[0].auto_kick_enabled },
    ownPlatformUserIds: own.map((o) => o.platform_user_id),
  };
  await tx.query('UPDATE agent_runs SET trigger_messages = $2 WHERE id = $1', [runId, JSON.stringify(triggerMessages)]);
  await tx.query(`INSERT INTO agent_run_messages (run_id, idx, role, content) VALUES ($1, 0, 'user', $2)`, [
    runId,
    JSON.stringify([{ type: 'text', text: JSON.stringify(context) }]),
  ]);
  await tx.query('RELEASE SAVEPOINT start_run');
  await emitWs(tx, 'agent_run', { runId, groupId, status: 'running', endReason: null });
  await tx.query(`NOTIFY ${AGENT_CHANNEL}`);
  return runId;
}

/** Ends a running run and immediately starts the next one if messages arrived meanwhile. */
export async function endRun(
  tx: Queryable,
  runId: string,
  endReason: EndReason,
  opts: { summary?: string | null; elapsedMs?: number } = {},
): Promise<boolean> {
  const status = STATUS_FOR[endReason];
  const { rows } = await tx.query<{ group_id: string }>(
    `UPDATE agent_runs
        SET status = $2, end_reason = $3, summary = COALESCE($4, summary), elapsed_ms = COALESCE($5, elapsed_ms),
            finished_at = now(), updated_at = now(), lease_owner = NULL, lease_until = NULL
      WHERE id = $1 AND status = 'running'
      RETURNING group_id`,
    [runId, status, endReason, opts.summary ?? null, opts.elapsedMs ?? null],
  );
  const groupId = rows[0]?.group_id;
  if (!groupId) return false;
  await emitWs(tx, 'agent_run', { runId, groupId, status, endReason });
  await maybeStartRun(tx, groupId);
  return true;
}

// ------------------------------------------------------------------ read models

export interface StepDto {
  seq: number;
  kind: StepRow['kind'];
  toolUseId: string | null;
  name: string | null;
  input: unknown;
  resultSummary: string | null;
  isError: boolean;
  errorCode: string | null;
  auditVerdict: string | null;
  rawResponse: string | null;
  createdAt: string;
}

export interface RunDto {
  id: string;
  groupId: string;
  status: RunStatus;
  endReason: EndReason | null;
  summary: string | null;
  stepCount: number;
  triggerMessages: TriggerMessage[];
  createdAt: string;
  finishedAt: string | null;
  steps?: StepDto[];
}

export function toRunDto(r: RunRow, steps?: StepRow[]): RunDto {
  return {
    id: r.id,
    groupId: r.group_id,
    status: r.status,
    endReason: r.end_reason,
    summary: r.summary,
    stepCount: r.step_count,
    triggerMessages: r.trigger_messages,
    createdAt: toIso(r.created_at)!,
    finishedAt: toIso(r.finished_at),
    ...(steps
      ? {
          steps: steps.map((s) => ({
            seq: s.seq,
            kind: s.kind,
            toolUseId: s.tool_use_id,
            name: s.name,
            input: s.input,
            resultSummary: s.result_summary,
            isError: s.is_error,
            errorCode: s.error_code,
            auditVerdict: s.audit_verdict,
            rawResponse: s.raw_response,
            createdAt: toIso(s.created_at)!,
          })),
        }
      : {}),
  };
}

export async function activeAgentRuns(db: Queryable, groupIds: string[]): Promise<Map<string, string>> {
  const { rows } = await db.query<{ group_id: string; id: string }>(
    `SELECT group_id, id FROM agent_runs WHERE status = 'running' AND group_id = ANY($1)`,
    [groupIds],
  );
  return new Map(rows.map((r) => [r.group_id, r.id]));
}

import { resolveSequence, type SequenceStepDef } from '@gmp/shared';
import type { Queryable } from '../../db/pool';
import { withTx } from '../../db/tx';
import type { Pool } from '../../db/pool';
import { toIso } from '../../lib/time';
import { emitWs } from '../../realtime/outbox';
import { enqueueOutbound, type MessageRow } from '../messages/outbound';
import { cancelTask, scheduleTask, type Task } from '../tasks/scheduledTasks';

/**
 * Scheduled sequences (B1). Only the current step of a running sequence carries a schedule, kept
 * as a durable task; the next step is scheduled when the current one is sent (message_sent
 * received) or skipped. Step status follows the step's outbound message through an outbound hook,
 * atomically with the message change.
 */

export type RunStatus = 'running' | 'finished' | 'failed' | 'stopped';
export type StepStatus = 'pending' | 'accepted' | 'sent' | 'skipped' | 'failed';

interface RunRow {
  id: string;
  group_id: string;
  sequence_id: string;
  status: RunStatus;
  current_step_index: number | null;
  vars: Record<string, string>;
  step_vars: Record<string, Record<string, string>>;
  created_at: Date;
  finished_at: Date | null;
}

interface StepRow {
  id: number;
  run_id: string;
  index: number;
  status: StepStatus;
  account_role: 'admin' | 'member';
  text_template: string;
  text: string;
  delay_seconds: string;
  resolved_vars: Record<string, string>;
  var_sources: Record<string, string>;
  scheduled_at: Date | null;
  sent_at: Date | null;
  skipped_at: Date | null;
  account_id: string | null;
  client_msg_id: string | null;
  fail_code: string | null;
}

/** A step found this much later than its schedule was missed during downtime and is re-planned. */
export const OVERDUE_GRACE_MS = 2_000;

const delayMs = (s: StepRow) => Math.round(Number(s.delay_seconds) * 1000);

export type StartResult =
  | { ok: true; runId: string }
  | { ok: false; reason: 'unresolved'; stepIndex: number; key: string }
  | { ok: false; reason: 'already_running' };

/**
 * Preflight, then create the run with all steps resolved. Nothing is written when a placeholder
 * cannot be resolved; a concurrent start for the same group loses on the unique index.
 */
export async function startSequenceRun(
  pool: Pool,
  input: {
    groupId: string;
    sequenceId: string;
    steps: SequenceStepDef[];
    vars: Record<string, string>;
    stepVars: Record<string, Record<string, string>>;
  },
): Promise<StartResult> {
  const resolved = resolveSequence(input.steps, input.vars, input.stepVars);
  if (!resolved.ok) return { ok: false, reason: 'unresolved', stepIndex: resolved.stepIndex, key: resolved.key };
  try {
    const runId = await withTx(pool, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO sequence_runs (group_id, sequence_id, current_step_index, vars, step_vars)
         VALUES ($1, $2, 1, $3, $4) RETURNING id`,
        [input.groupId, input.sequenceId, JSON.stringify(input.vars), JSON.stringify(input.stepVars)],
      );
      const runId = rows[0]!.id;
      const defs = [...input.steps].sort((a, b) => a.index - b.index);
      for (const def of defs) {
        const r = resolved.steps.find((s) => s.index === def.index)!;
        await tx.query(
          `INSERT INTO sequence_run_steps
             (run_id, index, account_role, text_template, text, delay_seconds, resolved_vars, var_sources)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [runId, def.index, def.accountRole, def.text, r.text, def.delaySeconds, JSON.stringify(r.resolvedVars), JSON.stringify(r.varSources)],
        );
      }
      await scheduleStep(tx, runId, defs[0]!.index, Date.now() + defs[0]!.delaySeconds * 1000);
      await emitRun(tx, runId);
      return runId;
    });
    return { ok: true, runId };
  } catch (err) {
    if ((err as { code?: string }).code === '23505') return { ok: false, reason: 'already_running' };
    throw err;
  }
}

async function scheduleStep(tx: Queryable, runId: string, index: number, at: number): Promise<void> {
  const when = new Date(at);
  await tx.query('UPDATE sequence_run_steps SET scheduled_at = $3 WHERE run_id = $1 AND index = $2', [runId, index, when]);
  await tx.query('UPDATE sequence_runs SET current_step_index = $2, updated_at = now() WHERE id = $1', [runId, index]);
  await scheduleTask(tx, 'sequence_step', runId, when);
}

async function emitRun(tx: Queryable, runId: string): Promise<void> {
  const { rows } = await tx.query<{ group_id: string; status: string; current_step_index: number | null }>(
    'SELECT group_id, status, current_step_index FROM sequence_runs WHERE id = $1',
    [runId],
  );
  const r = rows[0]!;
  await emitWs(tx, 'sequence_run', { runId, groupId: r.group_id, status: r.status, currentStepIndex: r.current_step_index });
}

async function finishRun(tx: Queryable, runId: string, status: Exclude<RunStatus, 'running'>): Promise<void> {
  const { rowCount } = await tx.query(
    `UPDATE sequence_runs SET status = $2, finished_at = now(), updated_at = now() WHERE id = $1 AND status = 'running'`,
    [runId, status],
  );
  if (!rowCount) return;
  await cancelTask(tx, 'sequence_step', runId);
  await emitRun(tx, runId);
}

/** The current step is done (sent or skipped at `at`): schedule the next one, or finish. */
async function advance(tx: Queryable, runId: string, fromIndex: number, at: number): Promise<void> {
  const { rows } = await tx.query<StepRow>(
    'SELECT * FROM sequence_run_steps WHERE run_id = $1 AND index > $2 ORDER BY index LIMIT 1',
    [runId, fromIndex],
  );
  const next = rows[0];
  if (!next) return finishRun(tx, runId, 'finished');
  await scheduleStep(tx, runId, next.index, at + delayMs(next));
  await emitRun(tx, runId);
}

/**
 * Picks the sending account for a step. admin: creator/admin members, preferring admin; member:
 * members in accountId order. Online accounts first; a rate-limited account still counts (the
 * message waits in its queue), so the step is postponed rather than skipped.
 */
async function pickAccount(tx: Queryable, groupId: string, role: 'admin' | 'member') {
  const { rows } = await tx.query<{ id: string; platform_user_id: string; status: string }>(
    `SELECT a.id, a.platform_user_id, a.status
       FROM group_members gm JOIN accounts a ON a.id = gm.account_id
      WHERE gm.group_id = $1 AND gm.present AND a.status IN ('online', 'rate_limited')
        AND ($2 = 'admin' AND gm.role IN ('creator', 'admin') OR $2 = 'member' AND gm.role = 'member')
      ORDER BY CASE a.status WHEN 'online' THEN 0 ELSE 1 END,
               CASE gm.role WHEN 'admin' THEN 0 WHEN 'creator' THEN 1 ELSE 2 END,
               a.id
      LIMIT 1
      FOR SHARE OF a`,
    [groupId, role],
  );
  return rows[0];
}

/** Task handler: the current step is due. */
export async function runDueStep(pool: Pool, task: Task): Promise<void> {
  await withTx(pool, async (tx) => {
    const { rows: runs } = await tx.query<RunRow & { group_status: string }>(
      `SELECT r.*, g.status AS group_status FROM sequence_runs r JOIN groups g ON g.id = r.group_id
        WHERE r.id = $1 FOR UPDATE OF r`,
      [task.ref],
    );
    const run = runs[0];
    if (!run || run.status !== 'running' || run.current_step_index === null) return;
    if (run.group_status === 'unreachable') return finishRun(tx, run.id, 'stopped');

    const { rows: steps } = await tx.query<StepRow>(
      'SELECT * FROM sequence_run_steps WHERE run_id = $1 AND index = $2 FOR UPDATE',
      [run.id, run.current_step_index],
    );
    const step = steps[0];
    if (!step || step.status !== 'pending' || step.client_msg_id || !step.scheduled_at) return;

    const now = Date.now();
    const due = step.scheduled_at.getTime();
    if (due > now) {
      await scheduleTask(tx, 'sequence_step', run.id, step.scheduled_at);
      return;
    }
    // Missed while the service was down: re-plan from now instead of firing late (and never
    // firing several overdue steps at once — later steps are only scheduled after this one).
    if (now - due > OVERDUE_GRACE_MS) {
      await scheduleStep(tx, run.id, step.index, now + delayMs(step));
      await emitRun(tx, run.id);
      return;
    }

    const account = await pickAccount(tx, run.group_id, step.account_role);
    if (!account) {
      await tx.query(
        `UPDATE sequence_run_steps SET status = 'skipped', skipped_at = now(), sent_at = now() WHERE id = $1`,
        [step.id],
      );
      await advance(tx, run.id, step.index, now);
      return;
    }
    const msg = await enqueueOutbound(tx, {
      groupId: run.group_id,
      accountId: account.id,
      senderPlatformUserId: account.platform_user_id,
      text: step.text,
      source: 'sequence',
      sequenceRunStepId: step.id,
    });
    await tx.query('UPDATE sequence_run_steps SET account_id = $2, client_msg_id = $3, message_id = $4 WHERE id = $1', [
      step.id,
      account.id,
      msg.client_msg_id,
      msg.id,
    ]);
    await emitRun(tx, run.id);
  });
}

/**
 * Outbound hook: mirrors the step's message status onto the step, in the message's transaction.
 * sent → step sent (sentAt = when message_sent was received), next step scheduled;
 * cancelled because the account became terminal → step skipped, next step scheduled;
 * failed → step failed and the run fails (for GROUP_WRITE_FORBIDDEN the unreachable hook stops it).
 */
export async function sequenceOutboundHook(tx: Queryable, before: MessageRow, after: MessageRow): Promise<void> {
  if (!after.sequence_run_step_id || before.phase === after.phase) return;
  // Same lock order as runDueStep (run, then step), so the two never deadlock.
  await tx.query(
    'SELECT 1 FROM sequence_runs WHERE id = (SELECT run_id FROM sequence_run_steps WHERE id = $1) FOR UPDATE',
    [after.sequence_run_step_id],
  );
  const { rows } = await tx.query<StepRow & { run_status: string; group_status: string }>(
    `SELECT s.*, r.status AS run_status, g.status AS group_status
       FROM sequence_run_steps s JOIN sequence_runs r ON r.id = s.run_id JOIN groups g ON g.id = r.group_id
      WHERE s.id = $1 FOR UPDATE OF s`,
    [after.sequence_run_step_id],
  );
  const step = rows[0];
  if (!step || step.status === 'sent' || step.status === 'skipped' || step.status === 'failed') return;
  const now = Date.now();

  switch (after.phase) {
    case 'accepted':
      await tx.query(`UPDATE sequence_run_steps SET status = 'accepted' WHERE id = $1 AND status = 'pending'`, [step.id]);
      await emitRun(tx, step.run_id);
      return;
    case 'sent':
      await tx.query(`UPDATE sequence_run_steps SET status = 'sent', sent_at = $2 WHERE id = $1`, [step.id, new Date(now)]);
      if (step.run_status === 'running') await advance(tx, step.run_id, step.index, now);
      else await emitRun(tx, step.run_id);
      return;
    case 'cancelled':
      await tx.query(
        `UPDATE sequence_run_steps SET status = 'skipped', skipped_at = now(), sent_at = now(), fail_code = $2 WHERE id = $1`,
        [step.id, after.fail_code],
      );
      if (step.run_status === 'running' && step.group_status === 'active') await advance(tx, step.run_id, step.index, now);
      else await emitRun(tx, step.run_id);
      return;
    case 'failed':
      await tx.query(`UPDATE sequence_run_steps SET status = 'failed', fail_code = $2 WHERE id = $1`, [step.id, after.fail_code]);
      if (after.fail_code !== 'GROUP_WRITE_FORBIDDEN' && step.group_status === 'active') {
        await finishRun(tx, step.run_id, 'failed');
      } else {
        await emitRun(tx, step.run_id);
      }
      return;
    default:
      return;
  }
}

/** Group became unreachable: its running sequence stops. */
export async function stopSequencesForGroup(tx: Queryable, groupId: string): Promise<void> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM sequence_runs WHERE group_id = $1 AND status = 'running' FOR UPDATE`,
    [groupId],
  );
  for (const r of rows) await finishRun(tx, r.id, 'stopped');
}

// ------------------------------------------------------------------ read models

export interface SequenceRunDto {
  id: string;
  groupId: string;
  sequenceId: string;
  status: RunStatus;
  currentStepIndex: number | null;
  vars: Record<string, string>;
  stepVars: Record<string, Record<string, string>>;
  createdAt: string;
  finishedAt: string | null;
  steps?: {
    index: number;
    status: StepStatus;
    accountRole: string;
    text: string;
    delaySeconds: number;
    scheduledAt: string | null;
    sentAt: string | null;
    skippedAt: string | null;
    accountId: string | null;
    clientMsgId: string | null;
    failCode: string | null;
    resolvedVars: Record<string, string>;
    varSources: Record<string, string>;
  }[];
}

export async function loadSequenceRun(db: Queryable, runId: string, withSteps: boolean): Promise<SequenceRunDto | null> {
  const { rows } = await db.query<RunRow>('SELECT * FROM sequence_runs WHERE id = $1', [runId]);
  const r = rows[0];
  if (!r) return null;
  return toRunDto(r, withSteps ? await loadSteps(db, runId) : undefined);
}

async function loadSteps(db: Queryable, runId: string): Promise<StepRow[]> {
  const { rows } = await db.query<StepRow>('SELECT * FROM sequence_run_steps WHERE run_id = $1 ORDER BY index', [runId]);
  return rows;
}

export async function listSequenceRuns(db: Queryable, groupId: string, limit: number): Promise<SequenceRunDto[]> {
  const { rows } = await db.query<RunRow>(
    'SELECT * FROM sequence_runs WHERE group_id = $1 ORDER BY created_at DESC, id LIMIT $2',
    [groupId, limit],
  );
  return rows.map((r) => toRunDto(r));
}

function toRunDto(r: RunRow, steps?: StepRow[]): SequenceRunDto {
  return {
    id: r.id,
    groupId: r.group_id,
    sequenceId: r.sequence_id,
    status: r.status,
    currentStepIndex: r.current_step_index,
    vars: r.vars,
    stepVars: r.step_vars,
    createdAt: toIso(r.created_at)!,
    finishedAt: toIso(r.finished_at),
    ...(steps
      ? {
          steps: steps.map((s) => ({
            index: s.index,
            status: s.status,
            accountRole: s.account_role,
            text: s.text,
            delaySeconds: Number(s.delay_seconds),
            scheduledAt: toIso(s.scheduled_at),
            sentAt: toIso(s.sent_at),
            skippedAt: toIso(s.skipped_at),
            accountId: s.account_id,
            clientMsgId: s.client_msg_id,
            failCode: s.fail_code,
            resolvedVars: s.resolved_vars,
            varSources: s.var_sources,
          })),
        }
      : {}),
  };
}

export async function activeSequenceRuns(db: Queryable, groupIds: string[]): Promise<Map<string, string>> {
  const { rows } = await db.query<{ group_id: string; id: string }>(
    `SELECT group_id, id FROM sequence_runs WHERE status = 'running' AND group_id = ANY($1)`,
    [groupIds],
  );
  return new Map(rows.map((r) => [r.group_id, r.id]));
}


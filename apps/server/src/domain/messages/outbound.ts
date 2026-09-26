import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/pool';
import { toIso } from '../../lib/time';
import { emitWs } from '../../realtime/outbox';

export const OUTBOUND_CHANNEL = 'outbound';
export const OUTBOUND_STATUS_CHANNEL = 'outbound_status';

export type Phase = 'queued' | 'dispatching' | 'accepted' | 'unknown' | 'resending' | 'sent' | 'failed' | 'cancelled';
export type DeliveryStatus = 'queued' | 'accepted' | 'sent' | 'failed' | 'unknown' | 'cancelled';

export interface MessageRow {
  id: number;
  group_id: string;
  msg_id: string | null;
  client_msg_id: string | null;
  is_own: boolean;
  echo_pending: boolean;
  sender_platform_user_id: string | null;
  account_id: string | null;
  text: string;
  media_url: string | null;
  local_file_path: string | null;
  media_status: 'pending' | 'downloaded' | 'expired' | 'failed' | 'deleted' | null;
  created_at: Date;
  sent_at: Date | null;
  sort_ts: Date;
  phase: Phase | null;
  delivery_status: DeliveryStatus | null;
  fail_code: string | null;
  attempt: number;
  dispatch_started_at: Date | null;
  unknown_since: Date | null;
  confirm_after: Date | null;
  next_attempt_at: Date | null;
  lease_owner: string | null;
  lease_until: Date | null;
  source: 'operator' | 'agent' | 'sequence' | null;
  agent_run_id: string | null;
  idempotency_key: string | null;
  sequence_run_step_id: number | null;
}

export interface MessageDto {
  id: number;
  msgId: string | null;
  clientMsgId: string | null;
  senderPlatformUserId: string | null;
  accountId: string | null;
  isOwn: boolean;
  text: string;
  sentAt: string;
  deliveryStatus: DeliveryStatus | null;
  failCode: string | null;
  mediaUrl: string | null;
  /** Local copy of the media (C1): pending | downloaded | expired | failed | deleted, or null without media. */
  mediaStatus: MessageRow['media_status'];
  source: string | null;
}

export function toMessageDto(r: MessageRow): MessageDto {
  return {
    id: r.id,
    msgId: r.msg_id,
    clientMsgId: r.client_msg_id,
    senderPlatformUserId: r.sender_platform_user_id,
    accountId: r.account_id,
    isOwn: r.is_own,
    text: r.text,
    sentAt: toIso(r.sort_ts)!,
    deliveryStatus: r.is_own ? (r.delivery_status ?? 'sent') : null,
    failCode: r.fail_code,
    mediaUrl: r.media_url,
    mediaStatus: r.media_status,
    source: r.source,
  };
}

export async function emitMessageEvent(tx: Queryable, row: MessageRow, extra: { replacesId?: number } = {}) {
  await emitWs(tx, 'message', {
    groupId: row.group_id,
    msgId: row.msg_id,
    isOwn: row.is_own,
    message: toMessageDto(row),
    ...(extra.replacesId ? { replacesId: extra.replacesId } : {}),
  });
}

/**
 * Called inside the transaction of every outbound status change, after the row is updated.
 * Other modules (sequences, agent runs) register here to react atomically with the change.
 */
export type OutboundHook = (tx: Queryable, before: MessageRow, after: MessageRow) => Promise<void>;
const hooks: OutboundHook[] = [];
export function registerOutboundHook(hook: OutboundHook): void {
  if (!hooks.includes(hook)) hooks.push(hook);
}

export interface EnqueueInput {
  groupId: string;
  accountId: string;
  senderPlatformUserId: string | null;
  text: string;
  source: 'operator' | 'agent' | 'sequence';
  agentRunId?: string;
  idempotencyKey?: string;
  sequenceRunStepId?: number;
}

/** Records a new outbound message as `queued`. Nothing is sent to the gateway before this commits. */
export async function enqueueOutbound(tx: Queryable, input: EnqueueInput): Promise<MessageRow> {
  const now = new Date();
  const { rows } = await tx.query<MessageRow>(
    `INSERT INTO messages (group_id, client_msg_id, is_own, sender_platform_user_id, account_id, text,
                           created_at, sort_ts, phase, source, agent_run_id, idempotency_key, sequence_run_step_id)
     VALUES ($1, $2, true, $3, $4, $5, $6, $6, 'queued', $7, $8, $9, $10)
     RETURNING *`,
    [
      input.groupId,
      randomUUID(),
      input.senderPlatformUserId,
      input.accountId,
      input.text,
      now,
      input.source,
      input.agentRunId ?? null,
      input.idempotencyKey ?? null,
      input.sequenceRunStepId ?? null,
    ],
  );
  const row = rows[0]!;
  await emitMessageEvent(tx, row);
  await tx.query(`NOTIFY ${OUTBOUND_CHANNEL}`);
  return row;
}

const PATCHABLE = [
  'phase',
  'fail_code',
  'msg_id',
  'sent_at',
  'attempt',
  'dispatch_started_at',
  'unknown_since',
  'confirm_after',
  'next_attempt_at',
  'lease_owner',
  'lease_until',
  'media_url',
] as const;

export type OutboundPatch = Partial<Pick<MessageRow, (typeof PATCHABLE)[number]>>;

/**
 * The single place where an outbound message changes. Pushes the change to clients, notifies
 * waiters and runs registered hooks, all inside the caller's transaction. Mutates `row` in place.
 */
export async function updateOutbound(
  tx: Queryable,
  row: MessageRow,
  patch: OutboundPatch,
  opts: { replacesId?: number } = {},
): Promise<MessageRow> {
  const keys = PATCHABLE.filter((k) => patch[k] !== undefined);
  const values = keys.map((k) => patch[k]);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`);
  if (patch.sent_at !== undefined) sets.push(`sort_ts = COALESCE($${keys.indexOf('sent_at') + 2}, created_at)`);
  sets.push('updated_at = now()');
  const { rows } = await tx.query<MessageRow>(`UPDATE messages SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, [
    row.id,
    ...values,
  ]);
  const before = { ...row };
  const after = rows[0]!;
  Object.assign(row, after);

  const visibleChange =
    before.phase !== after.phase ||
    before.msg_id !== after.msg_id ||
    before.fail_code !== after.fail_code ||
    before.sort_ts.getTime() !== after.sort_ts.getTime();
  if (visibleChange) {
    await emitMessageEvent(tx, after, opts);
    await tx.query('SELECT pg_notify($1, $2)', [OUTBOUND_STATUS_CHANNEL, String(after.id)]);
    for (const hook of hooks) await hook(tx, before, after);
  }
  return after;
}

/** Serializes the two handlers that can race on one gateway message: its echo and its message_sent. */
export async function lockGatewayMessage(tx: Queryable, gatewayGroupId: string, msgId: string): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`msg:${gatewayGroupId}:${msgId}`]);
}

/**
 * Marks an outbound message as sent (from message_sent or a by-client-id lookup). If the gateway's
 * echo of it was already stored as a separate row, that row is merged in and removed.
 * `row` must be locked by the caller.
 */
export async function markSent(
  tx: Queryable,
  row: MessageRow,
  gatewayGroupId: string,
  msgId: string,
  sentAt: Date,
): Promise<'updated' | 'duplicate' | 'conflict'> {
  if (row.phase === 'sent') {
    if (row.msg_id === msgId) return 'duplicate';
    await emitWs(tx, 'inconsistency', {
      kind: 'duplicate_delivery',
      ref: `message:${row.id}`,
      message: `clientMsgId ${row.client_msg_id} was delivered as both ${row.msg_id} and ${msgId}`,
    });
    return 'conflict';
  }
  await lockGatewayMessage(tx, gatewayGroupId, msgId);
  const { rows: removed } = await tx.query<{ id: number; echo_pending: boolean; media_url: string | null }>(
    `DELETE FROM messages WHERE group_id = $1 AND msg_id = $2 AND client_msg_id IS NULL
     RETURNING id, echo_pending, media_url`,
    [row.group_id, msgId],
  );
  const echo = removed[0];
  await updateOutbound(
    tx,
    row,
    {
      phase: 'sent',
      msg_id: msgId,
      sent_at: sentAt,
      fail_code: null,
      lease_owner: null,
      lease_until: null,
      media_url: echo?.media_url ?? undefined,
    },
    { replacesId: echo && !echo.echo_pending ? echo.id : undefined },
  );
  return 'updated';
}

/** Cancels queued (never dispatched) messages matching the filter. */
export async function cancelQueued(
  tx: Queryable,
  filter: { accountId: string } | { groupId: string },
  failCode: string,
): Promise<number> {
  const [col, val] = 'accountId' in filter ? ['account_id', filter.accountId] : ['group_id', filter.groupId];
  const { rows } = await tx.query<MessageRow>(
    `SELECT * FROM messages WHERE ${col} = $1 AND phase = 'queued' ORDER BY id FOR UPDATE`,
    [val],
  );
  for (const r of rows) {
    await updateOutbound(tx, r, { phase: 'cancelled', fail_code: failCode, lease_owner: null, lease_until: null });
  }
  return rows.length;
}

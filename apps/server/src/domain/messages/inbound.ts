import type { Queryable } from '../../db/pool';
import type { Logger } from '../../lib/logger';
import { MalformedEventError } from '../../events/inboxProcessor';
import { enterTerminal } from '../accounts/transitions';
import { findGroupByGatewayId, markGroupUnreachable } from '../groups/groupRepo';
import { emitMessageEvent, lockGatewayMessage, markSent, updateOutbound, type MessageRow } from './outbound';
import { queueMediaDownload } from '../media/mediaService';

const reqStr = (v: unknown, field: string): string => {
  if (typeof v !== 'string' || v.length === 0) throw new MalformedEventError(`event field ${field} missing`);
  return v;
};

const reqDate = (v: unknown, field: string): Date => {
  const d = new Date(reqStr(v, field));
  if (Number.isNaN(d.getTime())) throw new MalformedEventError(`event field ${field} is not a timestamp`);
  return d;
};

export type InboundMessageHook = (tx: Queryable, row: MessageRow) => Promise<void>;
const inboundHooks: InboundMessageHook[] = [];
/** Runs for every newly stored message from someone other than our own accounts. */
export function registerInboundMessageHook(hook: InboundMessageHook): void {
  if (!inboundHooks.includes(hook)) inboundHooks.push(hook);
}

/**
 * `message` event. Deduplicated by (group, msgId). A message from one of our own accounts that has
 * not been matched to its outbound row yet is stored hidden (echo_pending) and merged by message_sent.
 */
export async function onMessageEvent(tx: Queryable, data: Record<string, unknown>, log: Logger): Promise<void> {
  const gatewayGroupId = reqStr(data.groupId, 'groupId');
  const msgId = reqStr(data.msgId, 'msgId');
  const sender = reqStr(data.senderPlatformUserId, 'senderPlatformUserId');
  const text = typeof data.text === 'string' ? data.text : '';
  const sentAt = reqDate(data.sentAt, 'sentAt');
  const mediaUrl = typeof data.mediaUrl === 'string' ? data.mediaUrl : null;

  const group = await findGroupByGatewayId(tx, gatewayGroupId);
  if (!group) {
    log.debug({ gatewayGroupId, msgId }, 'message for a group we do not manage');
    return;
  }
  await lockGatewayMessage(tx, gatewayGroupId, msgId);
  const existing = await tx.query('SELECT 1 FROM messages WHERE group_id = $1 AND msg_id = $2', [group.id, msgId]);
  if (existing.rowCount) return;

  const { rows: own } = await tx.query<{ id: string }>('SELECT id FROM accounts WHERE platform_user_id = $1', [sender]);
  const ownAccount = own[0]?.id ?? null;
  const { rows } = await tx.query<MessageRow>(
    `INSERT INTO messages (group_id, msg_id, is_own, echo_pending, sender_platform_user_id, account_id, text,
                           media_url, created_at, sent_at, sort_ts, phase)
     VALUES ($1, $2, $3, $3, $4, $5, $6, $7, now(), $8, $8, $9)
     RETURNING *`,
    [group.id, msgId, ownAccount !== null, sender, ownAccount, text, mediaUrl, sentAt, ownAccount ? 'sent' : null],
  );
  const row = rows[0]!;
  if (mediaUrl) await queueMediaDownload(tx, row.id);
  if (row.echo_pending) return;
  await emitMessageEvent(tx, row);
  for (const hook of inboundHooks) await hook(tx, row);
}

async function lockOutbound(tx: Queryable, clientMsgId: string) {
  const { rows } = await tx.query<MessageRow & { gateway_group_id: string }>(
    `SELECT m.*, g.gateway_group_id FROM messages m JOIN groups g ON g.id = m.group_id
      WHERE m.client_msg_id = $1 FOR UPDATE OF m`,
    [clientMsgId],
  );
  return rows[0];
}

export async function onMessageSent(tx: Queryable, data: Record<string, unknown>, log: Logger): Promise<void> {
  const clientMsgId = reqStr(data.clientMsgId, 'clientMsgId');
  const msgId = reqStr(data.msgId, 'msgId');
  const sentAt = reqDate(data.sentAt, 'sentAt');
  const row = await lockOutbound(tx, clientMsgId);
  if (!row) {
    log.warn({ clientMsgId }, 'message_sent for unknown clientMsgId');
    return;
  }
  const { gateway_group_id, ...msg } = row;
  await markSent(tx, msg, gateway_group_id, msgId, sentAt);
}

export async function onMessageFailed(tx: Queryable, data: Record<string, unknown>, log: Logger): Promise<void> {
  const clientMsgId = reqStr(data.clientMsgId, 'clientMsgId');
  const code = reqStr(data.code, 'code');
  const row = await lockOutbound(tx, clientMsgId);
  if (!row) {
    log.warn({ clientMsgId }, 'message_failed for unknown clientMsgId');
    return;
  }
  const { gateway_group_id: _g, ...msg } = row;
  if (msg.phase === 'sent' || msg.phase === 'failed' || msg.phase === 'cancelled') return;
  await updateOutbound(tx, msg, { phase: 'failed', fail_code: code, lease_owner: null, lease_until: null });
  await applyGatewayFailureConsequences(tx, msg, code);
}

/** Group/account consequences of a send error, shared by the sync (HTTP) and async (event) paths. */
export async function applyGatewayFailureConsequences(tx: Queryable, msg: MessageRow, code: string): Promise<void> {
  if (code === 'GROUP_WRITE_FORBIDDEN') {
    await markGroupUnreachable(tx, msg.group_id);
  } else if (code === 'ACCOUNT_SUSPENDED' && msg.account_id) {
    await enterTerminal(tx, msg.account_id, 'suspended', 'gateway_error');
  } else if (code === 'SESSION_EXPIRED' && msg.account_id) {
    await enterTerminal(tx, msg.account_id, 'session_expired', 'gateway_error');
  }
}

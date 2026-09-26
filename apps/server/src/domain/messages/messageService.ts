import { ErrorCode, isTerminalStatus, type AccountStatus } from '@gmp/shared';
import type { Pool } from '../../db/pool';
import { withTx } from '../../db/tx';
import { AppError, conflict, notFound } from '../../http/errors';
import { findGroup } from '../groups/groupRepo';
import { enqueueOutbound, toMessageDto, type MessageDto, type MessageRow } from './outbound';

export interface TimelinePage {
  items: MessageDto[];
  nextCursor: string | null;
}

/** Cursor = position (sort_ts in ms, id) of the last item returned; the next page starts strictly after it. */
export function encodeCursor(row: Pick<MessageRow, 'sort_ts' | 'id'>): string {
  return Buffer.from(`${row.sort_ts.getTime()}:${row.id}`).toString('base64url');
}

export function decodeCursor(cursor: string): { ts: Date; id: number } {
  const [ts, id] = Buffer.from(cursor, 'base64url').toString('utf8').split(':').map(Number);
  if (!Number.isSafeInteger(ts) || !Number.isSafeInteger(id)) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Invalid cursor');
  }
  return { ts: new Date(ts!), id: id! };
}

export class MessageService {
  constructor(private readonly deps: { pool: Pool }) {}

  /** Operator sends as a service account. Rate-limited accounts are accepted; the message waits in the queue. */
  async operatorSend(groupId: string, accountId: string, text: string): Promise<{ clientMsgId: string }> {
    return withTx(this.deps.pool, async (tx) => {
      const group = await findGroup(tx, groupId);
      if (!group) throw notFound(ErrorCode.GROUP_NOT_FOUND, `Group ${groupId} not found`);
      if (group.status === 'unreachable') throw conflict(ErrorCode.GROUP_UNREACHABLE, 'Group is not writable');

      // FOR SHARE serializes against a concurrent terminal transition, which cancels queued messages.
      const { rows: accounts } = await tx.query<{ status: AccountStatus; platform_user_id: string | null }>(
        'SELECT status, platform_user_id FROM accounts WHERE id = $1 FOR SHARE',
        [accountId],
      );
      const account = accounts[0];
      if (!account) throw notFound(ErrorCode.ACCOUNT_NOT_FOUND, `Account ${accountId} not found`);
      if (account.status === 'idle' || account.status === 'disconnected' || isTerminalStatus(account.status)) {
        throw conflict(ErrorCode.ACCOUNT_UNAVAILABLE, `Account is ${account.status}`, { status: account.status });
      }
      const member = await tx.query(
        'SELECT 1 FROM group_members WHERE group_id = $1 AND account_id = $2 AND present',
        [group.id, accountId],
      );
      if (!member.rowCount) throw conflict(ErrorCode.ACCOUNT_NOT_IN_GROUP, 'Account is not a member of this group');

      const row = await enqueueOutbound(tx, {
        groupId: group.id,
        accountId,
        senderPlatformUserId: account.platform_user_id,
        text,
        source: 'operator',
      });
      return { clientMsgId: row.client_msg_id! };
    });
  }

  /**
   * Newest first, keyset-paginated on (sort_ts, id). A page never repeats or skips rows that
   * existed when paging began: new messages sort before the cursor and cannot shift later pages.
   */
  async timeline(groupId: string, before: string | undefined, limit: number): Promise<TimelinePage> {
    const group = await findGroup(this.deps.pool, groupId);
    if (!group) throw notFound(ErrorCode.GROUP_NOT_FOUND, `Group ${groupId} not found`);
    const cursor = before ? decodeCursor(before) : null;
    const { rows } = await this.deps.pool.query<MessageRow>(
      `SELECT * FROM messages
        WHERE group_id = $1 AND NOT echo_pending
          AND ($2::timestamptz IS NULL OR (sort_ts, id) < ($2::timestamptz, $3::bigint))
        ORDER BY sort_ts DESC, id DESC
        LIMIT $4`,
      [group.id, cursor?.ts ?? null, cursor?.id ?? 0, limit + 1],
    );
    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    return { items: page.map(toMessageDto), nextCursor: hasMore ? encodeCursor(page[page.length - 1]!) : null };
  }
}

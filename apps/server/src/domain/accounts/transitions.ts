import { canTransition, isTerminalStatus, type AccountStatus } from '@gmp/shared';
import type { Queryable } from '../../db/pool';
import { emitWs } from '../../realtime/outbox';
import { cancelTask, scheduleTask } from '../tasks/scheduledTasks';
import { removeAccountFromAllGroups } from '../groups/groupRepo';
import { cancelQueued, OUTBOUND_CHANNEL } from '../messages/outbound';

/**
 * The single place where an account's status changes. Every source (operator, gateway error,
 * gateway event, timer) goes through these functions inside its own transaction, so the status,
 * its consequences and the pushed events commit or roll back together.
 */

export interface AccountRow {
  id: string;
  status: AccountStatus;
  platform_user_id: string | null;
  rate_limited_until: Date | null;
}

export class LockNotAvailableError extends Error {}

export async function lockAccount(
  tx: Queryable,
  accountId: string,
  mode: 'wait' | 'nowait' = 'wait',
): Promise<AccountRow | undefined> {
  try {
    const { rows } = await tx.query<AccountRow>(
      `SELECT id, status, platform_user_id, rate_limited_until FROM accounts WHERE id = $1 FOR UPDATE${
        mode === 'nowait' ? ' NOWAIT' : ''
      }`,
      [accountId],
    );
    return rows[0];
  } catch (err) {
    if ((err as { code?: string }).code === '55P03') throw new LockNotAvailableError(accountId);
    throw err;
  }
}

export interface TransitionExtra {
  platformUserId?: string;
  rateLimitedUntil?: Date;
}

/** Applies a transition to a row locked by the caller. The caller has validated it against the table. */
export async function applyTransition(
  tx: Queryable,
  row: AccountRow,
  to: AccountStatus,
  source: string,
  extra: TransitionExtra = {},
): Promise<void> {
  const from = row.status;
  if (!canTransition(from, to)) throw new Error(`BUG: illegal transition ${from} -> ${to} for ${row.id}`);

  const rateLimitedUntil = to === 'rate_limited' ? (extra.rateLimitedUntil ?? null) : null;
  await tx.query(
    `UPDATE accounts
        SET status = $2, rate_limited_until = $3,
            platform_user_id = COALESCE($4, platform_user_id), updated_at = now()
      WHERE id = $1`,
    [row.id, to, rateLimitedUntil, extra.platformUserId ?? null],
  );
  row.status = to;
  row.rate_limited_until = rateLimitedUntil;
  if (extra.platformUserId) row.platform_user_id = extra.platformUserId;

  if (to === 'rate_limited' && rateLimitedUntil) {
    await scheduleTask(tx, 'rate_limit_expiry', row.id, rateLimitedUntil);
  } else if (from === 'rate_limited') {
    await cancelTask(tx, 'rate_limit_expiry', row.id);
  }

  await emitWs(tx, 'account_status_changed', { accountId: row.id, from, to, source });
  if (to === 'online') await tx.query(`NOTIFY ${OUTBOUND_CHANNEL}`);

  if (isTerminalStatus(to)) {
    await applyTerminalConsequences(tx, row.id);
    await emitWs(tx, 'account_terminal', { accountId: row.id, status: to });
  }
}

/** Everything that must happen, atomically with the status change, when an account becomes terminal. */
async function applyTerminalConsequences(tx: Queryable, accountId: string): Promise<void> {
  await cancelTask(tx, 'gateway_disconnect', accountId);
  await removeAccountFromAllGroups(tx, accountId);
  await cancelQueued(tx, { accountId }, 'ACCOUNT_TERMINAL');
}

/**
 * Moves the account into a terminal status from whatever non-terminal status it has.
 * Re-entering a terminal status (the same or the other one) is silently ignored.
 */
export async function enterTerminal(
  tx: Queryable,
  accountId: string,
  status: 'suspended' | 'session_expired',
  source: string,
): Promise<'entered' | 'already_terminal' | 'not_found'> {
  const row = await lockAccount(tx, accountId);
  if (!row) return 'not_found';
  if (isTerminalStatus(row.status)) return 'already_terminal';
  await applyTransition(tx, row, status, source);
  return 'entered';
}

/**
 * Records a RATE_LIMITED response. An online account moves to rate_limited; for an account that is
 * already rate_limited only rateLimitedUntil is refreshed (not a transition). Other statuses are left alone.
 */
export async function markRateLimited(
  tx: Queryable,
  accountId: string,
  retryAfterSeconds: number,
  source: string,
): Promise<void> {
  const row = await lockAccount(tx, accountId);
  if (!row) return;
  const until = new Date(Date.now() + Math.max(retryAfterSeconds, 0) * 1000);
  if (row.status === 'online') {
    await applyTransition(tx, row, 'rate_limited', source, { rateLimitedUntil: until });
  } else if (row.status === 'rate_limited') {
    await tx.query('UPDATE accounts SET rate_limited_until = $2, updated_at = now() WHERE id = $1', [row.id, until]);
    await scheduleTask(tx, 'rate_limit_expiry', row.id, until);
  }
}

/** Timer callback: back to online, unless the account has left rate_limited in the meantime. */
export async function expireRateLimit(tx: Queryable, accountId: string): Promise<void> {
  const row = await lockAccount(tx, accountId);
  if (!row || row.status !== 'rate_limited') return;
  if (row.rate_limited_until && row.rate_limited_until.getTime() > Date.now()) {
    await scheduleTask(tx, 'rate_limit_expiry', row.id, row.rate_limited_until);
    return;
  }
  await applyTransition(tx, row, 'online', 'rate_limit_expired');
}

export function terminalStatusForGatewayCode(code: string): 'suspended' | 'session_expired' | null {
  if (code === 'ACCOUNT_SUSPENDED') return 'suspended';
  if (code === 'SESSION_EXPIRED') return 'session_expired';
  return null;
}

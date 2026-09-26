import { isTerminalStatus, type AccountStatus } from '@gmp/shared';
import type { Queryable } from '../../db/pool';
import { emitWs } from '../../realtime/outbox';
import { cancelQueued } from '../messages/outbound';

export interface GroupRow {
  id: string;
  gateway_group_id: string | null;
  status: 'active' | 'unreachable' | 'left';
  creator_account_id: string | null;
  agent_enabled: boolean;
  auto_kick_enabled: boolean;
  created_at: Date;
}

export async function findGroupByGatewayId(tx: Queryable, gatewayGroupId: string): Promise<GroupRow | undefined> {
  const { rows } = await tx.query<GroupRow>('SELECT * FROM groups WHERE gateway_group_id = $1', [gatewayGroupId]);
  return rows[0];
}

export async function findGroup(tx: Queryable, groupId: string, lock = false): Promise<GroupRow | undefined> {
  if (!/^[0-9a-f-]{36}$/i.test(groupId)) return undefined;
  const { rows } = await tx.query<GroupRow>(`SELECT * FROM groups WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [groupId]);
  return rows[0];
}

/**
 * Applies a member_joined / member_left event. Order-independent: a row only changes when the event
 * is newer than the one that last changed it. A terminal account can never (re)appear as a member.
 */
export async function applyMemberEvent(
  tx: Queryable,
  group: GroupRow,
  platformUserId: string,
  present: boolean,
  eventId: number,
): Promise<boolean> {
  const { rows: accounts } = await tx.query<{ id: string; status: AccountStatus }>(
    'SELECT id, status FROM accounts WHERE platform_user_id = $1',
    [platformUserId],
  );
  const account = accounts[0];
  if (present && account && isTerminalStatus(account.status)) return false;
  const { rows: prev } = await tx.query<{ present: boolean }>(
    'SELECT present FROM group_members WHERE group_id = $1 AND platform_user_id = $2 FOR UPDATE',
    [group.id, platformUserId],
  );
  const { rowCount } = await tx.query(
    `INSERT INTO group_members (group_id, platform_user_id, account_id, role, present, state_event_id)
     VALUES ($1, $2, $3, 'member', $4, $5)
     ON CONFLICT (group_id, platform_user_id) DO UPDATE
       SET present = EXCLUDED.present,
           role = CASE WHEN EXCLUDED.present AND NOT group_members.present THEN 'member' ELSE group_members.role END,
           account_id = COALESCE(EXCLUDED.account_id, group_members.account_id),
           state_event_id = EXCLUDED.state_event_id,
           updated_at = now()
     WHERE group_members.state_event_id < EXCLUDED.state_event_id`,
    [group.id, platformUserId, account?.id ?? null, present, eventId],
  );
  const changed = Boolean(rowCount) && prev[0]?.present !== present;
  if (changed) await emitWs(tx, 'group_changed', { groupId: group.id });
  return changed;
}

/** Terminal accounts leave every group in our records (the gateway removes them too). */
export async function removeAccountFromAllGroups(tx: Queryable, accountId: string): Promise<string[]> {
  const { rows } = await tx.query<{ group_id: string }>(
    `UPDATE group_members SET present = false, updated_at = now()
      WHERE account_id = $1 AND present RETURNING group_id`,
    [accountId],
  );
  for (const r of rows) await emitWs(tx, 'group_changed', { groupId: r.group_id });
  return rows.map((r) => r.group_id);
}

export type GroupUnreachableHook = (tx: Queryable, groupId: string) => Promise<void>;
const unreachableHooks: GroupUnreachableHook[] = [];
export function registerGroupUnreachableHook(hook: GroupUnreachableHook): void {
  if (!unreachableHooks.includes(hook)) unreachableHooks.push(hook);
}

/**
 * GROUP_WRITE_FORBIDDEN: the group can no longer be written to. Queued messages are cancelled and
 * dependants (sequence runs, agent runs) react via hooks, all in the caller's transaction.
 */
export async function markGroupUnreachable(tx: Queryable, groupId: string): Promise<boolean> {
  const { rowCount } = await tx.query(
    `UPDATE groups SET status = 'unreachable', updated_at = now() WHERE id = $1 AND status = 'active'`,
    [groupId],
  );
  if (!rowCount) return false;
  await cancelQueued(tx, { groupId }, 'GROUP_UNREACHABLE');
  for (const hook of unreachableHooks) await hook(tx, groupId);
  await emitWs(tx, 'group_changed', { groupId });
  return true;
}

import { ErrorCode, type AccountStatus } from '@gmp/shared';
import type { Pool, Queryable } from '../../db/pool';
import { pgCode, withTx } from '../../db/tx';
import { AppError, conflict, notFound } from '../../http/errors';
import { emitWs } from '../../realtime/outbox';
import { enqueueJob } from '../jobs/jobRunner';
import { findGroup, type GroupRow } from './groupRepo';

export type MemberRole = 'creator' | 'admin' | 'member';

export interface GroupDto {
  id: string;
  gatewayGroupId: string | null;
  status: GroupRow['status'];
  creatorAccountId: string | null;
  agentEnabled: boolean;
  autoKickEnabled: boolean;
  members: { accountId: string | null; platformUserId: string; role: MemberRole }[];
  activeSequenceRunId: string | null;
  activeAgentRunId: string | null;
}

/** Columns other modules can contribute to the group DTO (e.g. the running agent / sequence run). */
export type ActiveRunResolver = (db: Queryable, groupIds: string[]) => Promise<Map<string, string>>;

export type GroupSettingsHook = (tx: Queryable, groupId: string, changes: { agentEnabled?: boolean }) => Promise<void>;

export class GroupService {
  private activeAgentRuns: ActiveRunResolver = async () => new Map();
  private activeSequenceRuns: ActiveRunResolver = async () => new Map();
  private settingsHooks: GroupSettingsHook[] = [];

  constructor(private readonly deps: { pool: Pool }) {}

  setActiveRunResolvers(r: { agent?: ActiveRunResolver; sequence?: ActiveRunResolver }): void {
    if (r.agent) this.activeAgentRuns = r.agent;
    if (r.sequence) this.activeSequenceRuns = r.sequence;
  }

  onSettingsChanged(hook: GroupSettingsHook): void {
    this.settingsHooks.push(hook);
  }

  async list(): Promise<GroupDto[]> {
    const { rows } = await this.deps.pool.query<GroupRow>('SELECT * FROM groups ORDER BY created_at DESC, id');
    return this.toDtos(this.deps.pool, rows);
  }

  async get(groupId: string): Promise<GroupDto> {
    const group = await findGroup(this.deps.pool, groupId);
    if (!group) throw notFound(ErrorCode.GROUP_NOT_FOUND, `Group ${groupId} not found`);
    return (await this.toDtos(this.deps.pool, [group]))[0]!;
  }

  async patch(groupId: string, changes: { agentEnabled?: boolean; autoKickEnabled?: boolean }): Promise<GroupDto> {
    return withTx(this.deps.pool, async (tx) => {
      const group = await findGroup(tx, groupId, true);
      if (!group) throw notFound(ErrorCode.GROUP_NOT_FOUND, `Group ${groupId} not found`);
      const { rows } = await tx.query<GroupRow>(
        `UPDATE groups SET agent_enabled = COALESCE($2, agent_enabled), auto_kick_enabled = COALESCE($3, auto_kick_enabled),
                updated_at = now()
          WHERE id = $1 RETURNING *`,
        [group.id, changes.agentEnabled ?? null, changes.autoKickEnabled ?? null],
      );
      if (changes.agentEnabled !== undefined && changes.agentEnabled !== group.agent_enabled) {
        for (const hook of this.settingsHooks) await hook(tx, group.id, { agentEnabled: changes.agentEnabled });
      }
      await emitWs(tx, 'group_changed', { groupId: group.id });
      return (await this.toDtos(tx, rows))[0]!;
    });
  }

  /** Validates and starts a create-group job. Returns the job id. */
  async requestCreate(creatorAccountId: string, memberAccountIds: string[]): Promise<string> {
    return withTx(this.deps.pool, async (tx) => {
      const ids = [creatorAccountId, ...memberAccountIds];
      const { rows } = await tx.query<{ id: string; status: AccountStatus }>(
        'SELECT id, status FROM accounts WHERE id = ANY($1) FOR SHARE',
        [ids],
      );
      const found = new Map(rows.map((r) => [r.id, r.status]));
      const unknown = ids.filter((id) => !found.has(id));
      if (unknown.length) {
        throw new AppError(400, ErrorCode.VALIDATION_ERROR, `Unknown account(s): ${unknown.join(', ')}`, {
          accountIds: unknown,
        });
      }
      const notOnline = ids.filter((id) => found.get(id) !== 'online');
      if (notOnline.length) {
        throw new AppError(422, ErrorCode.ACCOUNT_NOT_ONLINE, `Account(s) not online: ${notOnline.join(', ')}`, {
          accountIds: notOnline,
        });
      }
      return enqueueJob(tx, 'create_group', { creatorAccountId, memberAccountIds });
    });
  }

  /** Starts leave-all; if one is already running for the group, returns that job instead. */
  async requestLeaveAll(groupId: string): Promise<string> {
    const group = await findGroup(this.deps.pool, groupId);
    if (!group) throw notFound(ErrorCode.GROUP_NOT_FOUND, `Group ${groupId} not found`);
    if (group.status === 'left') throw conflict(ErrorCode.GROUP_LEFT, 'All service accounts already left this group');
    try {
      return await withTx(this.deps.pool, (tx) => enqueueJob(tx, 'leave_all', {}, group.id));
    } catch (err) {
      if (pgCode(err) !== '23505') throw err;
      const { rows } = await this.deps.pool.query<{ id: string }>(
        `SELECT id FROM jobs WHERE group_id = $1 AND type = 'leave_all' AND status = 'running'`,
        [group.id],
      );
      if (!rows[0]) throw err;
      return rows[0].id;
    }
  }

  private async toDtos(db: Queryable, groups: GroupRow[]): Promise<GroupDto[]> {
    if (groups.length === 0) return [];
    const ids = groups.map((g) => g.id);
    const { rows: members } = await db.query<{
      group_id: string;
      account_id: string | null;
      platform_user_id: string;
      role: MemberRole;
    }>(
      `SELECT group_id, account_id, platform_user_id, role FROM group_members
        WHERE group_id = ANY($1) AND present
        ORDER BY CASE role WHEN 'creator' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, account_id NULLS LAST, platform_user_id`,
      [ids],
    );
    const [agentRuns, sequenceRuns] = await Promise.all([this.activeAgentRuns(db, ids), this.activeSequenceRuns(db, ids)]);
    return groups.map((g) => ({
      id: g.id,
      gatewayGroupId: g.gateway_group_id,
      status: g.status,
      creatorAccountId: g.creator_account_id,
      agentEnabled: g.agent_enabled,
      autoKickEnabled: g.auto_kick_enabled,
      members:
        g.status === 'left'
          ? []
          : members
              .filter((m) => m.group_id === g.id)
              .map((m) => ({ accountId: m.account_id, platformUserId: m.platform_user_id, role: m.role })),
      activeSequenceRunId: sequenceRuns.get(g.id) ?? null,
      activeAgentRunId: agentRuns.get(g.id) ?? null,
    }));
  }
}

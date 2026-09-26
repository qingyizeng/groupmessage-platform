import { randomUUID } from 'node:crypto';
import type { Pool } from '../../db/pool';
import { sleep } from '../../lib/async';
import { failpoints } from '../../lib/failpoints';
import type { Logger } from '../../lib/logger';
import { GatewayError, type GatewayClient } from '../../integrations/gatewayClient';
import { emitWs } from '../../realtime/outbox';
import type { JobHandle, JobImpl } from './jobRunner';
import { gatewayRetry, isServiceMember, waitUntil } from './jobUtils';

interface JoinState {
  status: 'pending' | 'requested' | 'joined' | 'failed';
  deadline?: number;
}

interface CreateGroupState extends Record<string, unknown> {
  groupId?: string;
  gatewayGroupId?: string;
  invite?: { link: string; readyAt: number; issued: number };
  joins?: Record<string, JoinState>;
  promote?: { calls: number; done: boolean };
}

interface CreateGroupInput {
  creatorAccountId: string;
  memberAccountIds: string[];
}

export interface CreateGroupDeps {
  pool: Pool;
  gateway: GatewayClient;
  log: Logger;
  joinTimeoutMs: number;
}

const MAX_PROMOTE_CALLS = 2;
const MAX_NOT_READY_RETRIES = 20;

/**
 * create → invite → join each member → wait for member_joined → promote memberAccountIds[0].
 * Every step is checkpointed in the job state, so a resumed job never creates a second group and
 * never exceeds two promote calls in total.
 */
export function createGroupJob(deps: CreateGroupDeps): JobImpl {
  return async (handle) => {
    const job = handle as JobHandle<CreateGroupState>;
    const input = job.row.input as unknown as CreateGroupInput;
    const s = job.state;
    const { gateway, pool } = deps;
    const creator = input.creatorAccountId;
    const members = input.memberAccountIds;

    // ---------------------------------------------------------------- create
    if (!s.gatewayGroupId) {
      if (job.errors.length > 0) return;
      const created = await gatewayRetry(() => gateway.createGroup(creator), { retryUnknown: true });
      if (!created.ok) return job.fail('create', created.code);
      const groupId = randomUUID();
      const { rows: acc } = await pool.query<{ platform_user_id: string }>(
        'SELECT platform_user_id FROM accounts WHERE id = $1',
        [creator],
      );
      s.groupId = groupId;
      s.gatewayGroupId = created.value.groupId;
      job.row.group_id = groupId;
      // The gateway has no idempotency key for create: if this save were lost, resuming would create a
      // second (orphan) group. So retry the save itself for a while before giving up.
      await retrySave(() => job.save(async (tx) => {
        await tx.query('INSERT INTO groups (id, gateway_group_id, creator_account_id) VALUES ($1, $2, $3)', [
          groupId,
          created.value.groupId,
          creator,
        ]);
        await tx.query(
          `INSERT INTO group_members (group_id, platform_user_id, account_id, role, present)
           VALUES ($1, $2, $3, 'creator', true)`,
          [groupId, acc[0]!.platform_user_id, creator],
        );
        await emitWs(tx, 'group_changed', { groupId });
      }), job.signal);
    }
    failpoints.hit('job.create_group.after_create');
    const groupId = s.groupId!;
    const gg = s.gatewayGroupId!;

    // ---------------------------------------------------------------- invite
    const requestInvite = async (): Promise<boolean> => {
      const inv = await gatewayRetry(() => gateway.invite(gg));
      if (!inv.ok) {
        await job.fail('invite', inv.code);
        return false;
      }
      s.invite = {
        link: inv.value.inviteLink,
        readyAt: Date.now() + Math.max(0, inv.value.readyAfterMs),
        issued: (s.invite?.issued ?? 0) + 1,
      };
      await job.save();
      return true;
    };
    if (!s.invite && !(await requestInvite())) return;

    // A link found expired by one join is renewed once, and the other joins pick up the new link.
    let renewing: Promise<boolean> | null = null;
    const renewInvite = (expiredLink: string): Promise<boolean> => {
      if (s.invite!.link !== expiredLink) return Promise.resolve(true);
      renewing ??= requestInvite().finally(() => {
        renewing = null;
      });
      return renewing;
    };

    // ---------------------------------------------------------------- join
    s.joins ??= Object.fromEntries(members.map((m) => [m, { status: 'pending' } as JoinState]));
    await job.save();

    const joinOne = async (accountId: string): Promise<void> => {
      const j = s.joins![accountId]!;
      if (j.status === 'joined' || j.status === 'failed') return;
      if (await isServiceMember(pool, groupId, accountId)) {
        j.status = 'joined';
        return job.save();
      }
      if (j.status === 'pending') {
        let renewed = false;
        let notReady = 0;
        let unavailable = 0;
        for (;;) {
          const link = s.invite!.link;
          const wait = s.invite!.readyAt - Date.now();
          if (wait > 0) await sleep(wait, job.signal);
          job.throwIfAborted();
          try {
            await gateway.join(gg, accountId, link);
          } catch (err) {
            if (!(err instanceof GatewayError)) throw err;
            if (err.code === 'INVITE_NOT_READY' && notReady++ < MAX_NOT_READY_RETRIES) {
              await sleep(Math.max(500, s.invite!.readyAt - Date.now()), job.signal);
              job.throwIfAborted();
              continue;
            }
            if (err.code === 'INVITE_EXPIRED' && !renewed) {
              renewed = true;
              if (!(await renewInvite(link))) return;
              continue;
            }
            if (err.code === 'ALREADY_MEMBER') {
              j.status = 'joined';
              return job.save((tx) => ensureMemberRow(tx, groupId, accountId));
            }
            if (err.unavailable && unavailable++ < 5) {
              await sleep(300 * 2 ** unavailable, job.signal);
              job.throwIfAborted();
              continue;
            }
            if (err.outcome !== 'unknown') {
              j.status = 'failed';
              return job.fail(`join:${accountId}`, err.code);
            }
            // Unknown outcome: the join may have been accepted; wait for member_joined like a 202.
          }
          j.status = 'requested';
          j.deadline = Date.now() + deps.joinTimeoutMs;
          await job.save();
          break;
        }
      }

      // requested: wait for member_joined to be processed.
      let joined = await waitUntil(() => isServiceMember(pool, groupId, accountId), j.deadline!, job.signal);
      if (!joined) {
        // The gateway may already list the member while our event processing lags behind (for
        // example right after a restart); give processing one more window before giving up.
        const pu = await pool.query<{ platform_user_id: string }>('SELECT platform_user_id FROM accounts WHERE id = $1', [
          accountId,
        ]);
        const listed = await gateway
          .members(gg)
          .then((ms) => ms.some((m) => m.platformUserId === pu.rows[0]?.platform_user_id))
          .catch(() => false);
        if (listed) {
          joined = await waitUntil(() => isServiceMember(pool, groupId, accountId), Date.now() + deps.joinTimeoutMs, job.signal);
        }
      }
      job.throwIfAborted();
      if (joined) {
        j.status = 'joined';
        return job.save();
      }
      j.status = 'failed';
      return job.fail(`join:${accountId}`, 'JOIN_TIMEOUT');
    };
    await Promise.all(members.map(joinOne));
    job.throwIfAborted();

    // ---------------------------------------------------------------- promote
    const admin = members[0]!;
    if (s.joins[admin]?.status !== 'joined') return;
    s.promote ??= { calls: 0, done: false };
    let lastCode = 'PROMOTE_UNCONFIRMED';
    while (!s.promote.done && s.promote.calls < MAX_PROMOTE_CALLS) {
      s.promote.calls++;
      await job.save();
      try {
        await gateway.promote(gg, creator, admin);
        s.promote.done = true;
        await job.save(async (tx) => {
          await tx.query(
            `UPDATE group_members SET role = 'admin', updated_at = now() WHERE group_id = $1 AND account_id = $2`,
            [groupId, admin],
          );
          await emitWs(tx, 'group_changed', { groupId });
        });
        return;
      } catch (err) {
        if (!(err instanceof GatewayError)) throw err;
        lastCode = err.code;
        const retryable = err.code === 'NOT_MEMBER_YET' || err.outcome === 'unknown' || err.unavailable;
        if (!retryable) break;
        if (s.promote.calls < MAX_PROMOTE_CALLS) await sleep(1000, job.signal);
        job.throwIfAborted();
      }
    }
    if (!s.promote.done) await job.fail('promote', lastCode);
  };
}

async function retrySave(save: () => Promise<void>, signal: AbortSignal): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      return await save();
    } catch (err) {
      if (i >= 8 || signal.aborted) throw err;
      await sleep(Math.min(250 * 2 ** i, 5_000), signal);
    }
  }
}

/** After ALREADY_MEMBER no member_joined will follow, so record the membership ourselves. */
async function ensureMemberRow(tx: import('../../db/pool').Queryable, groupId: string, accountId: string) {
  await tx.query(
    `INSERT INTO group_members (group_id, platform_user_id, account_id, role, present)
     SELECT $1, platform_user_id, id, 'member', true FROM accounts WHERE id = $2
     ON CONFLICT (group_id, platform_user_id) DO UPDATE SET present = true, account_id = EXCLUDED.account_id, updated_at = now()`,
    [groupId, accountId],
  );
  await emitWs(tx, 'group_changed', { groupId });
}

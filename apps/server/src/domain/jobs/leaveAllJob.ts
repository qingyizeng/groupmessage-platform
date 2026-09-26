import type { Pool } from '../../db/pool';
import { sleep } from '../../lib/async';
import type { Logger } from '../../lib/logger';
import { GatewayError, type GatewayClient } from '../../integrations/gatewayClient';
import { emitWs } from '../../realtime/outbox';
import { findGroup, type GroupRow } from '../groups/groupRepo';
import type { JobHandle, JobImpl } from './jobRunner';
import { gatewayRetry, isServiceMember, waitUntil } from './jobUtils';

interface LeaveAllState extends Record<string, unknown> {
  leaves?: Record<string, 'pending' | 'left' | 'failed'>;
}

export interface LeaveAllDeps {
  pool: Pool;
  gateway: GatewayClient;
  log: Logger;
  /** How long to wait for member_left after a successful leave. */
  leaveEventTimeoutMs: number;
}

/**
 * All service accounts leave; the owner leaves last, and only if every other account left
 * (once the owner is gone nobody could act for the group any more). A failed leave is recorded,
 * the remaining non-owners still try, and the failed account stays a member on both sides.
 * Ends by reconciling our membership rows with the gateway's member list.
 */
export function leaveAllJob(deps: LeaveAllDeps): JobImpl {
  return async (handle) => {
    const job = handle as JobHandle<LeaveAllState>;
    const { pool, gateway } = deps;
    const group = await findGroup(pool, job.row.group_id!);
    if (!group || !group.gateway_group_id || group.status === 'left') return;
    const gg = group.gateway_group_id;
    const s = job.state;

    if (!s.leaves) {
      const { rows } = await pool.query<{ account_id: string }>(
        `SELECT account_id FROM group_members WHERE group_id = $1 AND present AND account_id IS NOT NULL ORDER BY account_id`,
        [group.id],
      );
      s.leaves = Object.fromEntries(rows.map((r) => [r.account_id, 'pending' as const]));
      await job.save();
    }
    const owner = group.creator_account_id;
    const nonOwners = Object.keys(s.leaves).filter((a) => a !== owner);

    const leaveOne = async (accountId: string): Promise<void> => {
      let left = false;
      try {
        await gateway.leave(gg, accountId);
        left = true;
      } catch (err) {
        if (!(err instanceof GatewayError)) throw err;
        if (err.code === 'NOT_MEMBER') {
          left = true;
        } else if (err.outcome === 'unknown' || err.unavailable) {
          // Outcome unknown (or gateway briefly down): the member list converges, so ask it.
          await sleep(2_000, job.signal);
          job.throwIfAborted();
          left = !(await stillListed(gateway, pool, gg, accountId));
          if (!left) {
            s.leaves![accountId] = 'failed';
            return job.fail(`leave:${accountId}`, err.code);
          }
        } else {
          s.leaves![accountId] = 'failed';
          return job.fail(`leave:${accountId}`, err.code);
        }
      }
      if (left) {
        const gone = await waitUntil(
          async () => !(await isServiceMember(pool, group.id, accountId)),
          Date.now() + deps.leaveEventTimeoutMs,
          job.signal,
        );
        job.throwIfAborted();
        if (!gone) await markNotMember(pool, group.id, accountId);
        s.leaves![accountId] = 'left';
        await job.save();
      }
    };

    for (const accountId of nonOwners) {
      if (s.leaves[accountId] === 'pending') await leaveOne(accountId);
    }
    if (nonOwners.every((a) => s.leaves![a] === 'left') && owner && s.leaves[owner] === 'pending') {
      await leaveOne(owner);
    }

    if (job.errors.length === 0) {
      await job.save(async (tx) => {
        await tx.query(`UPDATE groups SET status = 'left', updated_at = now() WHERE id = $1`, [group.id]);
        await tx.query('UPDATE group_members SET present = false, updated_at = now() WHERE group_id = $1 AND present', [
          group.id,
        ]);
        await emitWs(tx, 'group_changed', { groupId: group.id });
      });
    }
    await reconcileMembers(deps, group);
  };
}

async function stillListed(gateway: GatewayClient, pool: Pool, gg: string, accountId: string): Promise<boolean> {
  const pu = await pool.query<{ platform_user_id: string }>('SELECT platform_user_id FROM accounts WHERE id = $1', [accountId]);
  const res = await gatewayRetry(() => gateway.members(gg));
  if (!res.ok) return true;
  return res.value.some((m) => m.platformUserId === pu.rows[0]?.platform_user_id);
}

async function markNotMember(pool: Pool, groupId: string, accountId: string) {
  await pool.query(
    'UPDATE group_members SET present = false, updated_at = now() WHERE group_id = $1 AND account_id = $2',
    [groupId, accountId],
  );
}

/** Makes our service-account membership rows agree with the gateway, reporting any correction. */
async function reconcileMembers(deps: LeaveAllDeps, group: GroupRow): Promise<void> {
  const res = await gatewayRetry(() => deps.gateway.members(group.gateway_group_id!));
  if (!res.ok) {
    deps.log.warn({ groupId: group.id, code: res.code }, 'could not reconcile members after leave-all');
    return;
  }
  const listed = new Set(res.value.map((m) => m.platformUserId));
  const { rows } = await deps.pool.query<{ account_id: string; platform_user_id: string; present: boolean }>(
    `SELECT gm.account_id, gm.platform_user_id, gm.present FROM group_members gm
      WHERE gm.group_id = $1 AND gm.account_id IS NOT NULL`,
    [group.id],
  );
  const client = await deps.pool.connect();
  try {
    for (const r of rows) {
      const inGateway = listed.has(r.platform_user_id);
      if (inGateway === r.present) continue;
      await client.query('BEGIN');
      await client.query(
        'UPDATE group_members SET present = $3, updated_at = now() WHERE group_id = $1 AND platform_user_id = $2',
        [group.id, r.platform_user_id, inGateway],
      );
      await emitWs(client, 'inconsistency', {
        kind: 'membership_mismatch',
        ref: `group:${group.id}`,
        message: `${r.account_id} was ${r.present ? 'present' : 'absent'} in our records but ${
          inGateway ? 'present' : 'absent'
        } in the gateway; corrected`,
      });
      await emitWs(client, 'group_changed', { groupId: group.id });
      await client.query('COMMIT');
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

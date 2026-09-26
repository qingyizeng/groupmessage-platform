import type { Pool, PoolClient } from '../../db/pool';
import { withTx } from '../../db/tx';
import type { Logger } from '../../lib/logger';
import { Waker } from '../../lib/async';
import { failpoints } from '../../lib/failpoints';
import type { PgListener } from '../../infra/pgListener';
import { GatewayError, type GatewayClient } from '../../integrations/gatewayClient';
import { markRateLimited } from '../accounts/transitions';
import { emitMessageEvent, markSent, OUTBOUND_CHANNEL, updateOutbound, type MessageRow } from './outbound';
import { applyGatewayFailureConsequences } from './inbound';

export interface DeliveryOptions {
  pool: Pool;
  gateway: GatewayClient;
  listener: PgListener;
  log: Logger;
  instanceId: string;
  /** Our HTTP timeout for send; also bounds how long a dispatch may be in flight. */
  sendTimeoutMs: number;
  /** After a 504 the gateway converges within this window (spec: 2s). */
  confirmWindowMs?: number;
  /** How often an unknown message is re-checked via by-client-id. */
  recheckMs?: number;
  /** Hidden echoes that were never matched to an outbound row become visible after this long. */
  orphanEchoMs?: number;
  pollMs?: number;
}

type Row = MessageRow & { gateway_group_id: string };

const MAX_ATTEMPTS = 2;
const UNAVAILABLE_BACKOFF_MS = 1_000;

/**
 * Delivers outbound messages. Guarantees (see docs/architecture.md §5.2):
 * - a message is marked `dispatching` (committed) before any send request, so a crash can never
 *   leave a gateway message without a database row;
 * - a message is re-sent only after the gateway proved it was not delivered (by-client-id 404 after
 *   the convergence window), and at most once, so one row never becomes two gateway messages;
 * - messages of one account are sent in order; a rate-limited account gets no send at all until the
 *   window expires.
 */
export class DeliveryService {
  private readonly waker = new Waker();
  private readonly inflight = new Set<Promise<void>>();
  /** Message ids this process is currently working on; anything else leased to us is from a previous run. */
  private readonly active = new Set<number>();
  private readonly opts: Required<DeliveryOptions>;

  constructor(opts: DeliveryOptions) {
    this.opts = { confirmWindowMs: 2_000, recheckMs: 300, orphanEchoMs: 30_000, pollMs: 100, ...opts };
    opts.listener.on(OUTBOUND_CHANNEL, () => this.waker.wake());
  }

  wake(): void {
    this.waker.wake();
  }

  async run(signal: AbortSignal): Promise<void> {
    let lastSweep = 0;
    while (!signal.aborted) {
      let didWork = false;
      try {
        didWork = (await this.recoverStale()) > 0;
        const claimed = await this.claimQueued();
        const unknown = await this.claimUnknown();
        for (const r of claimed) this.track(r.id, () => this.dispatch(r));
        for (const r of unknown) this.track(r.id, () => this.reconcile(r));
        didWork = didWork || claimed.length > 0 || unknown.length > 0;
        if (Date.now() - lastSweep > 5_000) {
          lastSweep = Date.now();
          await this.revealOrphanEchoes();
        }
      } catch (err) {
        this.opts.log.warn({ err: String(err) }, 'delivery loop iteration failed');
      }
      if (!didWork) await this.waker.wait(this.opts.pollMs, signal);
    }
    await Promise.allSettled([...this.inflight]);
  }

  private track(id: number, work: () => Promise<void>) {
    this.active.add(id);
    const tracked = work()
      .catch((err) => this.opts.log.warn({ err: String(err) }, 'delivery task failed'))
      .finally(() => {
        this.active.delete(id);
        this.inflight.delete(tracked);
        this.waker.wake();
      });
    this.inflight.add(tracked);
  }

  /** SQL condition: the lease is free, expired, or ours but not being worked on by this process. */
  private leaseClaimable(): { sql: string; params: [string, number[]] } {
    return {
      sql: `(lease_until IS NULL OR lease_until < now() OR (lease_owner = $1 AND NOT (id = ANY($2::bigint[]))))`,
      params: [this.opts.instanceId, [...this.active]],
    };
  }

  // ------------------------------------------------------------------ dispatch

  /** Claims the head of each account's queue if it is sendable, and marks it dispatching. */
  private async claimQueued(): Promise<Row[]> {
    const { pool, instanceId, sendTimeoutMs } = this.opts;
    return withTx(pool, async (tx) => {
      const { rows } = await tx.query<Row & { account_status: string; group_status: string }>(
        `WITH heads AS (
           SELECT DISTINCT ON (account_id) id, phase FROM messages
            WHERE phase IN ('queued', 'dispatching', 'unknown', 'resending')
            ORDER BY account_id, id)
         SELECT m.*, a.status AS account_status, g.status AS group_status, g.gateway_group_id
           FROM heads h
           JOIN messages m ON m.id = h.id
           JOIN accounts a ON a.id = m.account_id
           JOIN groups g ON g.id = m.group_id
          WHERE h.phase = 'queued'
            AND (m.next_attempt_at IS NULL OR m.next_attempt_at <= now())
            AND a.status <> 'rate_limited'
            AND (a.rate_limited_until IS NULL OR a.rate_limited_until <= now())
          ORDER BY m.id LIMIT 20
          FOR UPDATE OF m SKIP LOCKED`,
      );
      const toSend: Row[] = [];
      for (const r of rows) {
        const { account_status, group_status, ...row } = r;
        if (account_status === 'suspended' || account_status === 'session_expired') {
          await updateOutbound(tx, row, { phase: 'cancelled', fail_code: 'ACCOUNT_TERMINAL' });
        } else if (account_status === 'idle' || account_status === 'disconnected') {
          await updateOutbound(tx, row, { phase: 'failed', fail_code: 'ACCOUNT_OFFLINE' });
        } else if (group_status === 'unreachable') {
          await updateOutbound(tx, row, { phase: 'cancelled', fail_code: 'GROUP_UNREACHABLE' });
        } else {
          await updateOutbound(tx, row, {
            phase: 'dispatching',
            attempt: row.attempt + 1,
            dispatch_started_at: new Date(),
            next_attempt_at: null,
            lease_owner: instanceId,
            lease_until: new Date(Date.now() + sendTimeoutMs + 5_000),
          });
          toSend.push(row);
        }
      }
      return toSend;
    });
  }

  private async dispatch(row: Row): Promise<void> {
    failpoints.hit('delivery.before_send');
    let error: GatewayError | null = null;
    try {
      await this.opts.gateway.send(row.gateway_group_id, row.account_id!, row.client_msg_id!, row.text);
    } catch (err) {
      if (!(err instanceof GatewayError)) throw err;
      error = err;
    }
    failpoints.hit('delivery.after_send');
    await withTx(this.opts.pool, async (tx) => {
      const cur = await this.lockOwned(tx, row, ['dispatching', 'resending']);
      if (cur) await this.applySendResult(tx, cur, error);
    });
  }

  private async applySendResult(tx: PoolClient, row: Row, error: GatewayError | null): Promise<void> {
    const release = { lease_owner: null, lease_until: null } as const;
    if (!error) {
      await updateOutbound(tx, row, { phase: 'accepted', ...release });
      return;
    }
    if (error.outcome === 'unknown') {
      const now = Date.now();
      // After a gateway 504 the result converges within the window; after our own timeout or a
      // dropped connection the request may still be in flight at the gateway, so wait longer.
      const wait = error.status === 504 ? this.opts.confirmWindowMs : this.opts.sendTimeoutMs + this.opts.confirmWindowMs;
      await updateOutbound(tx, row, {
        phase: 'unknown',
        unknown_since: new Date(now),
        confirm_after: new Date(now + wait),
        next_attempt_at: new Date(now + Math.min(this.opts.recheckMs, wait)),
        ...release,
      });
      return;
    }
    // Definitely not applied.
    if (error.code === 'RATE_LIMITED') {
      await updateOutbound(tx, row, this.requeuePatch(row, null));
      const retryAfter = Number(error.body.retryAfterSeconds);
      await markRateLimited(tx, row.account_id!, Number.isFinite(retryAfter) ? retryAfter : 1, 'gateway_error');
      return;
    }
    if (error.unavailable) {
      await updateOutbound(tx, row, this.requeuePatch(row, new Date(Date.now() + UNAVAILABLE_BACKOFF_MS)));
      return;
    }
    await updateOutbound(tx, row, { phase: 'failed', fail_code: error.code, ...release });
    await applyGatewayFailureConsequences(tx, row, error.code);
  }

  /**
   * Back to the queue after a request that provably did not send anything. A first attempt goes back
   * to `queued` (keeping its place, since it is still the account's oldest). A resend stays in the
   * reconciler as `unknown` (already confirmed unsent) so it is retried without re-queuing.
   */
  private requeuePatch(row: Row, notBefore: Date | null) {
    const base = { lease_owner: null, lease_until: null, attempt: row.attempt - 1, next_attempt_at: notBefore } as const;
    if (row.phase === 'resending') {
      return { ...base, phase: 'unknown' as const, confirm_after: new Date(), next_attempt_at: notBefore ?? new Date() };
    }
    return { ...base, phase: 'queued' as const, dispatch_started_at: null };
  }

  // ------------------------------------------------------------------ reconcile

  private async claimUnknown(): Promise<Row[]> {
    const lease = this.leaseClaimable();
    const { rows } = await this.opts.pool.query<Row>(
      `UPDATE messages m SET lease_owner = $1, lease_until = now() + interval '15 seconds'
         FROM groups g
        WHERE g.id = m.group_id AND m.id IN (
          SELECT id FROM messages
           WHERE phase = 'unknown' AND (next_attempt_at IS NULL OR next_attempt_at <= now())
             AND ${lease.sql}
           ORDER BY id LIMIT 20 FOR UPDATE SKIP LOCKED)
       RETURNING m.*, g.gateway_group_id`,
      lease.params,
    );
    return rows;
  }

  /** Resolves an `unknown` message: sent (found), still unknown, re-send once, or failed. */
  private async reconcile(row: Row): Promise<void> {
    const { gateway, pool, recheckMs, instanceId, sendTimeoutMs } = this.opts;
    let found: { msgId: string; sentAt: string } | null;
    try {
      found = await gateway.byClientId(row.gateway_group_id, row.client_msg_id!);
    } catch (err) {
      // Lookup unavailable: stay unknown and keep trying.
      await this.releaseUnknown(row, new Date(Date.now() + recheckMs));
      return;
    }
    const resend = await withTx(pool, async (tx) => {
      const cur = await this.lockOwned(tx, row, ['unknown']);
      if (!cur) return null;
      const release = { lease_owner: null, lease_until: null } as const;
      if (found) {
        await markSent(tx, cur, cur.gateway_group_id, found.msgId, new Date(found.sentAt));
        return null;
      }
      const now = Date.now();
      const confirmAt = cur.confirm_after?.getTime() ?? now;
      if (now < confirmAt) {
        await updateOutbound(tx, cur, { ...release, next_attempt_at: new Date(Math.min(now + recheckMs, confirmAt)) });
        return null;
      }
      // Proven not sent from here on.
      if (cur.attempt >= MAX_ATTEMPTS) {
        await updateOutbound(tx, cur, { ...release, phase: 'failed', fail_code: 'NETWORK_TIMEOUT' });
        return null;
      }
      const { rows: ctx } = await tx.query<{ status: string; rate_limited_until: Date | null; group_status: string }>(
        `SELECT a.status, a.rate_limited_until, g.status AS group_status
           FROM accounts a, groups g WHERE a.id = $1 AND g.id = $2`,
        [cur.account_id, cur.group_id],
      );
      const { status, rate_limited_until, group_status } = ctx[0]!;
      if (status === 'suspended' || status === 'session_expired') {
        await updateOutbound(tx, cur, { ...release, phase: 'cancelled', fail_code: 'ACCOUNT_TERMINAL' });
        return null;
      }
      if (status === 'idle' || status === 'disconnected') {
        await updateOutbound(tx, cur, { ...release, phase: 'failed', fail_code: 'ACCOUNT_OFFLINE' });
        return null;
      }
      if (group_status === 'unreachable') {
        await updateOutbound(tx, cur, { ...release, phase: 'cancelled', fail_code: 'GROUP_UNREACHABLE' });
        return null;
      }
      if (status === 'rate_limited' || (rate_limited_until && rate_limited_until.getTime() > now)) {
        const until = Math.max(rate_limited_until?.getTime() ?? 0, now + recheckMs);
        await updateOutbound(tx, cur, { ...release, next_attempt_at: new Date(until) });
        return null;
      }
      await updateOutbound(tx, cur, {
        phase: 'resending',
        attempt: cur.attempt + 1,
        dispatch_started_at: new Date(now),
        lease_owner: instanceId,
        lease_until: new Date(now + sendTimeoutMs + 5_000),
      });
      return cur;
    });
    if (resend) await this.dispatch(resend);
  }

  private async releaseUnknown(row: Row, next: Date) {
    await withTx(this.opts.pool, async (tx) => {
      const cur = await this.lockOwned(tx, row, ['unknown']);
      if (cur) await updateOutbound(tx, cur, { lease_owner: null, lease_until: null, next_attempt_at: next });
    });
  }

  /**
   * Crash recovery: a dispatch whose lease expired (or that belonged to this instance's previous
   * incarnation) may or may not have reached the gateway, so it becomes `unknown`.
   */
  private async recoverStale(): Promise<number> {
    const { pool, sendTimeoutMs, confirmWindowMs } = this.opts;
    const lease = this.leaseClaimable();
    return withTx(pool, async (tx) => {
      const { rows } = await tx.query<MessageRow>(
        `SELECT * FROM messages
          WHERE phase IN ('dispatching', 'resending') AND ${lease.sql}
          ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED`,
        lease.params,
      );
      for (const r of rows) {
        const started = r.dispatch_started_at?.getTime() ?? Date.now();
        await updateOutbound(tx, r, {
          phase: 'unknown',
          unknown_since: new Date(),
          confirm_after: new Date(Math.max(Date.now(), started + sendTimeoutMs + confirmWindowMs)),
          next_attempt_at: new Date(),
          lease_owner: null,
          lease_until: null,
        });
      }
      if (rows.length) this.opts.log.info({ count: rows.length }, 'recovered interrupted dispatches as unknown');
      return rows.length;
    });
  }

  /** Echoes never matched to an outbound row (sent outside this system) become ordinary own messages. */
  private async revealOrphanEchoes(): Promise<void> {
    await withTx(this.opts.pool, async (tx) => {
      const { rows } = await tx.query<MessageRow>(
        `UPDATE messages SET echo_pending = false, updated_at = now()
          WHERE echo_pending AND created_at < now() - make_interval(secs => $1)
          RETURNING *`,
        [this.opts.orphanEchoMs / 1000],
      );
      for (const r of rows) await emitMessageEvent(tx, r);
    });
  }

  /** Locks the row if it is still in one of `phases` and not leased to another instance. */
  private async lockOwned(tx: PoolClient, row: Row, phases: string[]): Promise<Row | null> {
    const { rows } = await tx.query<MessageRow>('SELECT * FROM messages WHERE id = $1 FOR UPDATE', [row.id]);
    const cur = rows[0];
    if (!cur || !phases.includes(cur.phase ?? '')) return null;
    if (cur.lease_owner && cur.lease_owner !== this.opts.instanceId) return null;
    return { ...cur, gateway_group_id: row.gateway_group_id };
  }
}

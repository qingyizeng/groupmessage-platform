import type { Queryable } from '../../db/pool';
import { sleep } from '../../lib/async';
import { GatewayError } from '../../integrations/gatewayClient';

export type GatewayResult<T> = { ok: true; value: T } | { ok: false; code: string; error: GatewayError };

/**
 * Calls the gateway, retrying while it is unavailable (503 / connection refused) and, when
 * `retryUnknown` is set, after unknown outcomes. Other errors are returned, not thrown.
 */
export async function gatewayRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; retryUnknown?: boolean } = {},
): Promise<GatewayResult<T>> {
  const attempts = opts.attempts ?? 5;
  for (let i = 1; ; i++) {
    try {
      return { ok: true, value: await fn() };
    } catch (err) {
      if (!(err instanceof GatewayError)) throw err;
      const retryable = err.unavailable || (opts.retryUnknown && err.outcome === 'unknown');
      if (!retryable || i >= attempts) return { ok: false, code: err.code, error: err };
      await sleep(300 * 2 ** (i - 1));
    }
  }
}

/** Polls `check` until it is true or `deadline` (epoch ms) passes. */
export async function waitUntil(
  check: () => Promise<boolean>,
  deadline: number,
  signal: AbortSignal,
  intervalMs = 100,
): Promise<boolean> {
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline || signal.aborted) return false;
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())), signal);
  }
}

export async function isServiceMember(db: Queryable, groupId: string, accountId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    'SELECT 1 FROM group_members WHERE group_id = $1 AND account_id = $2 AND present',
    [groupId, accountId],
  );
  return Boolean(rowCount);
}

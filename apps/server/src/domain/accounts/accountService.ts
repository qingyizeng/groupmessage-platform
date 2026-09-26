import { canTransition, ErrorCode, type AccountStatus } from '@gmp/shared';
import type { Pool, Queryable } from '../../db/pool';
import { withTx } from '../../db/tx';
import { AppError, conflict, notFound } from '../../http/errors';
import { GatewayError, isGatewayError, type GatewayClient } from '../../integrations/gatewayClient';
import type { Logger } from '../../lib/logger';
import { toIso } from '../../lib/time';
import { scheduleTask, cancelTask, type Task } from '../tasks/scheduledTasks';
import {
  applyTransition,
  enterTerminal,
  expireRateLimit,
  lockAccount,
  LockNotAvailableError,
  terminalStatusForGatewayCode,
  type AccountRow,
} from './transitions';

export interface AccountDto {
  id: string;
  status: AccountStatus;
  platformUserId: string | null;
  rateLimitedUntil: string | null;
}

const toDto = (r: AccountRow): AccountDto => ({
  id: r.id,
  status: r.status,
  platformUserId: r.platform_user_id,
  rateLimitedUntil: toIso(r.rate_limited_until),
});

const MANUAL_RATE_LIMIT_SECONDS = 60;

type ConnectOutcome = { ok: true } | { ok: false; error: AppError };

export class AccountService {
  constructor(private readonly deps: { pool: Pool; gateway: GatewayClient; log: Logger }) {}

  async list(): Promise<AccountDto[]> {
    const { rows } = await this.deps.pool.query<AccountRow>(
      'SELECT id, status, platform_user_id, rate_limited_until FROM accounts ORDER BY id',
    );
    return rows.map(toDto);
  }

  async connect(accountId: string): Promise<{ status: AccountStatus; platformUserId: string | null }> {
    return this.mutate(accountId, () => undefined, async (tx, row) => {
      if (row.status !== 'idle' && row.status !== 'disconnected') {
        throw conflict(ErrorCode.ILLEGAL_TRANSITION, `Cannot connect an account in status ${row.status}`, {
          currentStatus: row.status,
        });
      }
      return this.connectLocked(tx, row);
    });
  }

  /**
   * Operator-requested transition with compare-and-set semantics. The row is locked with NOWAIT, so
   * a concurrent change to the same account fails fast with CAS_CONFLICT instead of overwriting.
   */
  async operatorTransition(accountId: string, to: AccountStatus, expectedFrom: AccountStatus) {
    const precheck = () => {
      if (!canTransition(expectedFrom, to)) {
        throw conflict(ErrorCode.ILLEGAL_TRANSITION, `Transition ${expectedFrom} -> ${to} is not allowed`);
      }
    };
    return this.mutate(accountId, precheck, async (tx, row): Promise<ConnectOutcome> => {
      if (row.status !== expectedFrom) {
        throw conflict(ErrorCode.CAS_CONFLICT, `Account status is ${row.status}, not ${expectedFrom}`, {
          currentStatus: row.status,
        });
      }
      if (to === 'online' && row.status !== 'rate_limited') return this.connectLocked(tx, row);

      const extra =
        to === 'rate_limited' ? { rateLimitedUntil: new Date(Date.now() + MANUAL_RATE_LIMIT_SECONDS * 1000) } : {};
      await applyTransition(tx, row, to, 'operator', extra);
      if (to === 'disconnected' || to === 'idle') {
        await scheduleTask(tx, 'gateway_disconnect', row.id, null);
      }
      return { ok: true };
    });
  }

  /** Task handler: tells the gateway an account went offline, if it still is offline in our records. */
  handleDisconnectTask = async (task: Task): Promise<void> => {
    await withTx(this.deps.pool, async (tx) => {
      const row = await lockAccount(tx, task.ref);
      if (!row || (row.status !== 'idle' && row.status !== 'disconnected')) return;
      try {
        await this.deps.gateway.disconnect(row.id);
      } catch (err) {
        const terminal = isGatewayError(err) ? terminalStatusForGatewayCode(err.code) : null;
        if (!terminal) throw err;
        await applyTransition(tx, row, terminal, 'gateway_error');
      }
    });
  };

  handleRateLimitExpiry = async (task: Task): Promise<void> => {
    await withTx(this.deps.pool, (tx) => expireRateLimit(tx, task.ref));
  };

  /** Gateway `account_status` event. */
  async onGatewayAccountStatus(tx: Queryable, accountId: string, status: string): Promise<void> {
    if (status !== 'suspended' && status !== 'session_expired') {
      this.deps.log.warn({ accountId, status }, 'ignoring unknown account_status');
      return;
    }
    const result = await enterTerminal(tx, accountId, status, 'gateway_event');
    if (result === 'not_found') this.deps.log.warn({ accountId }, 'account_status for unknown account');
  }

  private async connectLocked(tx: Queryable, row: AccountRow): Promise<ConnectOutcome> {
    let platformUserId: string;
    try {
      ({ platformUserId } = await this.deps.gateway.connect(row.id));
    } catch (err) {
      if (!(err instanceof GatewayError)) throw err;
      const terminal = terminalStatusForGatewayCode(err.code);
      if (terminal) {
        await applyTransition(tx, row, terminal, 'gateway_error');
        return {
          ok: false,
          error: conflict(ErrorCode.ACCOUNT_UNAVAILABLE, `Gateway reports ${err.code}`, {
            gatewayCode: err.code,
            status: terminal,
          }),
        };
      }
      throw new AppError(502, ErrorCode.GATEWAY_ERROR, `Gateway connect failed: ${err.code}`, { gatewayCode: err.code });
    }
    await cancelTask(tx, 'gateway_disconnect', row.id);
    await applyTransition(tx, row, 'online', 'operator', { platformUserId });
    return { ok: true };
  }

  /**
   * Checks existence (404), then `precheck` (request-level validation such as ILLEGAL_TRANSITION),
   * then locks the account with NOWAIT and runs `fn`. An outcome carrying an error is committed
   * first (e.g. a terminal status learned from the gateway) and then thrown.
   */
  private async mutate(
    accountId: string,
    precheck: () => void,
    fn: (tx: Queryable, row: AccountRow) => Promise<ConnectOutcome>,
  ): Promise<{ status: AccountStatus; platformUserId: string | null }> {
    const exists = await this.deps.pool.query('SELECT 1 FROM accounts WHERE id = $1', [accountId]);
    if (exists.rowCount === 0) throw notFound(ErrorCode.ACCOUNT_NOT_FOUND, `Account ${accountId} not found`);
    precheck();
    const { outcome, row } = await withTx(this.deps.pool, async (tx) => {
      let locked: AccountRow | undefined;
      try {
        locked = await lockAccount(tx, accountId, 'nowait');
      } catch (err) {
        if (err instanceof LockNotAvailableError) {
          throw conflict(ErrorCode.CAS_CONFLICT, 'Account is being modified concurrently');
        }
        throw err;
      }
      if (!locked) throw notFound(ErrorCode.ACCOUNT_NOT_FOUND, `Account ${accountId} not found`);
      return { outcome: await fn(tx, locked), row: locked };
    });
    if (!outcome.ok) throw outcome.error;
    return { status: row.status, platformUserId: row.platform_user_id };
  }
}

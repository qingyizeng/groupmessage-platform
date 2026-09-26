import type { AppContext } from '../context';
import type { EventHandlers } from './inboxProcessor';

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * Gateway event type → handler. Every handler must be idempotent and must not depend on the order
 * in which events arrive (see docs/architecture.md §5.1). Types without a handler are marked done.
 */
export function createEventHandlers(ctx: AppContext): EventHandlers {
  return {
    account_status: async (tx, evt) => {
      const accountId = str(evt.data.accountId);
      const status = str(evt.data.status);
      if (!accountId || !status) throw new Error('account_status event missing accountId/status');
      await ctx.accounts.onGatewayAccountStatus(tx, accountId, status);
    },
  };
}

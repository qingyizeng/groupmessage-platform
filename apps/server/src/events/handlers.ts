import type { AppContext } from '../context';
import { applyMemberEvent, findGroupByGatewayId } from '../domain/groups/groupRepo';
import { onMessageEvent, onMessageFailed, onMessageSent } from '../domain/messages/inbound';
import { MalformedEventError, type EventHandlers } from './inboxProcessor';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

/**
 * Gateway event type → handler. Every handler must be idempotent and must not depend on the order
 * in which events arrive (see docs/architecture.md §5.1). Types without a handler are marked done.
 */
export function createEventHandlers(ctx: AppContext): EventHandlers {
  const log = ctx.log.child({ component: 'event-handlers' });

  const member = (present: boolean) =>
    (async (tx, evt) => {
      const gatewayGroupId = str(evt.data.groupId);
      const platformUserId = str(evt.data.platformUserId);
      if (!gatewayGroupId || !platformUserId) throw new MalformedEventError(`${evt.type} event missing groupId/platformUserId`);
      const group = await findGroupByGatewayId(tx, gatewayGroupId);
      if (!group) return;
      await applyMemberEvent(tx, group, platformUserId, present, evt.eventId);
    }) satisfies EventHandlers[string];

  return {
    account_status: async (tx, evt) => {
      const accountId = str(evt.data.accountId);
      const status = str(evt.data.status);
      if (!accountId || !status) throw new MalformedEventError('account_status event missing accountId/status');
      await ctx.accounts.onGatewayAccountStatus(tx, accountId, status);
    },
    message: (tx, evt) => onMessageEvent(tx, evt.data, log),
    message_sent: (tx, evt) => onMessageSent(tx, evt.data, log),
    message_failed: (tx, evt) => onMessageFailed(tx, evt.data, log),
    member_joined: member(true),
    member_left: member(false),
  };
}

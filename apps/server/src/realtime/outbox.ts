import type { WsEventPayloads, WsEventType } from '@gmp/shared';
import type { Queryable } from '../db/pool';

export const OUTBOX_CHANNEL = 'ws_outbox';

/**
 * Queues a WebSocket event inside the caller's transaction. It becomes visible to the publisher
 * (and therefore to clients) only if that transaction commits, so every pushed event reflects
 * saved state.
 */
export async function emitWs<T extends WsEventType>(tx: Queryable, type: T, payload: WsEventPayloads[T]): Promise<void> {
  await tx.query('INSERT INTO ws_outbox (type, payload) VALUES ($1, $2)', [type, JSON.stringify(payload)]);
  await tx.query(`NOTIFY ${OUTBOX_CHANNEL}`);
}

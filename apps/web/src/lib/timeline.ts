import type { MessageDto } from '@gmp/shared';

/**
 * Client-side timeline: rows keyed by their stable id, so a page load and a live push of the same
 * message (or its later status change) collapse into one row. Rows that move in time (own
 * messages get the gateway's sentAt; backfilled messages arrive with old timestamps) are simply
 * re-sorted.
 */
export interface TimelineState {
  byId: Map<number, MessageDto>;
  /** Cursor for "load earlier"; null when the oldest page has been loaded. */
  cursor: string | null;
  loaded: boolean;
}

export const emptyTimeline = (): TimelineState => ({ byId: new Map(), cursor: null, loaded: false });

export function addPage(state: TimelineState, items: MessageDto[], nextCursor: string | null): TimelineState {
  const byId = new Map(state.byId);
  for (const m of items) {
    // A live push may be fresher than the page query; on a tie keep what we have.
    const existing = byId.get(m.id);
    if (!existing || rank(m) > rank(existing)) byId.set(m.id, m);
  }
  return { byId, cursor: nextCursor, loaded: true };
}

export function applyLive(state: TimelineState, message: MessageDto, replacesId?: number): TimelineState {
  const byId = new Map(state.byId);
  if (replacesId !== undefined) byId.delete(replacesId);
  byId.set(message.id, message);
  return { ...state, byId };
}

/** Oldest first, as a chat is read. */
export function ordered(state: TimelineState): MessageDto[] {
  return [...state.byId.values()].sort((a, b) => {
    const t = Date.parse(a.sentAt) - Date.parse(b.sentAt);
    return t !== 0 ? t : a.id - b.id;
  });
}

const RANK: Record<string, number> = { queued: 0, unknown: 1, accepted: 2, sent: 3, failed: 3, cancelled: 3 };
const rank = (m: MessageDto) => (m.deliveryStatus ? (RANK[m.deliveryStatus] ?? 0) : 3);

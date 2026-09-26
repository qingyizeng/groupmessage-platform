import { describe, expect, it } from 'vitest';
import type { MessageDto } from '@gmp/shared';
import { addPage, applyLive, emptyTimeline, ordered } from './timeline';

const msg = (id: number, sentAt: string, extra: Partial<MessageDto> = {}): MessageDto => ({
  id,
  msgId: `m${id}`,
  clientMsgId: null,
  senderPlatformUserId: 'pu',
  accountId: null,
  isOwn: false,
  text: `t${id}`,
  sentAt,
  deliveryStatus: null,
  failCode: null,
  mediaUrl: null,
  mediaStatus: null,
  source: null,
  ...extra,
});

describe('timeline state', () => {
  it('merges pages and live pushes without duplicates, ordered by (sentAt, id)', () => {
    let s = addPage(emptyTimeline(), [msg(3, '2026-01-01T00:00:03Z'), msg(2, '2026-01-01T00:00:02Z')], 'c1');
    s = applyLive(s, msg(4, '2026-01-01T00:00:04Z'));
    s = applyLive(s, msg(3, '2026-01-01T00:00:03Z'));
    s = addPage(s, [msg(1, '2026-01-01T00:00:01Z'), msg(5, '2026-01-01T00:00:01Z')], null);
    expect(ordered(s).map((m) => m.id)).toEqual([1, 5, 2, 3, 4]);
    expect(s.cursor).toBeNull();
  });

  it('keeps the newer live status when an older page arrives later', () => {
    let s = applyLive(emptyTimeline(), msg(7, '2026-01-01T00:00:07Z', { isOwn: true, deliveryStatus: 'sent' }));
    s = addPage(s, [msg(7, '2026-01-01T00:00:06Z', { isOwn: true, deliveryStatus: 'queued' })], null);
    expect(ordered(s)[0]!.deliveryStatus).toBe('sent');
  });

  it('removes a row that a merge replaced', () => {
    let s = applyLive(emptyTimeline(), msg(10, '2026-01-01T00:00:10Z', { isOwn: true }));
    s = applyLive(s, msg(11, '2026-01-01T00:00:10Z', { isOwn: true, deliveryStatus: 'sent' }), 10);
    expect(ordered(s).map((m) => m.id)).toEqual([11]);
  });
});

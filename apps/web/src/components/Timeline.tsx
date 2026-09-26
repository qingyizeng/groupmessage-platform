import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { App, Button, Empty, Space, Tag, Tooltip, Typography } from 'antd';
import type { MessageDto } from '@gmp/shared';
import { api, http } from '../api/client';
import { useRealtime } from '../realtime/RealtimeProvider';
import { addPage, applyLive, emptyTimeline, ordered, type TimelineState } from '../lib/timeline';
import { DELIVERY_COLOR, errorText, fmtTime } from '../lib/format';

type Action =
  | { type: 'reset' }
  | { type: 'page'; items: MessageDto[]; nextCursor: string | null }
  | { type: 'live'; message: MessageDto; replacesId?: number };

function reducer(state: TimelineState, a: Action): TimelineState {
  switch (a.type) {
    case 'reset':
      return emptyTimeline();
    case 'page':
      return addPage(state, a.items, a.nextCursor);
    case 'live':
      return applyLive(state, a.message, a.replacesId);
  }
}

/** Oldest at the top ("load earlier" above), newest at the bottom; live pushes are merged in place. */
export function Timeline({ groupId }: { groupId: string }) {
  const [state, dispatch] = useReducer(reducer, undefined, emptyTimeline);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { subscribe, resyncCount } = useRealtime();
  const bottom = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const load = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      setError(null);
      try {
        const page = await api.messages(groupId, cursor);
        dispatch({ type: 'page', items: page.items, nextCursor: page.nextCursor });
      } catch (err) {
        setError(errorText(err));
      } finally {
        setLoading(false);
      }
    },
    [groupId],
  );

  // Subscribe before the first page is requested, so nothing pushed in between is lost.
  useEffect(() => {
    dispatch({ type: 'reset' });
    stickToBottom.current = true;
    const off = subscribe((frame) => {
      if (frame.type !== 'message') return;
      const p = frame.payload as { groupId: string; message?: MessageDto; replacesId?: number };
      if (p.groupId === groupId && p.message) dispatch({ type: 'live', message: p.message, replacesId: p.replacesId });
    });
    void load();
    return off;
  }, [groupId, load, subscribe, resyncCount]);

  const messages = ordered(state);
  useEffect(() => {
    if (stickToBottom.current) bottom.current?.scrollIntoView({ block: 'nearest' });
  }, [messages.length]);

  return (
    <div>
      <div style={{ textAlign: 'center', marginBottom: 8 }}>
        {state.cursor ? (
          <Button
            size="small"
            loading={loading}
            onClick={() => {
              stickToBottom.current = false;
              void load(state.cursor!);
            }}
            data-testid="load-earlier"
          >
            加载更早
          </Button>
        ) : (
          state.loaded && <Typography.Text type="secondary">没有更早的消息了</Typography.Text>
        )}
        {error && <Typography.Text type="danger"> {error}</Typography.Text>}
      </div>
      <div style={{ maxHeight: 460, overflowY: 'auto', padding: '0 4px' }} data-testid="timeline">
        {state.loaded && messages.length === 0 && <Empty description="暂无消息" />}
        {messages.map((m) => (
          <MessageRow key={m.id} m={m} />
        ))}
        <div ref={bottom} />
      </div>
    </div>
  );
}

const MEDIA_LABEL: Record<string, { color: string; text: string }> = {
  pending: { color: 'processing', text: '附件下载中' },
  downloaded: { color: 'green', text: '附件' },
  expired: { color: 'default', text: '附件已过期' },
  failed: { color: 'red', text: '附件下载失败' },
  deleted: { color: 'default', text: '附件已清理' },
};

function MediaBadge({ m }: { m: MessageDto }) {
  const { message } = App.useApp();
  const label = MEDIA_LABEL[m.mediaStatus ?? 'pending']!;
  const open = async () => {
    try {
      const blob = await http.blob(`/api/messages/${m.id}/media`);
      window.open(URL.createObjectURL(blob), '_blank', 'noopener');
    } catch (err) {
      message.error(errorText(err));
    }
  };
  return (
    <div style={{ marginTop: 4 }}>
      <Tag color={label.color} data-testid="media-status">
        {label.text}
      </Tag>
      {m.mediaStatus === 'downloaded' && (
        <Button size="small" type="link" onClick={() => void open()}>
          查看
        </Button>
      )}
    </div>
  );
}

function MessageRow({ m }: { m: MessageDto }) {
  return (
    <div
      data-testid="timeline-message"
      style={{ display: 'flex', justifyContent: m.isOwn ? 'flex-end' : 'flex-start', margin: '6px 0' }}
    >
      <div
        style={{
          maxWidth: '75%',
          background: m.isOwn ? '#e6f4ff' : '#fafafa',
          border: '1px solid #f0f0f0',
          borderRadius: 8,
          padding: '6px 10px',
        }}
      >
        <Space size={6} wrap style={{ fontSize: 12 }}>
          <Typography.Text type="secondary">{m.isOwn ? (m.accountId ?? '我方') : m.senderPlatformUserId}</Typography.Text>
          <Typography.Text type="secondary">{fmtTime(m.sentAt)}</Typography.Text>
          {m.isOwn && m.deliveryStatus && (
            <Tooltip title={m.failCode ? `failCode: ${m.failCode}` : undefined}>
              <Tag color={DELIVERY_COLOR[m.deliveryStatus]} style={{ marginInlineEnd: 0 }} data-testid="delivery-status">
                {m.deliveryStatus}
                {m.failCode ? ` · ${m.failCode}` : ''}
              </Tag>
            </Tooltip>
          )}
          {m.source === 'agent' && <Tag color="purple">agent</Tag>}
          {m.source === 'sequence' && <Tag color="cyan">序列</Tag>}
        </Space>
        <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.text}</div>
        {m.mediaUrl && <MediaBadge m={m} />}
      </div>
    </div>
  );
}

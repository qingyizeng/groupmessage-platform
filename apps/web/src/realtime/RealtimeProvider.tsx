import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { notification } from 'antd';
import type { WsEventFrame } from '@gmp/shared';
import { http } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { RealtimeClient, type ConnectionState } from './ws';

type Listener = (frame: WsEventFrame) => void;

interface RealtimeState {
  state: ConnectionState;
  subscribe(listener: Listener): () => void;
  /** Incremented on resync; views holding their own state reload when it changes. */
  resyncCount: number;
}

const RealtimeContext = createContext<RealtimeState | null>(null);

/**
 * Connects /ws while logged in and turns events into cache invalidations. Components with local
 * state (the timeline) subscribe to raw frames instead.
 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const listeners = useRef(new Set<Listener>());
  const [state, setState] = useState<ConnectionState>('closed');
  const [resyncCount, setResyncCount] = useState(0);

  useEffect(() => {
    if (!user) return;
    const client = new RealtimeClient({
      url: `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`,
      getToken: () => http.accessToken,
      refreshToken: () => http.refresh(),
      onState: setState,
      onResync: () => {
        void queryClient.invalidateQueries();
        setResyncCount((n) => n + 1);
      },
      onEvent: (frame) => {
        routeEvent(frame, queryClient);
        for (const l of listeners.current) l(frame);
      },
    });
    const offToken = http.onToken((token) => client.updateToken(token));
    client.start();
    return () => {
      offToken();
      client.stop();
      setState('closed');
    };
  }, [user, queryClient]);

  // Stable identity: consumers use it in effect dependencies.
  const subscribe = useCallback((listener: Listener) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);
  const value = useMemo(() => ({ state, subscribe, resyncCount }), [state, subscribe, resyncCount]);

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

function routeEvent(frame: WsEventFrame, qc: ReturnType<typeof useQueryClient>) {
  const p = frame.payload as Record<string, any>;
  switch (frame.type) {
    case 'account_status_changed':
    case 'account_terminal':
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      if (frame.type === 'account_terminal') {
        notification.warning({ message: `账号 ${p.accountId} 已进入终态：${p.status}` });
      }
      break;
    case 'group_changed':
      void qc.invalidateQueries({ queryKey: ['groups'] });
      void qc.invalidateQueries({ queryKey: ['group', p.groupId] });
      break;
    case 'job_changed':
      void qc.invalidateQueries({ queryKey: ['job', p.jobId] });
      break;
    case 'agent_run':
      void qc.invalidateQueries({ queryKey: ['agentRuns', p.groupId] });
      void qc.invalidateQueries({ queryKey: ['agentRun', p.runId] });
      void qc.invalidateQueries({ queryKey: ['group', p.groupId] });
      if (p.status === 'blocked') {
        notification.error({ message: 'Agent run 被审计阻断', description: `run ${p.runId}：审计 3 次未给出结论，已停止。` });
      }
      break;
    case 'agent_step':
      void qc.invalidateQueries({ queryKey: ['agentRun', p.runId] });
      void qc.invalidateQueries({ queryKey: ['agentRuns', p.groupId] });
      break;
    case 'sequence_run':
      void qc.invalidateQueries({ queryKey: ['sequenceRun', p.runId] });
      void qc.invalidateQueries({ queryKey: ['sequenceRuns', p.groupId] });
      void qc.invalidateQueries({ queryKey: ['group', p.groupId] });
      break;
    case 'inconsistency':
      notification.warning({ message: `数据不一致：${p.kind}`, description: p.message, duration: 8 });
      break;
  }
}

export function useRealtime(): RealtimeState {
  const ctx = useContext(RealtimeContext);
  if (!ctx) throw new Error('useRealtime outside RealtimeProvider');
  return ctx;
}

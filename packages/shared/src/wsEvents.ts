import type { AccountStatus } from './accountTransitions';

/** Payloads of server → client WebSocket events, keyed by `type`. */
export interface WsEventPayloads {
  account_status_changed: { accountId: string; from: AccountStatus; to: AccountStatus; source: string };
  account_terminal: { accountId: string; status: AccountStatus };
  inconsistency: { kind: string; ref: string; message: string };
  message: { groupId: string; msgId: string | null; isOwn: boolean; [extra: string]: unknown };
  agent_run: { runId: string; groupId: string; status: string; endReason: string | null };
  sequence_run: { runId: string; groupId: string; status: string; currentStepIndex: number | null };
  group_changed: { groupId: string };
  job_changed: { jobId: string; status: string };
}

export type WsEventType = keyof WsEventPayloads;

export interface WsEventFrame<T extends WsEventType = WsEventType> {
  seq: number;
  type: T;
  payload: WsEventPayloads[T];
}

/** Client → server. */
export interface WsAuthMessage {
  type: 'auth';
  accessToken: string;
  sinceSeq?: number;
}

/** Server → client control frames (no seq). */
export type WsControlFrame =
  | { type: 'auth'; success: true }
  | { type: 'auth'; success: false; error: string }
  | { type: 'resync_required'; latestSeq: number };

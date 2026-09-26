import dayjs from 'dayjs';
import { ApiError } from '../api/http';

export const fmtTime = (iso: string | null | undefined) => (iso ? dayjs(iso).format('MM-DD HH:mm:ss.SSS') : '—');

export function errorText(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}：${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

export const ACCOUNT_STATUS_COLOR: Record<string, string> = {
  idle: 'default',
  online: 'green',
  rate_limited: 'orange',
  disconnected: 'default',
  suspended: 'red',
  session_expired: 'red',
};

export const DELIVERY_COLOR: Record<string, string> = {
  queued: 'default',
  accepted: 'blue',
  sent: 'green',
  unknown: 'orange',
  failed: 'red',
  cancelled: 'red',
};

export const RUN_STATUS_COLOR: Record<string, string> = {
  running: 'processing',
  finished: 'green',
  failed: 'red',
  blocked: 'magenta',
  cancelled: 'default',
};

export const SEQ_RUN_COLOR: Record<string, string> = {
  running: 'processing',
  finished: 'green',
  failed: 'red',
  stopped: 'orange',
};

export const SEQ_STEP_COLOR: Record<string, string> = {
  pending: 'default',
  accepted: 'blue',
  sent: 'green',
  skipped: 'orange',
  failed: 'red',
};

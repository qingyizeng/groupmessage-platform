export const ACCOUNT_STATUSES = [
  'idle',
  'online',
  'rate_limited',
  'disconnected',
  'suspended',
  'session_expired',
] as const;

export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const TERMINAL_STATUSES: readonly AccountStatus[] = ['suspended', 'session_expired'];

const TRANSITIONS: Record<AccountStatus, readonly AccountStatus[]> = {
  idle: ['online', 'suspended', 'session_expired'],
  online: ['idle', 'rate_limited', 'disconnected', 'suspended', 'session_expired'],
  rate_limited: ['online', 'disconnected', 'suspended', 'session_expired'],
  disconnected: ['idle', 'online', 'suspended', 'session_expired'],
  suspended: [],
  session_expired: [],
};

export function isAccountStatus(value: unknown): value is AccountStatus {
  return typeof value === 'string' && (ACCOUNT_STATUSES as readonly string[]).includes(value);
}

export function isTerminalStatus(status: AccountStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function canTransition(from: AccountStatus, to: AccountStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function allowedTransitions(from: AccountStatus): readonly AccountStatus[] {
  return TRANSITIONS[from];
}

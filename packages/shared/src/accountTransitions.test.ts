import { describe, expect, it } from 'vitest';
import { ACCOUNT_STATUSES, canTransition, isTerminalStatus } from './accountTransitions';

describe('account transition table', () => {
  it('matches the spec table exactly', () => {
    const allowed = ACCOUNT_STATUSES.flatMap((from) =>
      ACCOUNT_STATUSES.filter((to) => canTransition(from, to)).map((to) => `${from}->${to}`),
    );
    expect(allowed.sort()).toEqual(
      [
        'idle->online',
        'idle->suspended',
        'idle->session_expired',
        'online->idle',
        'online->rate_limited',
        'online->disconnected',
        'online->suspended',
        'online->session_expired',
        'rate_limited->online',
        'rate_limited->disconnected',
        'rate_limited->suspended',
        'rate_limited->session_expired',
        'disconnected->idle',
        'disconnected->online',
        'disconnected->suspended',
        'disconnected->session_expired',
      ].sort(),
    );
  });

  it('never allows a self transition', () => {
    for (const s of ACCOUNT_STATUSES) expect(canTransition(s, s)).toBe(false);
  });

  it('treats suspended and session_expired as terminal', () => {
    expect(isTerminalStatus('suspended')).toBe(true);
    expect(isTerminalStatus('session_expired')).toBe(true);
    expect(isTerminalStatus('online')).toBe(false);
  });
});

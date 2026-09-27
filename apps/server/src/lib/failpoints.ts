/**
 * Named failure-injection points for tests and demos. `hit(name)` throws while the point is armed.
 * Arming is only possible from tests or the test-hooks endpoint (ENABLE_TEST_HOOKS=true).
 */
const armed = new Map<string, { times: number; code?: string }>();

export class FailpointError extends Error {
  constructor(
    readonly point: string,
    /** Optional SQLSTATE, e.g. '40001' to simulate a serialization failure that withTx retries. */
    readonly code?: string,
  ) {
    super(`failpoint ${point} triggered`);
  }
}

export const failpoints = {
  /** Arms `name` for the next `times` hits (-1 = until cleared). */
  arm(name: string, times = 1, code?: string): void {
    armed.set(name, { times, code });
  },
  clear(name?: string): void {
    if (name) armed.delete(name);
    else armed.clear();
  },
  hit(name: string): void {
    const a = armed.get(name);
    if (!a || a.times === 0) return;
    if (a.times > 0) armed.set(name, { ...a, times: a.times - 1 });
    throw new FailpointError(name, a.code);
  },
};

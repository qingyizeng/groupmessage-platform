/**
 * Named failure-injection points for tests and demos. `hit(name)` throws while the point is armed.
 * Arming is only possible from tests or the test-hooks endpoint (ENABLE_TEST_HOOKS=true).
 */
const armed = new Map<string, number>();

export class FailpointError extends Error {
  constructor(readonly point: string) {
    super(`failpoint ${point} triggered`);
  }
}

export const failpoints = {
  /** Arms `name` for the next `times` hits (-1 = until cleared). */
  arm(name: string, times = 1): void {
    armed.set(name, times);
  },
  clear(name?: string): void {
    if (name) armed.delete(name);
    else armed.clear();
  },
  hit(name: string): void {
    const n = armed.get(name);
    if (n === undefined || n === 0) return;
    if (n > 0) armed.set(name, n - 1);
    throw new FailpointError(name);
  },
};

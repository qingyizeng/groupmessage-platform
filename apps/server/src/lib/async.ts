/** Resolves after `ms`, or early (without throwing) when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * A wake-up signal for polling loops: `wait(ms)` resolves after `ms` or as soon as `wake()` is
 * called. A wake that arrives while nobody is waiting is remembered, so it is never missed.
 */
export class Waker {
  private pending = false;
  private resolvers: (() => void)[] = [];

  wake(): void {
    const rs = this.resolvers;
    this.resolvers = [];
    if (rs.length === 0) this.pending = true;
    for (const r of rs) r();
  }

  wait(ms: number, signal?: AbortSignal): Promise<void> {
    if (this.pending) {
      this.pending = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout;
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        this.resolvers = this.resolvers.filter((r) => r !== done);
        resolve();
      };
      timer = setTimeout(done, ms);
      signal?.addEventListener('abort', done, { once: true });
      this.resolvers.push(done);
    });
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export type LockFn = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

/** Serializes across tabs with the Web Locks API when available, so two tabs never rotate the same refresh token. */
export const browserLock: LockFn = (name, fn) =>
  typeof navigator !== 'undefined' && navigator.locks
    ? (navigator.locks.request(name, fn) as Promise<Awaited<ReturnType<typeof fn>>>)
    : fn();

export interface HttpOptions {
  fetch?: typeof fetch;
  lock?: LockFn;
  onSessionLost?: () => void;
}

/**
 * JSON client with an in-memory access token. On 401 it refreshes once (the refresh token is an
 * HttpOnly cookie) and retries the request. Concurrent 401s share one refresh (single flight);
 * across tabs refreshes are serialized with a Web Lock, and a tab that waited reuses the token
 * another tab just obtained instead of spending its own rotation.
 */
export class HttpClient {
  private token: string | null = null;
  private tokenIssuedAt = 0;
  private refreshing: Promise<string | null> | null = null;
  private listeners = new Set<(token: string | null) => void>();
  private readonly doFetch: typeof fetch;
  private readonly lock: LockFn;
  private readonly channel: BroadcastChannel | null;

  constructor(private readonly opts: HttpOptions = {}) {
    this.doFetch = opts.fetch ?? ((...args) => fetch(...args));
    this.lock = opts.lock ?? browserLock;
    this.channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('gmp-auth') : null;
    this.channel?.addEventListener('message', (e: MessageEvent<{ token: string | null; at: number }>) => {
      if (e.data.at > this.tokenIssuedAt) this.setToken(e.data.token, e.data.at, false);
    });
  }

  get accessToken(): string | null {
    return this.token;
  }

  onToken(listener: (token: string | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setToken(token: string | null, at = Date.now(), broadcast = true): void {
    this.token = token;
    this.tokenIssuedAt = at;
    if (broadcast) this.channel?.postMessage({ token, at });
    for (const l of this.listeners) l(token);
  }

  async login(username: string, password: string): Promise<void> {
    const res = await this.raw('POST', '/api/auth/login', { username, password }, false);
    this.setToken((res as { accessToken: string }).accessToken);
  }

  async logout(): Promise<void> {
    try {
      await this.raw('POST', '/api/auth/logout', undefined, true);
    } finally {
      this.setToken(null);
    }
  }

  /** Obtains a new access token from the refresh cookie; null if the session is gone. */
  refresh(): Promise<string | null> {
    if (!this.refreshing) {
      const startedWith = this.tokenIssuedAt;
      this.refreshing = this.lock('gmp-refresh', async () => {
        // Another tab refreshed while we waited for the lock: use its token.
        if (this.tokenIssuedAt > startedWith && this.token) return this.token;
        try {
          const res = await this.raw('POST', '/api/auth/refresh', undefined, false);
          const token = (res as { accessToken: string }).accessToken;
          this.setToken(token);
          return token;
        } catch (err) {
          if (err instanceof ApiError && err.status === 401) {
            this.setToken(null);
            this.opts.onSessionLost?.();
            return null;
          }
          throw err;
        }
      }).finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }
  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }
  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const sentWith = this.token;
    try {
      return (await this.raw(method, path, body, true)) as T;
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 401) throw err;
      // The token may already have been replaced by a concurrent refresh.
      const token = this.token && this.token !== sentWith ? this.token : await this.refresh();
      if (!token) throw err;
      return (await this.raw(method, path, body, true)) as T;
    }
  }

  private async raw(method: string, path: string, body: unknown, withAuth: boolean): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (withAuth && this.token) headers.authorization = `Bearer ${this.token}`;
    const res = await this.doFetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }
    if (!res.ok) {
      const e = (data as { error?: { code?: string; message?: string } } | null)?.error;
      throw new ApiError(res.status, e?.code ?? `HTTP_${res.status}`, e?.message ?? res.statusText, (e ?? {}) as Record<string, unknown>);
    }
    return data;
  }
}

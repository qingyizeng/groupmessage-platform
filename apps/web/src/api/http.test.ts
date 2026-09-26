import { describe, expect, it } from 'vitest';
import { HttpClient, type LockFn } from './http';

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A fake backend: tokens "t<n>" are valid only for the current n; refresh bumps n. */
function fakeBackend() {
  let current = 1;
  let refreshCalls = 0;
  const fetchImpl = (async (path: string, init?: RequestInit) => {
    await new Promise((r) => setTimeout(r, 5));
    if (path === '/api/auth/refresh') {
      refreshCalls++;
      current++;
      return jsonResponse(200, { accessToken: `t${current}` });
    }
    const auth = (init?.headers as Record<string, string>)?.authorization;
    if (auth !== `Bearer t${current}`) return jsonResponse(401, { error: { code: 'UNAUTHORIZED', message: 'expired' } });
    return jsonResponse(200, { ok: true, path });
  }) as typeof fetch;
  return {
    fetchImpl,
    expire: () => current++,
    get refreshCalls() {
      return refreshCalls;
    },
  };
}

const noLock: LockFn = (_name, fn) => fn();

describe('HttpClient', () => {
  it('refreshes once for many concurrent 401s and retries all of them', async () => {
    const backend = fakeBackend();
    const client = new HttpClient({ fetch: backend.fetchImpl, lock: noLock });
    client.setToken('t1');
    backend.expire();
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => client.get<{ ok: boolean }>(`/api/x/${i}`)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(backend.refreshCalls).toBe(1);
  });

  it('a waiting tab reuses the token another tab obtained', async () => {
    const backend = fakeBackend();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const client = new HttpClient({
      fetch: backend.fetchImpl,
      lock: async (_n, fn) => {
        await gate;
        return fn();
      },
    });
    client.setToken('t1', 1);
    const pending = client.refresh();
    client.setToken('t9', Date.now(), false);
    release();
    expect(await pending).toBe('t9');
    expect(backend.refreshCalls).toBe(0);
  });

  it('reports a lost session when refresh is rejected', async () => {
    let lost = false;
    const client = new HttpClient({
      fetch: (async () => jsonResponse(401, { error: { code: 'UNAUTHORIZED', message: 'no' } })) as typeof fetch,
      lock: noLock,
      onSessionLost: () => (lost = true),
    });
    client.setToken('t1');
    await expect(client.get('/api/x')).rejects.toMatchObject({ status: 401 });
    expect(lost).toBe(true);
    expect(client.accessToken).toBeNull();
  });
});

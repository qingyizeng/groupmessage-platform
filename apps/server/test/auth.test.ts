import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectedSchemaVersion } from '../src/db/migrate';
import { createTestApp, login, type TestApp } from './helpers/app';

describe('auth, sessions and RBAC', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  const get = (url: string, token?: string) =>
    t.app.inject({ method: 'GET', url, headers: token ? { authorization: `Bearer ${token}` } : {} });

  it('health is public and reports the schema version', async () => {
    const res = await get('/api/health');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, schemaVersion: expectedSchemaVersion() });
  });

  it('errors use the uniform envelope with a requestId', async () => {
    const res = await get('/api/auth/me');
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error.code).toBe('UNAUTHORIZED');
    expect(typeof body.error.requestId).toBe('string');
    expect(res.headers['x-request-id']).toBe(body.error.requestId);

    const bad = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects wrong credentials with 401', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'nope' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  it('login returns an access token and sets an HttpOnly refresh cookie only', async () => {
    const { res, accessToken } = await login(t.app, 'admin');
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json())).toEqual(['accessToken']);
    const cookie = res.cookies.find((c) => c.name === 'rt')!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.path).toBe('/api/auth');
    expect((await get('/api/auth/me', accessToken)).json()).toEqual({ username: 'admin', role: 'admin' });
  });

  it('viewer gets 403 FORBIDDEN on any write, even to unknown routes', async () => {
    const { accessToken } = await login(t.app, 'viewer');
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/accounts/acc_01/connect',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    expect((await get('/api/auth/me', accessToken)).statusCode).toBe(200);
  });

  it('access token expires after 15 minutes', async () => {
    const { accessToken } = await login(t.app, 'admin');
    t.clock.advance(15 * 60 * 1000 + 1000);
    const res = await get('/api/auth/me', accessToken);
    expect(res.statusCode).toBe(401);
  });

  it('refresh rotates the token; reusing an old one revokes the whole session', async () => {
    const first = await login(t.app, 'admin');
    const refresh = (rt: string) =>
      t.app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { rt } });

    const r1 = await refresh(first.refreshToken);
    expect(r1.statusCode).toBe(200);
    const rt2 = r1.cookies.find((c) => c.name === 'rt')!.value;
    expect(rt2).not.toBe(first.refreshToken);
    const access2 = r1.json().accessToken as string;
    expect((await get('/api/auth/me', access2)).statusCode).toBe(200);

    const reuse = await refresh(first.refreshToken);
    expect(reuse.statusCode).toBe(401);

    expect((await get('/api/auth/me', access2)).statusCode).toBe(401);
    expect((await refresh(rt2)).statusCode).toBe(401);
  });

  it('refresh without a cookie is 401', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/refresh' });
    expect(res.statusCode).toBe(401);
  });

  it('logout invalidates the same access token immediately', async () => {
    const { accessToken, refreshToken } = await login(t.app, 'viewer');
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { authorization: `Bearer ${accessToken}` },
      cookies: { rt: refreshToken },
    });
    expect(res.statusCode).toBe(200);
    expect((await get('/api/auth/me', accessToken)).statusCode).toBe(401);
    const r = await t.app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { rt: refreshToken } });
    expect(r.statusCode).toBe(401);
  });
});

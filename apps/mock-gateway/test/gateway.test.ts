import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildMockGateway, FAST_TIMINGS, platformUserIdFor, type MockGateway } from '../src/gateway';

let gw: MockGateway;
let url: string;

const post = async (path: string, body: unknown = {}) => {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
const get = async (path: string) => {
  const res = await fetch(`${url}${path}`);
  return { status: res.status, body: (await res.json()) as any };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readEvents(since: number, ms: number) {
  const ac = new AbortController();
  const res = await fetch(`${url}/events?since=${since}`, { signal: ac.signal });
  let text = '';
  const reader = (async () => {
    try {
      for await (const chunk of res.body as any) text += new TextDecoder().decode(chunk);
    } catch {
      /* aborted */
    }
  })();
  await sleep(ms);
  ac.abort();
  await reader;
  return text
    .split('\n\n')
    .filter((b) => b.includes('data:'))
    .map((b) => JSON.parse(b.split('\n').find((l) => l.startsWith('data:'))!.slice(5)));
}

beforeAll(async () => {
  gw = buildMockGateway({ timings: FAST_TIMINGS });
  url = await gw.app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(async () => {
  await gw.app.close();
});
beforeEach(() => {
  gw.state.reset();
});

async function groupWithMember() {
  await post('/accounts/a1/connect');
  await post('/accounts/a2/connect');
  const { body } = await post('/groups', { creatorAccountId: 'a1' });
  const groupId = body.groupId as string;
  const { body: inv } = await post(`/groups/${groupId}/invite`);
  await post(`/groups/${groupId}/join`, { accountId: 'a2', inviteLink: inv.inviteLink });
  await sleep(80);
  return groupId;
}

describe('mock gateway', () => {
  it('connect returns a stable platformUserId', async () => {
    const a = await post('/accounts/a1/connect');
    const b = await post('/accounts/a1/connect');
    expect(a.body.platformUserId).toBe(platformUserIdFor('a1'));
    expect(b.body.platformUserId).toBe(a.body.platformUserId);
  });

  it('send is accepted, then lands with message_sent and message events', async () => {
    const groupId = await groupWithMember();
    const res = await post(`/groups/${groupId}/send`, { accountId: 'a2', clientMsgId: 'c1', text: 'hi' });
    expect(res.status).toBe(202);
    await sleep(60);
    const events = await readEvents(0, 50);
    const types = events.map((e) => e.type);
    expect(types).toContain('member_joined');
    expect(types).toContain('message_sent');
    expect(types).toContain('message');
    expect((await get(`/groups/${groupId}/messages/by-client-id/c1`)).status).toBe(200);
  });

  it('SSE since is exclusive and replays history', async () => {
    await post('/_control/events/emit', { type: 'x', data: {} });
    await post('/_control/events/emit', { type: 'x', data: {} });
    await post('/_control/events/emit', { type: 'x', data: {} });
    const events = await readEvents(1, 50);
    expect(events.map((e) => e.eventId)).toEqual([2, 3]);
  });

  it('rate limit window resets on every send', async () => {
    const groupId = await groupWithMember();
    await post('/_control/faults', { endpoint: 'send', action: { type: 'rate_limit', retryAfterSeconds: 1 } });
    const first = await post(`/groups/${groupId}/send`, { accountId: 'a2', clientMsgId: 'c1', text: 'x' });
    expect(first.status).toBe(429);
    expect(first.body.retryAfterSeconds).toBe(1);
    await sleep(700);
    expect((await post(`/groups/${groupId}/send`, { accountId: 'a2', clientMsgId: 'c2', text: 'x' })).status).toBe(429);
    await sleep(700);
    expect((await post(`/groups/${groupId}/send`, { accountId: 'a2', clientMsgId: 'c3', text: 'x' })).status).toBe(429);
    await sleep(1100);
    expect((await post(`/groups/${groupId}/send`, { accountId: 'a2', clientMsgId: 'c4', text: 'x' })).status).toBe(202);
  });

  it('504 with effect still lands the message; by-client-id reports it', async () => {
    const groupId = await groupWithMember();
    await post('/_control/faults', { endpoint: 'send', action: { type: 'timeout', effect: true, landAfterMs: 100 } });
    const res = await post(`/groups/${groupId}/send`, { accountId: 'a2', clientMsgId: 'c1', text: 'x' });
    expect(res.status).toBe(504);
    expect(res.body.code).toBe('NETWORK_TIMEOUT');
    expect((await get(`/groups/${groupId}/messages/by-client-id/c1`)).status).toBe(404);
    await sleep(150);
    expect((await get(`/groups/${groupId}/messages/by-client-id/c1`)).status).toBe(200);
  });

  it('terminal accounts fail every request and are removed from groups', async () => {
    const groupId = await groupWithMember();
    await post('/_control/accounts/a2/terminal', { status: 'suspended' });
    expect((await post('/accounts/a2/connect')).body.code).toBe('ACCOUNT_SUSPENDED');
    const members = (await get(`/groups/${groupId}/members`)).body.map((m: any) => m.platformUserId);
    expect(members).not.toContain(platformUserIdFor('a2'));
  });

  it('kick requires permission and fails with OWNER_LEFT once the owner left', async () => {
    const groupId = await groupWithMember();
    const target = platformUserIdFor('a1');
    expect((await post(`/groups/${groupId}/kick`, { byAccountId: 'a2', targetPlatformUserId: target })).body.code).toBe(
      'NO_PERMISSION',
    );
    await post(`/groups/${groupId}/leave`, { accountId: 'a1' });
    expect(
      (await post(`/groups/${groupId}/kick`, { byAccountId: 'a2', targetPlatformUserId: platformUserIdFor('a2') })).body
        .code,
    ).toBe('OWNER_LEFT');
  });
});

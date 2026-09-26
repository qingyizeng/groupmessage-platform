import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildMockGateway, FAST_TIMINGS, platformUserIdFor, type MockGateway } from '@gmp/mock-gateway';
import { runMigrations } from '../src/db/migrate';
import { waitFor } from './helpers/app';
import { createTempDb, type TempDb } from './helpers/db';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Kills the real server process with SIGKILL at random moments while messages are being sent
 * (with 504s and slow acks injected), then checks the invariants of A2:
 * no gateway message without a database row, and never more than one gateway message per row.
 */
describe('crash safety of outbound delivery (real process, SIGKILL)', () => {
  let db: TempDb;
  let gw: MockGateway;
  let gwUrl: string;
  let port: number;
  let child: ChildProcess | null = null;

  const base = () => `http://127.0.0.1:${port}`;

  async function startServer() {
    // Run node directly (not via npx) so SIGKILL hits the server itself, not a wrapper.
    child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      cwd: serverDir,
      env: {
        ...process.env,
        DATABASE_URL: db.url,
        GATEWAY_URL: gwUrl,
        PORT: String(port),
        JWT_SECRET: 'crash-test-secret-crash-test-secret',
        INSTANCE_ID: 'crash-test',
        LOG_LEVEL: 'error',
        GATEWAY_SEND_TIMEOUT_MS: '3000',
      },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    await waitFor(
      async () => (await fetch(`${base()}/api/health`).catch(() => null))?.ok,
      { timeout: 20_000, interval: 100, message: 'server up' },
    );
  }

  function kill() {
    const c = child;
    child = null;
    if (!c) return Promise.resolve();
    if (c.exitCode !== null || c.signalCode !== null) return Promise.resolve();
    return new Promise<void>((resolve) => {
      c.once('exit', () => resolve());
      c.kill('SIGKILL');
    });
  }

  beforeAll(async () => {
    db = await createTempDb();
    await runMigrations(db.pool);
    gw = buildMockGateway({
      timings: { ...FAST_TIMINGS, sendAckMs: [50, 400], sentEventMs: [50, 800] },
    });
    gwUrl = await gw.app.listen({ port: 0, host: '127.0.0.1' });
    port = await freePort();
  });

  afterAll(async () => {
    await kill();
    await gw.app.close();
    await db.drop();
  });

  it('keeps database and gateway consistent across repeated kill -9', async () => {
    await startServer();
    const login = await fetch(`${base()}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    const token = ((await login.json()) as { accessToken: string }).accessToken;
    const api = (method: string, url: string, body?: unknown) =>
      fetch(`${base()}${url}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });

    const accounts = ['acc_01', 'acc_02', 'acc_03'];
    for (const a of accounts) expect((await api('POST', `/api/accounts/${a}/connect`)).status).toBe(200);
    const creator = accounts[0]!;
    const created = await fetch(`${gwUrl}/groups`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ creatorAccountId: creator }),
    });
    const gg = ((await created.json()) as { groupId: string }).groupId;
    const { rows } = await db.pool.query<{ id: string }>(
      'INSERT INTO groups (gateway_group_id, creator_account_id) VALUES ($1, $2) RETURNING id',
      [gg, creator],
    );
    const groupId = rows[0]!.id;
    await db.pool.query(
      `INSERT INTO group_members (group_id, platform_user_id, account_id, role, present) VALUES ($1, $2, $3, 'creator', true)`,
      [groupId, platformUserIdFor(creator), creator],
    );
    const { inviteLink } = (await (await fetch(`${gwUrl}/groups/${gg}/invite`, { method: 'POST' })).json()) as {
      inviteLink: string;
    };
    for (const a of accounts.slice(1)) {
      await fetch(`${gwUrl}/groups/${gg}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId: a, inviteLink }),
      });
    }
    await waitFor(
      async () =>
        (await db.pool.query('SELECT 1 FROM group_members WHERE group_id = $1 AND present', [groupId])).rowCount === 3,
      { timeout: 10_000, message: 'members joined' },
    );

    // Mixed faults: 504 that did land, 504 that did not, slow acks.
    const rule = (action: object, times: number) =>
      gw.state.faults.push({ id: Math.random(), endpoint: 'send', remaining: times, action: action as never });
    rule({ type: 'timeout', effect: true, landAfterMs: 800 }, 4);
    rule({ type: 'timeout', effect: false }, 4);
    rule({ type: 'delay', ms: 700 }, 8);

    const ids: string[] = [];
    for (let round = 0; round < 4; round++) {
      for (let i = 0; i < 10; i++) {
        const res = await api('POST', `/api/groups/${groupId}/send`, {
          accountId: accounts[i % 3],
          text: `round ${round} msg ${i}`,
        });
        expect(res.status).toBe(202);
        ids.push(((await res.json()) as { clientMsgId: string }).clientMsgId);
        await new Promise((r) => setTimeout(r, Math.random() * 60));
      }
      if (round < 3) {
        await new Promise((r) => setTimeout(r, 100 + Math.random() * 600));
        await kill();
        await new Promise((r) => setTimeout(r, 300));
        await startServer();
      }
    }

    await waitFor(
      async () => {
        const { rows } = await db.pool.query(
          `SELECT count(*)::int AS n FROM messages WHERE client_msg_id = ANY($1) AND phase NOT IN ('sent', 'failed')`,
          [ids],
        );
        return rows[0].n === 0;
      },
      { timeout: 45_000, interval: 250, message: 'all messages settled' },
    );

    const { rows: dbRows } = await db.pool.query<{ client_msg_id: string; phase: string; msg_id: string | null }>(
      'SELECT client_msg_id, phase, msg_id FROM messages WHERE client_msg_id IS NOT NULL',
    );
    const byClient = new Map(dbRows.map((r) => [r.client_msg_id, r]));
    const landed = gw.state.groups.get(gg)!.messages.filter((m) => m.clientMsgId);

    // Every gateway message has a database row.
    for (const m of landed) expect(byClient.has(m.clientMsgId!)).toBe(true);
    for (const id of ids) {
      const copies = landed.filter((m) => m.clientMsgId === id);
      const row = byClient.get(id)!;
      // Never more than one gateway message per row, and the row agrees with the gateway.
      expect(copies.length).toBeLessThanOrEqual(1);
      if (row.phase === 'sent') expect(copies[0]?.msgId).toBe(row.msg_id);
      else expect(copies).toHaveLength(0);
      const sends = gw.state.calls.filter((c) => c.endpoint === 'send' && (c.body as any)?.clientMsgId === id);
      expect(sends.length).toBeLessThanOrEqual(2);
    }
    const sent = dbRows.filter((r) => r.phase === 'sent').length;
    expect(sent).toBeGreaterThan(ids.length / 2);
  }, 120_000);
});

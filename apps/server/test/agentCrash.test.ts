import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildMockGateway, FAST_TIMINGS, platformUserIdFor, type MockGateway } from '@gmp/mock-gateway';
import { buildMockAgent, type MockAgent } from '@gmp/mock-agent';
import { runMigrations } from '../src/db/migrate';
import { waitFor } from './helpers/app';
import { createTempDb, type TempDb } from './helpers/db';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const freePort = () =>
  new Promise<number>((resolve) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });

/** SIGKILLs the real server repeatedly while agent runs are in progress (A5.8). */
describe('agent runs survive kill -9 (real process)', () => {
  let db: TempDb;
  let gw: MockGateway;
  let agent: MockAgent;
  let gwUrl: string;
  let agentUrl: string;
  let port: number;
  let child: ChildProcess | null = null;
  const base = () => `http://127.0.0.1:${port}`;

  async function startServer() {
    child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      cwd: serverDir,
      env: {
        ...process.env,
        DATABASE_URL: db.url,
        GATEWAY_URL: gwUrl,
        AGENT_URL: agentUrl,
        PORT: String(port),
        JWT_SECRET: 'agent-crash-secret-agent-crash-secret',
        INSTANCE_ID: 'agent-crash',
        LOG_LEVEL: 'error',
        AGENT_TURN_TIMEOUT_MS: '3000',
        AGENT_AUDIT_TIMEOUT_MS: '1000',
      },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    await waitFor(async () => (await fetch(`${base()}/api/health`).catch(() => null))?.ok, {
      timeout: 20_000,
      interval: 100,
      message: 'server up',
    });
  }

  function kill() {
    const c = child;
    child = null;
    if (!c || c.exitCode !== null || c.signalCode !== null) return Promise.resolve();
    return new Promise<void>((resolve) => {
      c.once('exit', () => resolve());
      c.kill('SIGKILL');
    });
  }

  beforeAll(async () => {
    db = await createTempDb();
    await runMigrations(db.pool);
    gw = buildMockGateway({ timings: { ...FAST_TIMINGS, sendAckMs: [50, 300], sentEventMs: [50, 400] } });
    gwUrl = await gw.app.listen({ port: 0, host: '127.0.0.1' });
    agent = buildMockAgent();
    agentUrl = await agent.app.listen({ port: 0, host: '127.0.0.1' });
    port = await freePort();
  });

  afterAll(async () => {
    await kill();
    await gw.app.close();
    await agent.app.close();
    await db.drop();
  });

  it('every run ends, no message is sent twice, steps stay contiguous', async () => {
    await startServer();
    const token = (
      (await (
        await fetch(`${base()}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'admin', password: 'admin' }),
        })
      ).json()) as { accessToken: string }
    ).accessToken;
    const api = (method: string, url: string, body?: unknown) =>
      fetch(`${base()}${url}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    const gwPost = (p: string, body: unknown = {}) =>
      fetch(`${gwUrl}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(
        (r) => r.json() as Promise<any>,
      );

    const groups: { groupId: string; gg: string; reply: string }[] = [];
    for (let i = 0; i < 4; i++) {
      const creator = `acc_0${2 * i + 1}`;
      const member = `acc_0${2 * i + 2}`;
      for (const a of [creator, member]) expect((await api('POST', `/api/accounts/${a}/connect`)).status).toBe(200);
      const { groupId: gg } = await gwPost('/groups', { creatorAccountId: creator });
      const { rows } = await db.pool.query<{ id: string }>(
        'INSERT INTO groups (gateway_group_id, creator_account_id, agent_enabled) VALUES ($1, $2, true) RETURNING id',
        [gg, creator],
      );
      await db.pool.query(
        `INSERT INTO group_members (group_id, platform_user_id, account_id, role, present) VALUES ($1, $2, $3, 'creator', true)`,
        [rows[0]!.id, platformUserIdFor(creator), creator],
      );
      const { inviteLink } = await gwPost(`/groups/${gg}/invite`);
      await gwPost(`/groups/${gg}/join`, { accountId: member, inviteLink });
      const reply = `reply for group ${i}`;
      groups.push({ groupId: rows[0]!.id, gg, reply });
      agent.state.scripts.push({
        groupId: rows[0]!.id,
        next: 0,
        turns: [
          { delayMs: 250, toolUse: { name: 'get_recent_messages', input: { limit: 5 } } },
          { delayMs: 250, toolUse: { name: 'send_message', input: { text: reply, idempotency_key: 'k' } } },
          { delayMs: 250, toolUse: { name: 'send_message', input: { text: reply, idempotency_key: 'k' } } },
          { delayMs: 250, toolUse: { name: 'finish', input: { summary: 'done' } } },
        ],
      });
    }
    await waitFor(
      async () => (await db.pool.query('SELECT 1 FROM group_members WHERE present')).rowCount === 8,
      { timeout: 10_000, message: 'members joined' },
    );
    for (const g of groups) await gwPost(`/_control/groups/${g.gg}/external-message`, { platformUserId: 'pu_x', text: 'go' });

    for (let k = 0; k < 3; k++) {
      await new Promise((r) => setTimeout(r, 300 + Math.random() * 700));
      await kill();
      await new Promise((r) => setTimeout(r, 200));
      await startServer();
    }

    await waitFor(
      async () => {
        const { rows } = await db.pool.query(`SELECT count(*)::int AS n FROM agent_runs WHERE status = 'running'`);
        const total = await db.pool.query(`SELECT count(*)::int AS n FROM agent_runs`);
        return rows[0].n === 0 && total.rows[0].n >= groups.length;
      },
      { timeout: 60_000, interval: 250, message: 'all runs ended' },
    );

    let delivered = 0;
    for (const g of groups) {
      const copies = gw.state.groups.get(g.gg)!.messages.filter((m) => m.text === g.reply);
      expect(copies.length).toBeLessThanOrEqual(1);
      delivered += copies.length;
      const { rows: runs } = await db.pool.query<{ id: string; status: string; step_count: number }>(
        'SELECT id, status, step_count FROM agent_runs WHERE group_id = $1',
        [g.groupId],
      );
      for (const r of runs) {
        const { rows: steps } = await db.pool.query<{ seq: number }>(
          'SELECT seq FROM agent_run_steps WHERE run_id = $1 ORDER BY seq',
          [r.id],
        );
        expect(steps.map((s) => s.seq)).toEqual(Array.from({ length: r.step_count }, (_, i) => i + 1));
        expect(r.step_count).toBeLessThanOrEqual(12);
      }
      const runIds = new Set(agent.state.turnCalls.filter((c) => runs.some((r) => r.id === c.runId)).map((c) => c.runId));
      expect(runIds.size).toBe(runs.length);
      expect(agent.state.auditCalls.filter((a) => a.text === g.reply).length).toBeLessThanOrEqual(3);
    }
    expect(delivered).toBeGreaterThanOrEqual(groups.length - 1);
  }, 120_000);
});

import type { FastifyInstance } from 'fastify';
import { buildMockGateway, FAST_TIMINGS, type MockGateway } from '@gmp/mock-gateway';
import { loadConfig } from '../../src/config';
import { createContext, type AppContext } from '../../src/context';
import { expectedSchemaVersion, runMigrations } from '../../src/db/migrate';
import { buildApp } from '../../src/http/app';
import type { Clock } from '../../src/lib/clock';
import { createLogger } from '../../src/lib/logger';
import { Runtime, type WorkerSelection } from '../../src/runtime';
import { createTempDb, type TempDb } from './db';

export class ManualClock implements Clock {
  constructor(private t = Date.now()) {}
  now() {
    return this.t;
  }
  advance(ms: number) {
    this.t += ms;
  }
}

const testLogger = () => createLogger(process.env.TEST_LOG_LEVEL ?? 'silent');

function testConfig(db: TempDb, gatewayUrl = 'http://127.0.0.1:9') {
  return loadConfig({
    DATABASE_URL: db.url,
    GATEWAY_URL: gatewayUrl,
    JWT_SECRET: 'test-secret-test-secret-test-secret',
    INSTANCE_ID: `test-${process.pid}`,
    ENABLE_TEST_HOOKS: 'true',
  });
}

export interface TestApp {
  app: FastifyInstance;
  ctx: AppContext;
  db: TempDb;
  clock: ManualClock;
  close(): Promise<void>;
}

/** HTTP app only, no background workers and no gateway. */
export async function createTestApp(): Promise<TestApp> {
  const db = await createTempDb();
  await runMigrations(db.pool);
  const clock = new ManualClock();
  const ctx = createContext({
    config: testConfig(db),
    pool: db.pool,
    clock,
    log: testLogger(),
    schemaVersion: expectedSchemaVersion(),
  });
  const app = await buildApp(ctx);
  await app.ready();
  return {
    app,
    ctx,
    db,
    clock,
    async close() {
      await app.close();
      await db.drop();
    },
  };
}

export interface TestRuntime {
  runtime: Runtime;
  app: FastifyInstance;
  ctx: AppContext;
  db: TempDb;
  gw: MockGateway;
  gwUrl: string;
  baseUrl: string;
  /** Stops the server process (simulating a crash/restart) without touching DB or gateway. */
  restart(workers?: WorkerSelection): Promise<void>;
  stopServer(): Promise<void>;
  startServer(workers?: WorkerSelection): Promise<void>;
  close(): Promise<void>;
}

/** Full server runtime with all workers, a fresh database and an in-process mock gateway. */
export async function createTestRuntime(opts: { workers?: WorkerSelection } = {}): Promise<TestRuntime> {
  const db = await createTempDb();
  await runMigrations(db.pool);
  const gw = buildMockGateway({ timings: FAST_TIMINGS });
  const gwUrl = await gw.app.listen({ port: 0, host: '127.0.0.1' });
  const config = testConfig(db, gwUrl);

  let runtime: Runtime | null = null;
  let baseUrl = '';
  const t: TestRuntime = {
    get runtime() {
      return runtime!;
    },
    get app() {
      return runtime!.app;
    },
    get ctx() {
      return runtime!.ctx;
    },
    db,
    gw,
    gwUrl,
    get baseUrl() {
      return baseUrl;
    },
    async startServer(workers = opts.workers) {
      runtime = await Runtime.create({
        config,
        pool: db.pool,
        clock: { now: () => Date.now() },
        log: testLogger(),
        schemaVersion: expectedSchemaVersion(),
      });
      baseUrl = await runtime.start({ port: 0, host: '127.0.0.1', workers });
    },
    async stopServer() {
      await runtime?.stop();
      runtime = null;
    },
    async restart(workers) {
      await t.stopServer();
      await t.startServer(workers);
    },
    async close() {
      await t.stopServer();
      await gw.app.close();
      await db.drop();
    },
  };
  await t.startServer();
  return t;
}

export async function login(app: FastifyInstance, username: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: username } });
  const rt = res.cookies.find((c) => c.name === 'rt');
  return { accessToken: res.json().accessToken as string, refreshToken: rt?.value as string, res };
}

/** Polls `fn` until it returns a truthy value or the timeout elapses. */
export async function waitFor<T>(fn: () => Promise<T> | T, opts: { timeout?: number; interval?: number; message?: string } = {}): Promise<NonNullable<T>> {
  const deadline = Date.now() + (opts.timeout ?? 5_000);
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v as NonNullable<T>;
    } catch (err) {
      last = err;
    }
    if (Date.now() > deadline) {
      throw new Error(`waitFor timed out${opts.message ? `: ${opts.message}` : ''}${last ? ` (last error: ${last})` : ''}`);
    }
    await new Promise((r) => setTimeout(r, opts.interval ?? 25));
  }
}

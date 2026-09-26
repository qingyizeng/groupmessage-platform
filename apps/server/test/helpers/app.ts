import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../../src/config';
import { runMigrations } from '../../src/db/migrate';
import { buildApp } from '../../src/http/app';
import type { Clock } from '../../src/lib/clock';
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

export interface TestApp {
  app: FastifyInstance;
  db: TempDb;
  clock: ManualClock;
  close(): Promise<void>;
}

export async function createTestApp(): Promise<TestApp> {
  const db = await createTempDb();
  await runMigrations(db.pool);
  const clock = new ManualClock();
  const config = loadConfig({ DATABASE_URL: db.url, JWT_SECRET: 'test-secret-test-secret-test-secret' });
  const { app } = await buildApp({ config, pool: db.pool, clock, schemaVersion: 1 });
  await app.ready();
  return {
    app,
    db,
    clock,
    async close() {
      await app.close();
      await db.drop();
    },
  };
}

export async function login(app: FastifyInstance, username: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: username } });
  const rt = res.cookies.find((c) => c.name === 'rt');
  return { accessToken: res.json().accessToken as string, refreshToken: rt?.value as string, res };
}

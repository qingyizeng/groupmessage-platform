import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createPool, type Pool } from '../../src/db/pool';

const BASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://gmp:gmp@localhost:55432/gmp';

export interface TempDb {
  url: string;
  pool: Pool;
  drop(): Promise<void>;
}

/** Creates an isolated, empty database for one test file. */
export async function createTempDb(): Promise<TempDb> {
  const name = `gmp_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: BASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = new URL(BASE_URL);
  url.pathname = `/${name}`;
  const pool = createPool(url.toString(), 10);

  return {
    url: url.toString(),
    pool,
    async drop() {
      await pool.end();
      const c = new pg.Client({ connectionString: BASE_URL });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}

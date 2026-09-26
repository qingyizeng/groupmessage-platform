import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from './pool';

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

const MIGRATION_LOCK_KEY = 727_001;

interface MigrationFile {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

export function loadMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
  const migrations = files.map((file) => {
    const sql = readFileSync(path.join(dir, file), 'utf8');
    return {
      version: Number(file.slice(0, 4)),
      name: file,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    };
  });
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`Migration numbering gap at ${m.name}: expected version ${i + 1}`);
  });
  return migrations;
}

/** The schema version this build of the code requires. */
export function expectedSchemaVersion(dir = MIGRATIONS_DIR): number {
  return loadMigrations(dir).length;
}

export async function currentSchemaVersion(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists`,
  );
  if (!rows[0]?.exists) return 0;
  const res = await pool.query<{ v: number | null }>('SELECT max(version) AS v FROM schema_migrations');
  return res.rows[0]?.v ?? 0;
}

export class SchemaOutdatedError extends Error {
  constructor(
    readonly current: number,
    readonly expected: number,
  ) {
    super(`Database schema version ${current} is behind the code (expects ${expected}); run \`pnpm migrate\` first`);
  }
}

export async function assertSchemaUpToDate(pool: Pool, dir = MIGRATIONS_DIR): Promise<number> {
  const expected = expectedSchemaVersion(dir);
  const current = await currentSchemaVersion(pool);
  if (current < expected) throw new SchemaOutdatedError(current, expected);
  return expected;
}

/**
 * Applies pending migrations. Safe to run repeatedly and concurrently: an advisory lock serializes
 * runners, each migration runs in its own transaction, and applied migrations are skipped.
 */
export async function runMigrations(pool: Pool, dir = MIGRATIONS_DIR): Promise<string[]> {
  const migrations = loadMigrations(dir);
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    int PRIMARY KEY,
        name       text NOT NULL,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ version: number; checksum: string; name: string }>(
      'SELECT version, checksum, name FROM schema_migrations',
    );
    const done = new Map(rows.map((r) => [r.version, r]));
    for (const m of migrations) {
      const prev = done.get(m.version);
      if (prev) {
        if (prev.checksum !== m.checksum) {
          throw new Error(`Migration ${m.name} was modified after being applied (checksum mismatch)`);
        }
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [
          m.version,
          m.name,
          m.checksum,
        ]);
        await client.query('COMMIT');
        applied.push(m.name);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${m.name} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
  return applied;
}

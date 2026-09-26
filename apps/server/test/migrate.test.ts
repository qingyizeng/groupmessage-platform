import { execFile } from 'node:child_process';
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MIGRATIONS_DIR,
  SchemaOutdatedError,
  assertSchemaUpToDate,
  currentSchemaVersion,
  expectedSchemaVersion,
  runMigrations,
} from '../src/db/migrate';
import { createTempDb, type TempDb } from './helpers/db';

const run = promisify(execFile);
const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('migrations', () => {
  let db: TempDb;
  beforeEach(async () => {
    db = await createTempDb();
  });
  afterEach(async () => {
    await db.drop();
  });

  it('can be run repeatedly and concurrently', async () => {
    const results = await Promise.all([runMigrations(db.pool), runMigrations(db.pool), runMigrations(db.pool)]);
    expect(results.flat()).toHaveLength(expectedSchemaVersion());
    expect(await runMigrations(db.pool)).toEqual([]);
    expect(await currentSchemaVersion(db.pool)).toBe(expectedSchemaVersion());
  });

  it('refuses when the database is behind the code', async () => {
    await expect(assertSchemaUpToDate(db.pool)).rejects.toBeInstanceOf(SchemaOutdatedError);
    await runMigrations(db.pool);
    await expect(assertSchemaUpToDate(db.pool)).resolves.toBe(expectedSchemaVersion());

    const newerCode = mkdtempSync(path.join(os.tmpdir(), 'gmp-mig-'));
    cpSync(MIGRATIONS_DIR, newerCode, { recursive: true });
    const next = String(expectedSchemaVersion() + 1).padStart(4, '0');
    writeFileSync(path.join(newerCode, `${next}_future.sql`), 'SELECT 1;');
    await expect(assertSchemaUpToDate(db.pool, newerCode)).rejects.toBeInstanceOf(SchemaOutdatedError);
  });

  it('detects an applied migration that was edited afterwards', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'gmp-mig-'));
    cpSync(MIGRATIONS_DIR, dir, { recursive: true });
    await runMigrations(db.pool, dir);
    writeFileSync(path.join(dir, '0001_auth.sql'), '-- edited');
    await expect(runMigrations(db.pool, dir)).rejects.toThrow(/checksum mismatch/);
  });

  it('server process exits non-zero when the schema is behind', async () => {
    const err = await run('npx', ['tsx', 'src/main.ts'], {
      cwd: serverDir,
      env: { ...process.env, DATABASE_URL: db.url, PORT: '0' },
    }).catch((e: { code: number; stderr: string }) => e);
    expect((err as { code: number }).code).toBe(1);
    expect((err as { stderr: string }).stderr).toMatch(/Refusing to start/);
  });
});

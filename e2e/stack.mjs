// Starts an isolated stack for the end-to-end tests: fresh database, built console, backend.
// The mock gateway and mock agent are started as separate Playwright web servers.
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = path.join(root, 'apps/server');
const require = createRequire(path.join(serverDir, 'package.json'));
const pg = require('pg');

const adminUrl = process.env.E2E_ADMIN_DATABASE_URL ?? 'postgres://gmp:gmp@localhost:55432/gmp';
const dbName = 'gmp_e2e';
const dbUrl = new URL(adminUrl);
dbUrl.pathname = `/${dbName}`;

const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${dbName}`);
await admin.end();

const env = { ...process.env, DATABASE_URL: dbUrl.toString() };
execFileSync(process.execPath, ['--import', 'tsx', 'src/db/migrateCli.ts'], { cwd: serverDir, env, stdio: 'inherit' });
execFileSync('pnpm', ['--filter', '@gmp/web', 'exec', 'vite', 'build', '--logLevel', 'warn'], { cwd: root, stdio: 'inherit' });

const server = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
  cwd: serverDir,
  env: {
    ...env,
    PORT: '3100',
    GATEWAY_URL: 'http://localhost:4101',
    AGENT_URL: 'http://localhost:4102',
    INSTANCE_ID: 'e2e',
    LOG_LEVEL: 'warn',
  },
  stdio: 'inherit',
});
const stop = () => server.kill('SIGTERM');
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
server.on('exit', (code) => process.exit(code ?? 0));

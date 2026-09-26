import { loadConfig } from './config';
import { createPool } from './db/pool';
import { assertSchemaUpToDate, SchemaOutdatedError } from './db/migrate';
import { systemClock } from './lib/clock';
import { createLogger } from './lib/logger';
import { Runtime } from './runtime';

const config = loadConfig();
const log = createLogger(config.LOG_LEVEL);
const pool = createPool(config.DATABASE_URL);

let schemaVersion: number;
try {
  schemaVersion = await assertSchemaUpToDate(pool);
} catch (err) {
  console.error(
    err instanceof SchemaOutdatedError ? `Refusing to start: ${err.message}` : `Startup check failed: ${err}`,
  );
  await pool.end();
  process.exit(1);
}

const runtime = await Runtime.create({ config, pool, clock: systemClock, log, schemaVersion });

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'shutting down');
  await runtime.stop();
  await pool.end();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await runtime.start({ port: config.PORT });
log.info({ instanceId: config.INSTANCE_ID, schemaVersion, port: config.PORT }, 'server started');

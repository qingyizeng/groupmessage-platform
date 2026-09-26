import { loadConfig } from './config';
import { createPool } from './db/pool';
import { assertSchemaUpToDate, SchemaOutdatedError } from './db/migrate';
import { buildApp } from './http/app';
import { systemClock } from './lib/clock';

const config = loadConfig();
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

const { app } = await buildApp({
  config,
  pool,
  clock: systemClock,
  schemaVersion,
  logger: { level: config.LOG_LEVEL },
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await pool.end();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.PORT, host: '0.0.0.0' });
app.log.info({ instanceId: config.INSTANCE_ID, schemaVersion }, 'server started');

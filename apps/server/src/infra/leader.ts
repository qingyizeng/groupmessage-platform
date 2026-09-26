import pg from 'pg';
import type { Logger } from '../lib/logger';
import { sleep } from '../lib/async';

export const LOCK_KEYS = {
  eventIngest: 727_101,
  wsPublisher: 727_102,
} as const;

/**
 * Runs `fn` only while this process holds a session-level advisory lock on a dedicated connection.
 * If that connection dies the lock is released by Postgres and `fn`'s signal aborts, so at most one
 * process runs `fn` at a time. Loops until `signal` aborts.
 */
export async function runWhileLeader(opts: {
  connectionString: string;
  lockKey: number;
  name: string;
  log: Logger;
  signal: AbortSignal;
  retryMs?: number;
  fn: (client: pg.Client, leaderSignal: AbortSignal) => Promise<void>;
}): Promise<void> {
  const { log, signal, name } = opts;
  while (!signal.aborted) {
    const client = new pg.Client({ connectionString: opts.connectionString });
    const lost = new AbortController();
    const onAbort = () => lost.abort();
    signal.addEventListener('abort', onAbort);
    client.on('error', (err) => {
      log.warn({ err, name }, 'leader connection error');
      lost.abort();
    });
    try {
      await client.connect();
      const { rows } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [opts.lockKey]);
      if (rows[0]?.ok) {
        log.info({ name }, 'acquired leadership');
        await opts.fn(client, lost.signal);
      }
    } catch (err) {
      if (!signal.aborted) log.warn({ err, name }, 'leader loop failed');
    } finally {
      signal.removeEventListener('abort', onAbort);
      await client.end().catch(() => undefined);
    }
    if (!signal.aborted) await sleep(opts.retryMs ?? 1000, signal);
  }
}

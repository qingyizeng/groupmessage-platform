import type { Pool, PoolClient } from './pool';

const RETRYABLE_SQLSTATES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
]);

export interface TxOptions {
  retries?: number;
  /** Also retry on unique_violation; for handlers whose conflicting writer makes the retry succeed. */
  retryOnUniqueViolation?: boolean;
}

export function pgCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;
}

export async function withTx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>, opts: TxOptions = {}): Promise<T> {
  const retries = opts.retries ?? 3;
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      const code = pgCode(err);
      const retryable =
        (code !== undefined && RETRYABLE_SQLSTATES.has(code)) || (opts.retryOnUniqueViolation && code === '23505');
      if (!retryable || attempt >= retries) throw err;
    } finally {
      client.release();
    }
  }
}

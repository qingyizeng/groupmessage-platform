import pg from 'pg';

// bigint (int8) columns are ids and event ids in this schema; they stay well below 2^53.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(connectionString: string, max = 20): pg.Pool {
  return new pg.Pool({ connectionString, max });
}

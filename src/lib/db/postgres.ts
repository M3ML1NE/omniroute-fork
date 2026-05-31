/**
 * src/lib/db/postgres.ts — Postgres connection pool singleton.
 *
 * Replaces the better-sqlite3 driver under `src/lib/db/core.ts`. Modules that
 * still need a low-level connection should import `getPool()` here; everything
 * else should go through the adapter exposed by `core.ts` (`getDbInstance()`)
 * for source-level continuity with the SQLite era.
 */

import * as pg from "pg";
const { Pool } = pg;

const DEFAULT_DATABASE_URL = "postgres://omniroute:omniroute@localhost:5432/omniroute_test";

let _pool: pg.Pool | undefined;

function resolveDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url && url.trim().length > 0) return url;

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "DATABASE_URL environment variable is required in production"
    );
  }

  return DEFAULT_DATABASE_URL;
}

/** Lazily-constructed Postgres pool. Call sites share a single instance. */
export function getPool(): pg.Pool {
  if (!_pool) {
    _pool = new Pool({
      connectionString: resolveDatabaseUrl(),
      max: 10,
    });
  }
  return _pool;
}

/** Run a single query against the shared pool. */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(sql, (params as unknown[]) ?? []);
}

/** Close the pool. Tests and graceful-shutdown paths call this. */
export async function closePool(): Promise<void> {
  // Detach the singleton synchronously so a concurrent getPool() (e.g. a test's
  // synchronous reset-then-reacquire) builds a fresh pool instead of handing out
  // the one being ended ("Cannot use a pool after calling end on the pool").
  const pool = _pool;
  _pool = undefined;
  if (pool) {
    await pool.end();
  }
}

/**
 * Run `fn` inside a real Postgres transaction on a dedicated connection
 * (BEGIN / COMMIT, ROLLBACK on throw, always released). Queries must use the
 * supplied `client`, not the shared `query()` helper, to be transactional.
 */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

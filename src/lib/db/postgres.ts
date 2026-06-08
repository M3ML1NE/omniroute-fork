/**
 * src/lib/db/postgres.ts — Postgres connection pool with Patroni HA support.
 *
 * Replaces the better-sqlite3 driver under `src/lib/db/core.ts`. Modules that
 * still need a low-level connection should import `getPool()` here; everything
 * else should go through the adapter exposed by `core.ts` (`getDbInstance()`)
 * for source-level continuity with the SQLite era.
 *
 * HA topology: the corporate Postgres is a Patroni cluster — multiple hosts,
 * exactly one writable primary at a time, the rest read-only replicas. `pg` 8.x
 * has no native multi-host / `target_session_attrs` failover, so this module:
 *   1. probes every configured host with `SELECT pg_is_in_recovery()`,
 *   2. builds the WRITE pool against the host that answers `false` (primary),
 *   3. optionally builds a READ pool against a replica (`getReplicaPool()`),
 *   4. on a "cannot execute … in a read-only transaction" error (SQLSTATE
 *      25006) or a connection failure, discards the stale pool and re-discovers
 *      the primary (Patroni failover promoted a new leader).
 *
 * SSL is resolved in `pgConfig.ts` and passed straight to the pool.
 */

import * as pg from "pg";
import { resolvePgConfig, type HostSpec, type PgRuntimeConfig } from "./pgConfig";

const { Pool } = pg;

/** Postgres SQLSTATE raised when a write hits a read-only (replica) backend. */
const READ_ONLY_SQLSTATE = "25006";

let _config: PgRuntimeConfig | undefined;
let _writePool: pg.Pool | undefined;
let _writeHost: HostSpec | undefined;
let _readPool: pg.Pool | undefined;
let _readHost: HostSpec | undefined;
/** In-flight primary discovery, so concurrent callers await one probe. */
let _discovery: Promise<pg.Pool> | undefined;

function getConfig(): PgRuntimeConfig {
  if (!_config) _config = resolvePgConfig();
  return _config;
}

export function getSchema(): string {
  return getConfig().schema;
}

function poolConfigFor(host: HostSpec, cfg: PgRuntimeConfig): pg.PoolConfig {
  return {
    host: host.host,
    port: host.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    ssl: cfg.ssl,
    max: cfg.max,
    connectionTimeoutMillis: cfg.connectionTimeoutMillis,
    // search_path routes unqualified tables to OmniRoute's schema (public kept
    // for shared extensions). cfg.schema is validated to a bare identifier in
    // pgConfig.resolveSchema(), so inlining it here is injection-safe.
    options: `-c search_path=${cfg.schema},public`,
  };
}

/**
 * Probe a single host: connect, ask `pg_is_in_recovery()`, return its role.
 * `inRecovery === false` ⇒ primary (writable). Always closes its probe pool.
 */
async function probeHost(
  host: HostSpec,
  cfg: PgRuntimeConfig
): Promise<{ host: HostSpec; inRecovery: boolean } | { host: HostSpec; error: Error }> {
  const probe = new Pool({
    ...poolConfigFor(host, cfg),
    max: 1,
    connectionTimeoutMillis: cfg.primaryProbeTimeoutMillis,
  });
  try {
    const res = await probe.query<{ pg_is_in_recovery: boolean }>("SELECT pg_is_in_recovery()");
    return { host, inRecovery: res.rows[0]?.pg_is_in_recovery === true };
  } catch (err) {
    return { host, error: err instanceof Error ? err : new Error(String(err)) };
  } finally {
    await probe.end().catch(() => {});
  }
}

/**
 * Discover the current primary across all configured hosts (concurrently) and
 * build the shared WRITE pool against it. Also records a replica host (if any)
 * for `getReplicaPool()`. Single-host configs skip probing entirely.
 */
async function discoverPrimary(): Promise<pg.Pool> {
  const cfg = getConfig();

  // Single host (or no cluster): no discovery needed, that host is the target.
  if (cfg.hosts.length === 1) {
    _writeHost = cfg.hosts[0];
    _writePool = new Pool(poolConfigFor(_writeHost, cfg));
    attachErrorGuard(_writePool);
    return _writePool;
  }

  const results = await Promise.all(cfg.hosts.map((h) => probeHost(h, cfg)));

  const primary = results.find((r) => "inRecovery" in r && r.inRecovery === false);
  const replica = results.find((r) => "inRecovery" in r && r.inRecovery === true);

  if (!primary) {
    const errs = results
      .map((r) =>
        "error" in r ? `${r.host.host}:${r.host.port} → ${r.error.message}` : `${r.host.host} → replica`
      )
      .join("; ");
    throw new Error(
      `No writable Postgres primary found among [${cfg.hosts
        .map((h) => `${h.host}:${h.port}`)
        .join(", ")}]. Probe results: ${errs}`
    );
  }

  _writeHost = primary.host;
  _writePool = new Pool(poolConfigFor(_writeHost, cfg));
  attachErrorGuard(_writePool);

  if (replica && "host" in replica) {
    _readHost = replica.host;
  }

  return _writePool;
}

/**
 * Idle clients can emit async errors (e.g. backend terminated during a Patroni
 * switchover). Without a listener `pg` would crash the process; we swallow and
 * let the next `getPool()`/query re-discover.
 */
function attachErrorGuard(pool: pg.Pool): void {
  pool.on("error", () => {
    /* handled lazily on next acquire via re-discovery */
  });
}

/**
 * Return the shared WRITE pool, discovering the primary on first use. Callers
 * already `await` everything that follows (`.query`, `.connect`), so returning a
 * promise here is safe and keeps a single source of truth for the live pool.
 */
export async function getPool(): Promise<pg.Pool> {
  if (_writePool) return _writePool;
  if (!_discovery) {
    _discovery = discoverPrimary().finally(() => {
      _discovery = undefined;
    });
  }
  return _discovery;
}

/**
 * Return a READ pool bound to a replica when the cluster exposes one, else the
 * write pool. Use for explicitly read-only/analytics queries to offload the
 * primary. Reads are tolerant of staleness (async replication).
 */
export async function getReplicaPool(): Promise<pg.Pool> {
  await getPool(); // ensures discovery ran and _readHost is populated
  if (!_readHost) return _writePool!;
  if (!_readPool) {
    _readPool = new Pool(poolConfigFor(_readHost, getConfig()));
    attachErrorGuard(_readPool);
  }
  return _readPool;
}

/** True when the last write attempt landed on a read-only backend. */
function isReadOnlyError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === READ_ONLY_SQLSTATE
  );
}

/** True for connection-level failures worth re-discovering the primary for. */
function isConnectionError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: string }).code;
  return (
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND" ||
    code === "ECONNRESET" ||
    code === "57P01" || // admin_shutdown
    code === "57P02" || // crash_shutdown
    code === "08006" || // connection_failure
    code === "08001" || // sqlclient_unable_to_establish_sqlconnection
    code === "08004" // sqlserver_rejected_establishment_of_sqlconnection
  );
}

/** Tear down the current write pool so the next call re-discovers the primary. */
async function invalidateWritePool(): Promise<void> {
  const pool = _writePool;
  _writePool = undefined;
  _writeHost = undefined;
  if (pool) await pool.end().catch(() => {});
}

/**
 * Run a single query against the WRITE pool. On a read-only or connection error
 * (Patroni promoted a new leader), re-discover the primary once and retry.
 */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  const args = (params as unknown[]) ?? [];
  try {
    const pool = await getPool();
    return await pool.query<T>(sql, args);
  } catch (err) {
    if (isReadOnlyError(err) || isConnectionError(err)) {
      await invalidateWritePool();
      const pool = await getPool();
      return await pool.query<T>(sql, args);
    }
    throw err;
  }
}

/** Close all pools. Tests and graceful-shutdown paths call this. */
export async function closePool(): Promise<void> {
  // Detach singletons synchronously so a concurrent getPool() builds fresh pools
  // instead of handing out the ones being ended.
  const write = _writePool;
  const read = _readPool;
  _writePool = undefined;
  _writeHost = undefined;
  _readPool = undefined;
  _readHost = undefined;
  _discovery = undefined;
  await Promise.all([
    write ? write.end().catch(() => {}) : Promise.resolve(),
    read ? read.end().catch(() => {}) : Promise.resolve(),
  ]);
}

/**
 * Run `fn` inside a real Postgres transaction on a dedicated connection from the
 * WRITE pool (BEGIN / COMMIT, ROLLBACK on throw, always released). If BEGIN/first
 * statement reveals a read-only or dead backend, re-discover the primary once
 * and retry the whole transaction on the new leader.
 */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  try {
    return await runTransaction(fn);
  } catch (err) {
    if (isReadOnlyError(err) || isConnectionError(err)) {
      await invalidateWritePool();
      return await runTransaction(fn);
    }
    throw err;
  }
}

async function runTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Introspection for health checks / diagnostics. Does not trigger discovery. */
export function getTopology(): {
  hosts: HostSpec[];
  primary: HostSpec | undefined;
  replica: HostSpec | undefined;
  schema: string;
  ssl: boolean;
} {
  const cfg = getConfig();
  return {
    hosts: cfg.hosts,
    primary: _writeHost,
    replica: _readHost,
    schema: cfg.schema,
    ssl: cfg.ssl !== false,
  };
}

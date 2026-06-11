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
  };
}

function makePool(config: pg.PoolConfig, cfg: PgRuntimeConfig): pg.Pool {
  // Belt-and-suspenders: ALTER ROLE sets the server-side default, but if it did
  // not stick (e.g. the pooler authenticates as a different backend role than
  // the one we ran ALTER ROLE on), also SET search_path on every fresh
  // connection. Use the `onConnect` pool option (awaited before the client is
  // handed out) rather than the `connect` event (not awaited → pg@9 "already
  // executing a query" warning).
  const onConnect = cfg.applyRoleSearchPath
    ? async (client: pg.PoolClient) => {
        await client.query(`SET search_path TO ${cfg.schema}, public`);
      }
    : undefined;
  const pool = new Pool({ ...config, onConnect } as pg.PoolConfig);
  attachErrorGuard(pool);
  return pool;
}

/**
 * Pin the schema as the role's DEFAULT search_path via
 * `ALTER ROLE CURRENT_USER SET search_path TO <schema>, public`, run on a
 * dedicated throwaway connection to `host` BEFORE the real pool opens any
 * connection. This is the only mechanism that is correct on every front:
 *   - survives a PgBouncer/Odyssey pooler and its `DISCARD ALL` (that runs
 *     `RESET ALL`, which resets to the role default this statement defines),
 *   - works on direct connections,
 *   - has no startup race: because it completes before the write pool connects,
 *     every pooled backend inherits the default (the old bug ran it AFTER, so
 *     already-open connections kept the stale "$user, public" path),
 *   - uses no `connect` listener, so it avoids the pg@9 "already executing a
 *     query" deprecation warning.
 * `ALTER ROLE CURRENT_USER` on the role's own settings needs no special
 * privilege. cfg.schema is a validated bare identifier, so inlining is safe.
 * Best-effort: on failure we warn and continue (a DBA may have set it already).
 */
async function ensureRoleSearchPath(host: HostSpec, cfg: PgRuntimeConfig): Promise<void> {
  if (!cfg.applyRoleSearchPath) return;
  const setup = new Pool({ ...poolConfigFor(host, cfg), max: 1 });
  try {
    await setup.query(`ALTER ROLE CURRENT_USER SET search_path TO ${cfg.schema}, public`);
    await logSchemaDiagnostics(setup, cfg);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    globalThis.console.warn(
      `[db] could not ALTER ROLE search_path to "${cfg.schema}" (continuing; ` +
        `set it manually or grant the role ALTER privilege): ${msg}`
    );
  } finally {
    await setup.end().catch(() => {});
  }
}

/**
 * Log the ground truth of the live connection so a "relation does not exist"
 * in production can be diagnosed without shell access: which database/role we
 * actually connected as, the effective search_path on that backend, and which
 * schema a canonical table physically lives in. A mismatch here (e.g. table in
 * a schema not on the path, or connected as a different role than migrations
 * ran under) is the real cause when the schema fix appears not to work.
 */
async function logSchemaDiagnostics(pool: pg.Pool, cfg: PgRuntimeConfig): Promise<void> {
  try {
    const info = await pool.query<{
      db: string;
      usr: string;
      search_path: string;
    }>("SELECT current_database() AS db, current_user AS usr, current_setting('search_path') AS search_path");
    const loc = await pool.query<{ schema: string | null }>(
      "SELECT n.nspname AS schema FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = 'provider_connections' ORDER BY n.nspname"
    );
    const row = info.rows[0];
    const schemas = loc.rows.map((r) => r.schema).filter(Boolean);
    globalThis.console.log(
      `[db] connected db=${row?.db} user=${row?.usr} search_path=${row?.search_path} ` +
        `expected_schema=${cfg.schema} provider_connections_in=[${schemas.join(", ") || "NONE"}]`
    );
    if (schemas.length === 0) {
      globalThis.console.warn(
        `[db] provider_connections not found in ANY schema of database "${row?.db}" — ` +
          `migrations likely ran against a different database/host than this app connects to.`
      );
    } else if (!schemas.includes(cfg.schema)) {
      globalThis.console.warn(
        `[db] provider_connections lives in [${schemas.join(", ")}] but expected_schema is ` +
          `"${cfg.schema}". Set DB_SCHEMA to the actual schema, or re-run migrations into "${cfg.schema}".`
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    globalThis.console.warn(`[db] schema diagnostics failed: ${msg}`);
  }
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
    // Hold the host in a local: a concurrent closePool() (e.g. test teardown)
    // can null out `_writeHost` across the await below, so we must not re-read
    // the mutable module field after awaiting.
    const host = cfg.hosts[0];
    _writeHost = host;
    // Set the role default BEFORE the pool opens any connection, so every
    // pooled backend inherits the schema search_path (no startup race).
    await ensureRoleSearchPath(host, cfg);
    _writePool = makePool(poolConfigFor(host, cfg), cfg);
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
  // Role default before the pool connects (see single-host branch).
  await ensureRoleSearchPath(_writeHost, cfg);
  _writePool = makePool(poolConfigFor(_writeHost, cfg), cfg);

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
    _readPool = makePool(poolConfigFor(_readHost, getConfig()), getConfig());
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

/**
 * src/lib/db/pgConfig.ts — PostgreSQL connection configuration resolver.
 *
 * Resolves a corporate Patroni-style HA topology (multiple hosts behind a
 * cluster manager, one writable primary + one or more read-only replicas) and
 * optional TLS into a concrete `pg.PoolConfig`-compatible shape.
 *
 * Why a dedicated module: `pg` (node-postgres) 8.x has NO native multi-host /
 * `target_session_attrs` failover — a `Pool` binds to exactly one host. So the
 * host list, primary discovery, and SSL options are resolved here and consumed
 * by `postgres.ts`, which owns the live pool + primary-discovery logic.
 *
 * Env surface (DB_* are primary; DATABASE_* are accepted as fallbacks). All
 * optional except a connection source:
 *   DB_URL / DATABASE_URL            connection string; accepts a `jdbc:` prefix and
 *                                    multi-host authority, e.g.
 *                                    jdbc:postgresql://h1:5432,h2:5432/db?sslmode=require
 *   DB_USERNAME / DATABASE_USER      user (overrides any user in the URL)
 *   DB_PASSWORD / DATABASE_PASSWORD  password (overrides any password in the URL)
 *   DB_DATABASE / DATABASE_NAME      database (overrides the URL path)
 *   DB_SCHEMA / DATABASE_SCHEMA      schema / search_path (default: omniroute)
 *   DB_HOSTS / DATABASE_HOSTS        "h1:5432,h2:5432" — cluster hosts, overrides URL hosts
 *   DB_SSL / DATABASE_SSL            disable|require|verify-ca|verify-full|true|false (default: off)
 *   DB_SSL_CA / DATABASE_SSL_CA      path to CA / root cert (PEM)
 *   DB_SSL_CERT / DATABASE_SSL_CERT  path to client cert (PEM)
 *   DB_SSL_KEY / DATABASE_SSL_KEY    path to client key (PEM)
 *   DB_SSL_REJECT_UNAUTHORIZED / DATABASE_SSL_REJECT_UNAUTHORIZED  "true"|"false"
 *   DATABASE_POOL_MAX               max pool clients (default 10)
 *   DATABASE_CONNECT_TIMEOUT_MS     per-connection timeout (default 10000)
 *   DATABASE_PRIMARY_PROBE_TIMEOUT_MS  per-host primary probe timeout (default 5000)
 */

import { readFileSync } from "node:fs";
import type { ConnectionOptions as TlsConnectionOptions } from "node:tls";

/** First non-empty env var among `names`, trimmed. */
function envFirst(...names: string[]): string | undefined {
  for (const name of names) {
    const v = process.env[name];
    if (v && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

export const DEFAULT_DATABASE_URL = "postgres://omniroute:omniroute@localhost:5432/omniroute_test";
const DEFAULT_PORT = 5432;

export interface HostSpec {
  host: string;
  port: number;
}

/** `false`/object => SSL config passed to the TLSSocket; `false` => plaintext. */
export type PgSslConfig = false | (TlsConnectionOptions & { rejectUnauthorized?: boolean });

export interface PgRuntimeConfig {
  hosts: HostSpec[];
  user?: string;
  password?: string;
  database?: string;
  /** Postgres schema applied via `search_path` on every connection. */
  schema: string;
  /** Whether to `ALTER ROLE ... SET search_path` to pin the schema (default true). */
  applyRoleSearchPath: boolean;
  ssl: PgSslConfig;
  max: number;
  connectionTimeoutMillis: number;
  /** Per-host timeout for the `pg_is_in_recovery()` primary probe. */
  primaryProbeTimeoutMillis: number;
}

export const DEFAULT_SCHEMA = "omniroute";

/**
 * Validate a schema/identifier for safe inline use in `search_path`. Postgres
 * identifiers are letters/digits/underscores (not starting with a digit). We
 * reject anything else rather than attempt to quote-escape, since this value
 * comes from trusted env config, not user input.
 */
export function resolveSchema(): string {
  const raw = envFirst("DB_SCHEMA", "DATABASE_SCHEMA");
  if (!raw) return DEFAULT_SCHEMA;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) {
    throw new Error(
      `Invalid DB_SCHEMA "${raw}": must match [A-Za-z_][A-Za-z0-9_]* (no quoting/special chars).`
    );
  }
  return raw;
}

export interface ParsedConnString {
  hosts: HostSpec[];
  user?: string;
  password?: string;
  database?: string;
  sslmode?: string;
}

/**
 * Parse a Postgres connection string into its parts. Beyond the standard
 * `postgres://`/`postgresql://` URL it tolerates two corporate/JDBC conventions
 * that the WHATWG URL parser (and pg-connection-string) reject:
 *   - a leading `jdbc:` prefix (`jdbc:postgresql://…`), and
 *   - a multi-host authority (`host1:5432,host2:5432`) for Patroni clusters.
 * Userinfo/host/port/db/query are split manually so the comma-separated host
 * list survives; only the query string is read for `sslmode`.
 */
export function parseConnString(raw: string, defaultPort: number): ParsedConnString {
  let s = raw.trim();
  if (s.toLowerCase().startsWith("jdbc:")) s = s.slice("jdbc:".length);

  const schemeMatch = s.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//);
  if (schemeMatch) s = s.slice(schemeMatch[0].length);

  // Split off query string (?a=b&c=d).
  let query = "";
  const qIdx = s.indexOf("?");
  if (qIdx >= 0) {
    query = s.slice(qIdx + 1);
    s = s.slice(0, qIdx);
  }

  // Split userinfo@authority/path. Userinfo may contain ':'; use the LAST '@'.
  let userinfo = "";
  const atIdx = s.lastIndexOf("@");
  if (atIdx >= 0) {
    userinfo = s.slice(0, atIdx);
    s = s.slice(atIdx + 1);
  }

  // Split authority (hosts) from path (/database).
  const slashIdx = s.indexOf("/");
  const authority = slashIdx >= 0 ? s.slice(0, slashIdx) : s;
  const database = slashIdx >= 0 ? decodeURIComponent(s.slice(slashIdx + 1)) || undefined : undefined;

  let user: string | undefined;
  let password: string | undefined;
  if (userinfo) {
    const colon = userinfo.indexOf(":");
    if (colon >= 0) {
      user = decodeURIComponent(userinfo.slice(0, colon));
      password = decodeURIComponent(userinfo.slice(colon + 1));
    } else {
      user = decodeURIComponent(userinfo);
    }
  }

  let sslmode: string | undefined;
  for (const pair of query.split("&")) {
    const [k, v] = pair.split("=");
    if (k === "sslmode" && v) sslmode = decodeURIComponent(v);
  }

  return {
    hosts: parseHostList(authority, defaultPort),
    user,
    password,
    database,
    sslmode,
  };
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) return fallback;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function boolFromEnv(name: string): boolean | undefined {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return undefined;
  if (raw === "true" || raw === "1" || raw === "yes") return true;
  if (raw === "false" || raw === "0" || raw === "no") return false;
  return undefined;
}

function resolveDatabaseUrl(): string {
  const url = envFirst("DB_URL", "DATABASE_URL");
  if (url) return url;
  if (process.env.NODE_ENV === "production") {
    throw new Error("DB_URL (or DATABASE_URL) environment variable is required in production");
  }
  return DEFAULT_DATABASE_URL;
}

/** Parse "h1:5432,h2,h3:5433" → HostSpec[]. Empty/blank → []. */
export function parseHostList(raw: string | undefined, defaultPort: number): HostSpec[] {
  if (!raw || raw.trim().length === 0) return [];
  const specs: HostSpec[] = [];
  for (const piece of raw.split(",")) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    // IPv6 in brackets: [::1]:5432
    const v6 = trimmed.match(/^\[(.+)\](?::(\d+))?$/);
    if (v6) {
      specs.push({ host: v6[1], port: v6[2] ? Number.parseInt(v6[2], 10) : defaultPort });
      continue;
    }
    const idx = trimmed.lastIndexOf(":");
    if (idx > 0 && /^\d+$/.test(trimmed.slice(idx + 1))) {
      specs.push({ host: trimmed.slice(0, idx), port: Number.parseInt(trimmed.slice(idx + 1), 10) });
    } else {
      specs.push({ host: trimmed, port: defaultPort });
    }
  }
  return specs;
}

/**
 * Resolve SSL config. Precedence:
 *   1. DATABASE_SSL env (explicit mode) wins over the URL's sslmode.
 *   2. CA/cert/key file paths are attached when provided.
 *   3. DATABASE_SSL_REJECT_UNAUTHORIZED overrides verification last.
 *
 * Modes:
 *   disable / false      → plaintext (false)
 *   require / true       → encrypt, do NOT verify CA (rejectUnauthorized:false unless CA given)
 *   verify-ca            → verify CA chain, skip hostname check
 *   verify-full          → verify CA chain + hostname
 */
export function resolveSslConfig(urlSslmode?: string): PgSslConfig {
  const mode = envFirst("DB_SSL", "DATABASE_SSL")?.toLowerCase();
  const caPath = envFirst("DB_SSL_CA", "DATABASE_SSL_CA");
  const certPath = envFirst("DB_SSL_CERT", "DATABASE_SSL_CERT");
  const keyPath = envFirst("DB_SSL_KEY", "DATABASE_SSL_KEY");
  const rejectOverride =
    boolFromEnv("DB_SSL_REJECT_UNAUTHORIZED") ?? boolFromEnv("DATABASE_SSL_REJECT_UNAUTHORIZED");

  // Effective mode: explicit env mode wins, else infer from the URL's sslmode.
  const src = mode ?? urlSslmode?.toLowerCase();
  let effective: "disable" | "require" | "verify-ca" | "verify-full";
  if (!src || src === "disable" || src === "false" || src === "off") {
    effective = "disable";
  } else if (src === "require" || src === "true" || src === "on" || src === "prefer" || src === "allow") {
    effective = "require";
  } else if (src === "verify-ca") {
    effective = "verify-ca";
  } else if (src === "verify-full") {
    effective = "verify-full";
  } else {
    effective = "require"; // unknown but truthy → encrypt
  }

  if (effective === "disable") return false;

  const ssl: TlsConnectionOptions & { rejectUnauthorized?: boolean } = {};

  if (caPath) ssl.ca = readFileSync(caPath, "utf8");
  if (certPath) ssl.cert = readFileSync(certPath, "utf8");
  if (keyPath) ssl.key = readFileSync(keyPath, "utf8");

  if (effective === "require") {
    // Encrypt in transit, but don't fail on self-signed unless a CA is pinned.
    ssl.rejectUnauthorized = caPath ? true : false;
  } else if (effective === "verify-ca") {
    ssl.rejectUnauthorized = true;
    // Verify the CA chain but skip hostname identity (Patroni VIP / floating IP).
    ssl.checkServerIdentity = () => undefined;
  } else {
    // verify-full: verify CA chain AND hostname.
    ssl.rejectUnauthorized = true;
  }

  // Explicit override always wins (e.g. corporate CA not yet on the box).
  if (rejectOverride !== undefined) ssl.rejectUnauthorized = rejectOverride;

  return ssl;
}

/** Resolve the full Postgres runtime configuration from the environment. */
export function resolvePgConfig(): PgRuntimeConfig {
  const parsed = parseConnString(resolveDatabaseUrl(), DEFAULT_PORT);

  // Discrete DB_*/DATABASE_* vars override whatever the URL carried.
  const hostsOverride = parseHostList(envFirst("DB_HOSTS", "DATABASE_HOSTS"), DEFAULT_PORT);
  let hosts = hostsOverride.length > 0 ? hostsOverride : parsed.hosts;
  if (hosts.length === 0) hosts = [{ host: "localhost", port: DEFAULT_PORT }];

  return {
    hosts,
    user: envFirst("DB_USERNAME", "DATABASE_USER") ?? parsed.user,
    password: envFirst("DB_PASSWORD", "DATABASE_PASSWORD") ?? parsed.password,
    database: envFirst("DB_DATABASE", "DATABASE_NAME") ?? parsed.database,
    schema: resolveSchema(),
    applyRoleSearchPath:
      (boolFromEnv("DB_APPLY_ROLE_SEARCH_PATH") ??
        boolFromEnv("DATABASE_APPLY_ROLE_SEARCH_PATH")) !== false,
    ssl: resolveSslConfig(parsed.sslmode),
    max: intFromEnv("DATABASE_POOL_MAX", 10),
    connectionTimeoutMillis: intFromEnv("DATABASE_CONNECT_TIMEOUT_MS", 10_000),
    primaryProbeTimeoutMillis: intFromEnv("DATABASE_PRIMARY_PROBE_TIMEOUT_MS", 5_000),
  };
}

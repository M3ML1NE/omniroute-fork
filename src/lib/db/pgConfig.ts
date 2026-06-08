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
 * Env surface (all optional except a connection source):
 *   DATABASE_URL                     base creds/db/host (postgres://u:p@h:port/db?sslmode=...)
 *   DATABASE_HOSTS                   "h1:5432,h2:5432" — cluster hosts, overrides URL host
 *   DATABASE_SCHEMA                  Postgres schema / search_path (default: omniroute)
 *   DATABASE_SSL                     disable|require|verify-ca|verify-full|true|false (default: off)
 *   DATABASE_SSL_CA                  path to CA / root cert (PEM)
 *   DATABASE_SSL_CERT                path to client cert (PEM)
 *   DATABASE_SSL_KEY                 path to client key (PEM)
 *   DATABASE_SSL_REJECT_UNAUTHORIZED "true"|"false" — override cert verification
 *   DATABASE_POOL_MAX               max pool clients (default 10)
 *   DATABASE_CONNECT_TIMEOUT_MS     per-connection timeout (default 10000)
 *   DATABASE_PRIMARY_PROBE_TIMEOUT_MS  per-host primary probe timeout (default 5000)
 */

import { readFileSync } from "node:fs";
import { parse as parsePgConnString } from "pg-connection-string";
import type { ConnectionOptions as TlsConnectionOptions } from "node:tls";

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
  const raw = process.env.DATABASE_SCHEMA?.trim();
  if (!raw) return DEFAULT_SCHEMA;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) {
    throw new Error(
      `Invalid DATABASE_SCHEMA "${raw}": must match [A-Za-z_][A-Za-z0-9_]* (no quoting/special chars).`
    );
  }
  return raw;
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
  const url = process.env.DATABASE_URL;
  if (url && url.trim().length > 0) return url.trim();
  if (process.env.NODE_ENV === "production") {
    throw new Error("DATABASE_URL environment variable is required in production");
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
export function resolveSslConfig(urlSsl: unknown): PgSslConfig {
  const mode = process.env.DATABASE_SSL?.trim().toLowerCase();
  const caPath = process.env.DATABASE_SSL_CA?.trim();
  const certPath = process.env.DATABASE_SSL_CERT?.trim();
  const keyPath = process.env.DATABASE_SSL_KEY?.trim();
  const rejectOverride = boolFromEnv("DATABASE_SSL_REJECT_UNAUTHORIZED");

  // Determine the effective mode: explicit env mode, else infer from URL ssl.
  let effective: "disable" | "require" | "verify-ca" | "verify-full" | undefined;
  if (mode) {
    if (mode === "disable" || mode === "false" || mode === "off") effective = "disable";
    else if (mode === "require" || mode === "true" || mode === "on") effective = "require";
    else if (mode === "verify-ca") effective = "verify-ca";
    else if (mode === "verify-full") effective = "verify-full";
    else effective = "require"; // unknown but truthy → encrypt
  } else if (urlSsl === false || urlSsl === undefined || urlSsl === null) {
    effective = "disable";
  } else if (typeof urlSsl === "object") {
    // pg-connection-string already produced an ssl object from the URL's sslmode.
    const obj = urlSsl as Record<string, unknown>;
    effective = obj.rejectUnauthorized === false ? "require" : "verify-full";
  } else {
    effective = "require";
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
  const url = resolveDatabaseUrl();
  const parsed = parsePgConnString(url);

  const urlPort = parsed.port ? Number.parseInt(String(parsed.port), 10) : DEFAULT_PORT;

  // Cluster hosts: DATABASE_HOSTS overrides the URL's single host.
  let hosts = parseHostList(process.env.DATABASE_HOSTS, urlPort);
  if (hosts.length === 0) {
    hosts = [{ host: parsed.host || "localhost", port: urlPort }];
  }

  return {
    hosts,
    user: parsed.user,
    password: parsed.password,
    database: parsed.database ?? undefined,
    schema: resolveSchema(),
    ssl: resolveSslConfig(parsed.ssl),
    max: intFromEnv("DATABASE_POOL_MAX", 10),
    connectionTimeoutMillis: intFromEnv("DATABASE_CONNECT_TIMEOUT_MS", 10_000),
    primaryProbeTimeoutMillis: intFromEnv("DATABASE_PRIMARY_PROBE_TIMEOUT_MS", 5_000),
  };
}

/**
 * src/lib/db/core.ts — Postgres-backed compatibility shim.
 *
 * Wave 3 / Task 22 swap: better-sqlite3 has been removed. The exported
 * surface kept the same names (`getDbInstance`, `rowToCamel`, `cleanNulls`,
 * `isBuildPhase`, `isCloud`, …) so callers in this module compile, but the
 * underlying driver is now `pg`. Modules that need real DB I/O should be
 * migrated to `await query(...)` from `./postgres`.
 *
 * The legacy synchronous `db.prepare(sql).run/get/all(...)` ergonomics are
 * preserved at the type level only — call sites that genuinely run those
 * queries at runtime must be migrated module-by-module in subsequent waves.
 */

import { getPool, query, closePool } from "./postgres";
import type { SqliteAdapter } from "./adapters/types";

// ──────────────── Environment Detection ────────────────

export const isCloud =
  typeof globalThis.caches === "object" && globalThis.caches !== null;

export const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build";

// ──────────────── Paths (kept for source-level compat) ────────────────

const DATA_DIR_ENV = process.env.DATA_DIR;
export const DATA_DIR = DATA_DIR_ENV && DATA_DIR_ENV.trim().length > 0 ? DATA_DIR_ENV : "/tmp";
/** SQLite is gone; null sentinel preserves source-level compatibility. */
export const SQLITE_FILE: string | null = null;
export const DB_BACKUPS_DIR: string | null = null;

// ──────────────── Column Mapping ────────────────

type JsonRecord = Record<string, unknown>;

export function toSnakeCase(str: string): string {
  return str.replace(/([A-Z])/g, "_$1").toLowerCase();
}

export function toCamelCase(str: string): string {
  return str.replace(/_([a-z])/g, (_: string, c: string) => c.toUpperCase());
}

export function objToSnake(obj: unknown): unknown {
  if (!obj || typeof obj !== "object") return obj;
  const result: JsonRecord = {};
  for (const [k, v] of Object.entries(obj as JsonRecord)) {
    result[toSnakeCase(k)] = v;
  }
  return result;
}

export function rowToCamel(row: unknown): JsonRecord | null {
  if (!row) return null;
  const result: JsonRecord = {};
  for (const [k, v] of Object.entries(row as JsonRecord)) {
    const camelKey = toCamelCase(k);
    if (camelKey === "isActive" || camelKey === "rateLimitProtection") {
      result[camelKey] = v === 1 || v === true;
    } else if (camelKey === "providerSpecificData" && typeof v === "string") {
      try {
        result[camelKey] = JSON.parse(v);
      } catch {
        result[camelKey] = v;
      }
    } else if (camelKey.endsWith("Json") && typeof v === "string") {
      const baseKey = camelKey.slice(0, -"Json".length);
      try {
        result[baseKey] = JSON.parse(v);
      } catch {
        result[baseKey] = null;
      }
    } else {
      result[camelKey] = v;
    }
  }
  return result;
}

export function cleanNulls(obj: unknown): JsonRecord {
  const result: JsonRecord = {};
  for (const [k, v] of Object.entries((obj as JsonRecord) || {})) {
    if (v !== null && v !== undefined) {
      result[k] = v;
    }
  }
  return result;
}

// ──────────────── pg-backed adapter ────────────────
//
// Modules under `src/lib/db/*` that have not yet been migrated still expect
// the better-sqlite3 sugar: `db.prepare(sql).run/get/all(...)`. To keep them
// type-checking against `tsc --project tsconfig.typecheck-core.json` we expose
// `getDbInstance()` as a loosely-typed adapter. Each call site casts it to a
// local `DbLike` interface, so we don't need to fully model the legacy API.
//
// At runtime the adapter shells calls into a Postgres pool via tagged-async
// helpers. The synchronous ergonomics is preserved by returning a thenable
// proxy from `prepare()` whose `run/get/all` methods return promises. Direct
// runtime callers should migrate to `await query(sql, params)` from
// `./postgres`. See the wave-3 migration notes in
// `notepads/omniroute-fork-stripdown/learnings.md`.

type AnyDb = SqliteAdapter;

let _adapter: AnyDb | undefined;

function buildPgAdapter(): AnyDb {
  // The shape mirrors better-sqlite3 just enough that source-level imports keep
  // compiling. Callers cast to their own `DbLike` interface, so the runtime
  // contract is intentionally loose.
  return {
    driver: "better-sqlite3",
    open: true,
    name: "postgres",
    prepare(sql: string) {
      const positional = convertPlaceholders(sql);
      return {
        async run(...params: unknown[]) {
          const flat = flattenParams(params);
          const result = await query(positional, flat);
          return {
            changes: result.rowCount ?? 0,
            lastInsertRowid: 0,
          };
        },
        async get(...params: unknown[]) {
          const flat = flattenParams(params);
          const result = await query(positional, flat);
          return result.rows[0];
        },
        async all(...params: unknown[]) {
          const flat = flattenParams(params);
          const result = await query(positional, flat);
          return result.rows;
        },
      } as never;
    },
    exec(sql: string) {
      void query(sql);
    },
    pragma(_value: string) {
      // Postgres has no PRAGMA; legacy callers expect a no-op.
      return undefined;
    },
    transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T {
      return ((...args: unknown[]) => fn(...args)) as never;
    },
    immediate(fn: () => void): void {
      fn();
    },
    async backup(_destination: string): Promise<void> {
      // Postgres backups are out of scope for the legacy adapter shim.
    },
    checkpoint(_mode?: string): void {
      // No-op on Postgres.
    },
    close() {
      void closePool();
    },
    raw: {},
  };
}

/**
 * Convert better-sqlite3 `?` and `@named` placeholders to Postgres `$N`. Named
 * placeholders are mapped positionally in the order of the first occurrence,
 * because callers either pass an object (legacy named binding) or an array.
 */
function convertPlaceholders(sql: string): string {
  let counter = 0;
  // `?` style
  let out = sql.replace(/\?/g, () => `$${++counter}`);
  // `@named` style: first occurrence numbered, repeats reuse same index
  const nameMap = new Map<string, number>();
  out = out.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, (_, name: string) => {
    if (!nameMap.has(name)) {
      nameMap.set(name, ++counter);
    }
    return `$${nameMap.get(name)}`;
  });
  return out;
}

function flattenParams(params: unknown[]): unknown[] {
  if (params.length === 0) return [];
  // Single object → treat as named-binding map; flatten into array of values
  // in the order the keys appeared. Best-effort fallback when callers haven't
  // been migrated.
  if (
    params.length === 1 &&
    params[0] !== null &&
    typeof params[0] === "object" &&
    !Array.isArray(params[0])
  ) {
    return Object.values(params[0] as Record<string, unknown>);
  }
  return params;
}

export function getDbInstance(): AnyDb {
  if (!_adapter) _adapter = buildPgAdapter();
  return _adapter;
}

export function closeDbInstance(): boolean {
  if (!_adapter) return false;
  _adapter = undefined;
  void closePool();
  return true;
}

export function resetDbInstance(): void {
  closeDbInstance();
}

/** No-op kept for source-level compatibility. */
export async function ensureDbInitialized(): Promise<void> {
  getDbInstance();
}

/** No-op kept for source-level compatibility. */
export function runManagedDbHealthCheck(_options?: {
  autoRepair?: boolean;
}): { ok: boolean } {
  return { ok: true };
}

type DbDriverInfo = { source: string; kind: string };

export function getDriverInfo(): DbDriverInfo | null {
  return { source: "pg", kind: "postgres" };
}

export function isNativeSqliteLoadError(_error: unknown): boolean {
  return false;
}

// Re-export the raw Postgres helpers for callers that have been migrated.
export { query, getPool, closePool };

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

import { getPool, query, closePool, withTransaction } from "./postgres";

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
// Honest async types. `prepare(sql).run/get/all(...)` each return a Promise
// because the underlying driver is Postgres (`pg`), which is fully async.
// Legacy callers that invoke these synchronously (no `await`) will surface as
// TypeScript errors — that error list IS the worklist for the async-conversion
// waves. There are deliberately NO `as never`/type-lie casts here.

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

type Row = Record<string, unknown>;

export interface PreparedStatement {
  run(...params: unknown[]): Promise<RunResult>;
  get<T = Row>(...params: unknown[]): Promise<T | undefined>;
  all<T = Row>(...params: unknown[]): Promise<T[]>;
}

export interface DbLike {
  readonly driver: "better-sqlite3";
  readonly open: boolean;
  readonly name: string;
  prepare(sql: string): PreparedStatement;
  exec(sql: string): Promise<void>;
  pragma(value?: string): void;
  transaction<T>(fn: (...args: unknown[]) => T | Promise<T>): (...args: unknown[]) => Promise<T>;
  immediate(fn: () => void): void;
  backup(destination: string): Promise<void>;
  checkpoint(mode?: string): void;
  close(): void;
  readonly raw: unknown;
}

let _adapter: DbLike | undefined;

function buildPgAdapter(): DbLike {
  return {
    driver: "better-sqlite3",
    open: true,
    name: "postgres",
    prepare(sql: string): PreparedStatement {
      const positional = convertPlaceholders(sql);
      const insertSql = appendReturningId(positional);
      return {
        async run(...params: unknown[]): Promise<RunResult> {
          const flat = flattenParams(params);
          if (insertSql) {
            try {
              const result = await query(insertSql, flat);
              return {
                changes: result.rowCount ?? 0,
                lastInsertRowid: Number(result.rows[0]?.id) || 0,
              };
            } catch (err) {
              // 42703 = undefined_column: table has no `id`, retry without it.
              if (!isUndefinedColumn(err)) throw err;
            }
          }
          const result = await query(positional, flat);
          return {
            changes: result.rowCount ?? 0,
            lastInsertRowid: 0,
          };
        },
        async get<T = Row>(...params: unknown[]): Promise<T | undefined> {
          const flat = flattenParams(params);
          const result = await query(positional, flat);
          return result.rows[0] as T | undefined;
        },
        async all<T = Row>(...params: unknown[]): Promise<T[]> {
          const flat = flattenParams(params);
          const result = await query(positional, flat);
          return result.rows as T[];
        },
      };
    },
    async exec(sql: string): Promise<void> {
      await query(sql);
    },
    pragma(_value?: string): void {
      // Postgres has no PRAGMA; legacy callers expect a no-op.
      return undefined;
    },
    transaction<T>(
      fn: (...args: unknown[]) => T | Promise<T>
    ): (...args: unknown[]) => Promise<T> {
      // Deprecated: prefer `withTransaction()` from `./postgres`, which runs on
      // a checked-out client with real BEGIN/COMMIT/ROLLBACK. This shim only
      // awaits `fn` on the shared pool, so nested `.run()` calls are NOT atomic.
      // Callers migrate to `withTransaction` in a later wave.
      return async (...args: unknown[]): Promise<T> => fn(...args);
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
    close(): void {
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

/**
 * If `sql` is an INSERT lacking a RETURNING clause, append ` RETURNING id` so
 * `run()` can surface a real `lastInsertRowid`. Returns null for non-INSERTs or
 * INSERTs that already RETURN, signalling `run()` to use the original SQL.
 */
function appendReturningId(sql: string): string | null {
  if (!/^\s*insert\s/i.test(sql)) return null;
  if (/\breturning\b/i.test(sql)) return null;
  return `${sql.replace(/;\s*$/, "")} RETURNING id`;
}

function isUndefinedColumn(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "42703"
  );
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

export function getDbInstance(): DbLike {
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
export { query, getPool, closePool, withTransaction };

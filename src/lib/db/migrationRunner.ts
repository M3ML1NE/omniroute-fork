/**
 * Migration Runner — Postgres baseline applier.
 *
 * The SQLite-era incremental runner (74 `NNN_*.sql` files, `PRAGMA table_info`
 * idempotency checks, `datetime('now')` defaults, synchronous better-sqlite3
 * `db.exec()`) has been retired. OmniRoute now runs on Postgres and the schema
 * is owned by a single CONSOLIDATED baseline at
 * `db/migrations/postgres/0001_baseline.sql`. That baseline is fully idempotent
 * (`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` throughout), so
 * applying it once on a fresh database reaches the exact same shape a fully
 * migrated SQLite database used to have.
 *
 * This module is a thin, idempotent applier:
 *   1. Ensures a Postgres tracking table `_omniroute_migrations` exists.
 *   2. Reads `*.sql` files from the Postgres migrations directory in
 *      lexicographic order.
 *   3. Applies any file not yet recorded, each inside its own transaction.
 *   4. Records the filename so re-runs are a no-op (returns 0).
 *
 * There is NO SQLite logic here: no `PRAGMA`, no `datetime('now')`, no
 * synchronous `db.exec()`, no `SqliteAdapter`. Everything is async and runs
 * against the shared `pg` pool exposed by `./postgres`.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query, withTransaction, getSchema } from "./postgres";

const isNodeTestRunnerChild = typeof process.env.NODE_TEST_CONTEXT === "string";

const console = {
  log: (...args: unknown[]) => {
    if (!isNodeTestRunnerChild) globalThis.console.log(...args);
  },
  warn: (...args: unknown[]) => {
    if (!isNodeTestRunnerChild) globalThis.console.warn(...args);
  },
  error: (...args: unknown[]) => {
    globalThis.console.error(...args);
  },
};

/**
 * Resolve the Postgres migrations directory (`db/migrations/postgres`).
 *
 * Honours `OMNIROUTE_PG_MIGRATIONS_DIR` when set, otherwise walks up from this
 * module's location (and finally `process.cwd()`) looking for the directory.
 * This mirrors the defensive resolution the SQLite runner used so global npm
 * installs and CI build paths keep working.
 */
function resolvePostgresMigrationsDir(): string {
  const configuredDir = process.env.OMNIROUTE_PG_MIGRATIONS_DIR;
  if (typeof configuredDir === "string" && configuredDir.trim().length > 0) {
    return path.resolve(configuredDir);
  }

  const candidate = (basePath: string) => path.join(basePath, "db", "migrations", "postgres");

  const walkUp = (start: string): string | null => {
    let currentDir = start;
    while (currentDir !== path.dirname(currentDir)) {
      const loc = candidate(currentDir);
      if (fs.existsSync(loc)) return loc;
      currentDir = path.dirname(currentDir);
    }
    return null;
  };

  try {
    const fromModule = walkUp(path.dirname(fileURLToPath(import.meta.url)));
    if (fromModule) return fromModule;
  } catch {
    // import.meta.url not a usable file:// URL (rare Windows/global-install
    // case); fall through to cwd-based resolution below.
  }

  const fromCwd = walkUp(path.resolve(process.cwd()));
  if (fromCwd) return fromCwd;

  throw new Error(
    "[Migration] Could not resolve Postgres migrations directory " +
      "(db/migrations/postgres). Set OMNIROUTE_PG_MIGRATIONS_DIR."
  );
}

interface PgMigrationFile {
  filename: string;
  fullPath: string;
}

/** List `*.sql` files in the Postgres migrations directory, sorted by name. */
function getPostgresMigrationFiles(): PgMigrationFile[] {
  const dir = resolvePostgresMigrationsDir();
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((filename) => ({ filename, fullPath: path.join(dir, filename) }));
}

/**
 * Ensure OmniRoute's schema and the migration-tracking table exist. Objects are
 * schema-qualified (`<schema>.name`) so the runner never depends on search_path
 * already being set — it bootstraps the schema before the role default applies.
 * Schema name is a validated identifier from pgConfig, so inlining it is
 * injection-safe.
 */
async function ensureMigrationsTable(): Promise<void> {
  const schema = getSchema();
  await query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await query(
    `CREATE TABLE IF NOT EXISTS ${schema}._omniroute_migrations (
       filename TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`
  );
}

/** Fetch the set of already-applied migration filenames. */
async function getAppliedFilenames(): Promise<Set<string>> {
  const result = await query<{ filename: string }>(
    `SELECT filename FROM ${getSchema()}._omniroute_migrations ORDER BY filename`
  );
  return new Set(result.rows.map((r) => r.filename));
}

/**
 * Apply all pending Postgres migrations (the consolidated baseline and any
 * future additive files) in lexicographic order. Returns the number applied.
 *
 * Idempotent: files already recorded in `_omniroute_migrations` are skipped,
 * and the baseline SQL is itself `IF NOT EXISTS`-guarded, so a re-run on an
 * up-to-date database performs no work and resolves to `0`.
 *
 * Each file is applied inside its own transaction (BEGIN/COMMIT, ROLLBACK on
 * error) on a dedicated pooled connection. The optional parameters are accepted
 * only for source-level compatibility with the retired SQLite signature and are
 * ignored — there is no SQLite adapter anymore.
 */
export async function runMigrations(
  _legacyDb?: unknown,
  _options?: { isNewDb?: boolean }
): Promise<number> {
  await ensureMigrationsTable();

  const applied = await getAppliedFilenames();
  const files = getPostgresMigrationFiles();

  const pending = files.filter((f) => !applied.has(f.filename));
  if (pending.length === 0) {
    return 0;
  }

  const schema = getSchema();
  let count = 0;
  for (const migration of pending) {
    const sql = fs.readFileSync(migration.fullPath, "utf8").trim();
    try {
      await withTransaction(async (client) => {
        // Scope search_path to this migration's transaction so the baseline's
        // unqualified CREATE TABLEs land in OmniRoute's schema regardless of the
        // role default (which a pooler may not have applied to this backend yet).
        await client.query(`SET LOCAL search_path TO ${schema}, public`);
        if (sql) {
          await client.query(sql);
        }
        await client.query(
          `INSERT INTO ${schema}._omniroute_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING`,
          [migration.filename]
        );
      });
      count++;
      console.log(`[Migration] Applied: ${migration.filename}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Migration] FAILED: ${migration.filename} — ${message}`);
      throw err; // Re-throw so boot/migrate aborts on an inconsistent schema.
    }
  }

  if (count > 0) {
    console.log(`[Migration] ${count} migration(s) applied successfully.`);
  }

  return count;
}

/**
 * Report applied and pending Postgres migrations for diagnostics. The optional
 * parameter is ignored (kept only for source-level compatibility with the
 * retired SQLite signature).
 */
export async function getMigrationStatus(_legacyDb?: unknown): Promise<{
  applied: Array<{ filename: string; applied_at: string }>;
  pending: Array<{ filename: string }>;
}> {
  await ensureMigrationsTable();

  const result = await query<{ filename: string; applied_at: string }>(
    `SELECT filename, applied_at FROM ${getSchema()}._omniroute_migrations ORDER BY filename`
  );
  const appliedNames = new Set(result.rows.map((r) => r.filename));
  const pending = getPostgresMigrationFiles()
    .filter((f) => !appliedNames.has(f.filename))
    .map((f) => ({ filename: f.filename }));

  return { applied: result.rows, pending };
}

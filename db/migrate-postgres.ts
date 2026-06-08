/**
 * Postgres migration entrypoint (`npm run db:migrate`).
 *
 * This is a thin CLI wrapper around the canonical applier in
 * `src/lib/db/migrationRunner.ts`. Both the boot path and this script now share
 * the SAME Postgres-aware logic: apply `db/migrations/postgres/*.sql` (the
 * consolidated 77-table baseline) idempotently, tracking applied files in the
 * Postgres `_omniroute_migrations` table. There is no SQLite logic anywhere in
 * the path — no PRAGMA, no `datetime('now')`, no synchronous `db.exec()`.
 *
 * The runner connects through the shared `pg` pool in `src/lib/db/postgres.ts`,
 * which resolves `DATABASE_URL` (required in production).
 */
import { runMigrations, getMigrationStatus } from "../src/lib/db/migrationRunner";
import { closePool } from "../src/lib/db/postgres";

async function migrate(): Promise<void> {
  const url = process.env.DB_URL ?? process.env.DATABASE_URL;
  if (!url || url.trim().length === 0) {
    throw new Error("DB_URL (or DATABASE_URL) environment variable required");
  }

  const before = await getMigrationStatus();
  if (before.pending.length === 0) {
    console.log("No pending migrations; database is up to date.");
  }

  const applied = await runMigrations();

  if (applied === 0) {
    console.log("Migrations complete (no changes).");
  } else {
    console.log(`Migrations complete (${applied} applied).`);
  }
}

migrate()
  .then(() => closePool())
  .catch(async (err) => {
    console.error("Migration failed:", err instanceof Error ? err.message : String(err));
    await closePool().catch(() => {});
    process.exit(1);
  });

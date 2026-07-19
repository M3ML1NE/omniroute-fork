import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const pgModule = await import("../../../src/lib/db/postgres.ts");

const MIGRATION_SQL = fs.readFileSync(
  path.join(process.cwd(), "db/migrations/postgres/0017_call_logs_request_upstream_api.sql"),
  "utf8"
);

async function runMigration() {
  await pgModule.query(MIGRATION_SQL);
}

async function columnExists(column: string): Promise<boolean> {
  const schema = pgModule.getSchema();
  const result = await pgModule.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'call_logs' AND column_name = $2
     ) AS exists`,
    [schema, column]
  );
  return result.rows[0].exists;
}

// 0017 is a plain additive migration (ALTER TABLE ... ADD COLUMN IF NOT EXISTS
// + CREATE INDEX IF NOT EXISTS) already applied once by the shared test DB's
// `npm run db:migrate` bootstrap. This proves running its SQL again — exactly
// what the runner does when a migration file is re-applied to an already
// up-to-date database — is a true no-op: no error, columns present both times.
test("0017_call_logs_request_upstream_api: idempotent re-run adds no duplicate columns/errors", async () => {
  // First run: matches the state already applied by the test DB bootstrap.
  await runMigration();
  assert.equal(await columnExists("request_id"), true, "request_id column present after run 1");
  assert.equal(
    await columnExists("upstream_api_version"),
    true,
    "upstream_api_version column present after run 1"
  );

  // Second run: must not throw and must leave the schema unchanged.
  await runMigration();
  assert.equal(
    await columnExists("request_id"),
    true,
    "request_id column still present after run 2"
  );
  assert.equal(
    await columnExists("upstream_api_version"),
    true,
    "upstream_api_version column still present after run 2"
  );
});

test("0017_call_logs_request_upstream_api: request_id index exists", async () => {
  const schema = pgModule.getSchema();
  const result = await pgModule.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_indexes
       WHERE schemaname = $1 AND tablename = 'call_logs' AND indexname = 'idx_call_logs_request_id'
     ) AS exists`,
    [schema]
  );
  assert.equal(result.rows[0].exists, true, "idx_call_logs_request_id index exists");
});

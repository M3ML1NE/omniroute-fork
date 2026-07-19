import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-mlproxy-purge-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../../src/lib/db/core.ts");
const pgModule = await import("../../../src/lib/db/postgres.ts");

const RUN_PREFIX = `mlproxy-purge-${process.pid}`;

const MIGRATION_SQL = fs.readFileSync(
  path.join(process.cwd(), "db/migrations/postgres/0012_purge_mlproxy_providers.sql"),
  "utf8"
);

function serialTest(name: string, fn: () => Promise<void>) {
  test(name, { concurrency: false }, fn);
}

async function seedRows() {
  const schema = pgModule.getSchema();
  const now = new Date().toISOString();
  const rows = [
    { id: `${RUN_PREFIX}-mlproxy-1`, provider: "mlproxy" },
    { id: `${RUN_PREFIX}-mlspace-1`, provider: "mlspace" },
    { id: `${RUN_PREFIX}-openai-1`, provider: "openai-compatible" },
    { id: `${RUN_PREFIX}-gigachat-1`, provider: "gigachat-compatible" },
  ];
  for (const row of rows) {
    await pgModule.query(
      `INSERT INTO ${schema}.provider_connections (id, provider, created_at, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [row.id, row.provider, now, now]
    );
  }
}

async function countByProvider(provider: string): Promise<number> {
  const schema = pgModule.getSchema();
  const result = await pgModule.query(
    `SELECT COUNT(*)::int AS cnt FROM ${schema}.provider_connections
     WHERE provider = $1 AND id LIKE $2`,
    [provider, `${RUN_PREFIX}-%`]
  );
  return result.rows[0].cnt;
}

async function cleanup() {
  const schema = pgModule.getSchema();
  await pgModule.query(`DELETE FROM ${schema}.provider_connections WHERE id LIKE $1`, [
    `${RUN_PREFIX}-%`,
  ]);
  core.resetDbInstance();
}

test.beforeEach(async () => {
  await cleanup();
});

test.after(async () => {
  await cleanup();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

serialTest("migration deletes mlproxy and mlspace rows, preserves others", async () => {
  await seedRows();

  const schema = pgModule.getSchema();
  const qualifiedSql = MIGRATION_SQL.replace(
    /\bprovider_connections\b/g,
    `${schema}.provider_connections`
  );
  await pgModule.query(qualifiedSql);

  assert.equal(await countByProvider("mlproxy"), 0, "mlproxy rows must be deleted");
  assert.equal(await countByProvider("mlspace"), 0, "mlspace rows must be deleted");
  assert.equal(await countByProvider("openai-compatible"), 1, "openai-compatible must survive");
  assert.equal(await countByProvider("gigachat-compatible"), 1, "gigachat-compatible must survive");
});

serialTest("migration is idempotent — second run does not error", async () => {
  await seedRows();

  const schema = pgModule.getSchema();
  const qualifiedSql = MIGRATION_SQL.replace(
    /\bprovider_connections\b/g,
    `${schema}.provider_connections`
  );

  await pgModule.query(qualifiedSql);
  await pgModule.query(qualifiedSql);

  assert.equal(await countByProvider("mlproxy"), 0, "mlproxy still gone after second run");
  assert.equal(await countByProvider("mlspace"), 0, "mlspace still gone after second run");
  assert.equal(await countByProvider("openai-compatible"), 1, "openai-compatible still present");
  assert.equal(
    await countByProvider("gigachat-compatible"),
    1,
    "gigachat-compatible still present"
  );
});

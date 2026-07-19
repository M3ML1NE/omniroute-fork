import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-gigachat-compat-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../../src/lib/db/core.ts");
const pgModule = await import("../../../src/lib/db/postgres.ts");

const RUN_PREFIX = `gigachat-compat-${process.pid}`;

const MIGRATION_SQL = fs.readFileSync(
  path.join(process.cwd(), "db/migrations/postgres/0013_migrate_gigachat_to_compatible.sql"),
  "utf8"
);

function serialTest(name: string, fn: () => Promise<void>) {
  test(name, { concurrency: false }, fn);
}

interface SeedRow {
  id: string;
  provider: string;
  apiKey?: string;
  providerSpecificData?: string;
  defaultModel?: string;
  priority?: number;
  isActive?: number;
}

async function seedRows(rows: SeedRow[]) {
  const schema = pgModule.getSchema();
  const now = new Date().toISOString();
  for (const row of rows) {
    await pgModule.query(
      `INSERT INTO ${schema}.provider_connections
         (id, provider, api_key, provider_specific_data, default_model, priority, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO NOTHING`,
      [
        row.id,
        row.provider,
        row.apiKey ?? null,
        row.providerSpecificData ?? null,
        row.defaultModel ?? null,
        row.priority ?? 0,
        row.isActive ?? 1,
        now,
        now,
      ]
    );
  }
}

interface ProviderConnectionRow {
  provider: string;
  api_key: string | null;
  provider_specific_data: string | null;
  default_model: string | null;
  priority: number;
  is_active: number;
}

async function getRow(id: string): Promise<ProviderConnectionRow | null> {
  const schema = pgModule.getSchema();
  const result = await pgModule.query<ProviderConnectionRow>(
    `SELECT provider, api_key, provider_specific_data, default_model, priority, is_active
     FROM ${schema}.provider_connections WHERE id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}

async function countByProviderPrefix(prefix: string): Promise<number> {
  const schema = pgModule.getSchema();
  const result = await pgModule.query(
    `SELECT COUNT(*)::int AS cnt FROM ${schema}.provider_connections
     WHERE provider LIKE $1 AND id LIKE $2`,
    [`${prefix}%`, `${RUN_PREFIX}-%`]
  );
  return result.rows[0].cnt;
}

async function runMigration() {
  const schema = pgModule.getSchema();
  const qualifiedSql = MIGRATION_SQL.replace(
    /\bprovider_connections\b/g,
    `${schema}.provider_connections`
  );
  await pgModule.query(qualifiedSql);
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

serialTest("migration renames bare gigachat to gigachat-compatible-<id>", async () => {
  const id = `${RUN_PREFIX}-rename-1`;
  await seedRows([
    {
      id,
      provider: "gigachat",
      apiKey: "secret-api-key",
      providerSpecificData: JSON.stringify({ mtls: { cert: "c", key: "k", ca: "a" } }),
      defaultModel: "GigaChat-Pro",
      priority: 5,
      isActive: 1,
    },
  ]);

  await runMigration();

  const row = await getRow(id);
  assert.equal(row?.provider, `gigachat-compatible-${id}`, "provider renamed to id-scoped value");
  assert.equal(row?.api_key, "secret-api-key", "api_key preserved");
  assert.equal(
    row?.provider_specific_data,
    JSON.stringify({ mtls: { cert: "c", key: "k", ca: "a" } }),
    "provider_specific_data (mTLS JSON) preserved"
  );
  assert.equal(row?.default_model, "GigaChat-Pro", "default_model preserved");
  assert.equal(row?.priority, 5, "priority preserved");
  assert.equal(row?.is_active, 1, "is_active preserved");
});

serialTest("migration leaves already-compatible rows untouched", async () => {
  const id = `${RUN_PREFIX}-already-1`;
  const existingProvider = `gigachat-compatible-${id}`;
  await seedRows([{ id, provider: existingProvider }]);

  await runMigration();

  const row = await getRow(id);
  assert.equal(row?.provider, existingProvider, "already-compatible row unchanged");
});

serialTest("migration handles mixed seed — only bare gigachat rows change", async () => {
  const bareId = `${RUN_PREFIX}-mixed-bare`;
  const compatId = `${RUN_PREFIX}-mixed-compat`;
  const otherId = `${RUN_PREFIX}-mixed-openai`;
  await seedRows([
    { id: bareId, provider: "gigachat" },
    { id: compatId, provider: `gigachat-compatible-${compatId}` },
    { id: otherId, provider: "openai-compatible" },
  ]);

  await runMigration();

  assert.equal((await getRow(bareId))?.provider, `gigachat-compatible-${bareId}`);
  assert.equal((await getRow(compatId))?.provider, `gigachat-compatible-${compatId}`);
  assert.equal(
    (await getRow(otherId))?.provider,
    "openai-compatible",
    "unrelated provider untouched"
  );
});

serialTest("migration is idempotent — second run does not error or re-change rows", async () => {
  const id = `${RUN_PREFIX}-idempotent-1`;
  await seedRows([{ id, provider: "gigachat" }]);

  await runMigration();
  const afterFirst = await getRow(id);
  assert.equal(afterFirst?.provider, `gigachat-compatible-${id}`);

  await runMigration();
  const afterSecond = await getRow(id);
  assert.equal(
    afterSecond?.provider,
    `gigachat-compatible-${id}`,
    "second run is a no-op for this row"
  );
});

serialTest("migration resolves collision with -2 suffix", async () => {
  const bareId = `${RUN_PREFIX}-collide-bare`;
  const collidingId = `${RUN_PREFIX}-collide-existing`;
  // Seed a row that already occupies the preferred target name for bareId.
  await seedRows([
    { id: bareId, provider: "gigachat" },
    { id: collidingId, provider: `gigachat-compatible-${bareId}` },
  ]);

  await runMigration();

  const row = await getRow(bareId);
  assert.equal(
    row?.provider,
    `gigachat-compatible-${bareId}-2`,
    "collision resolved with -2 suffix"
  );
  const collidingRow = await getRow(collidingId);
  assert.equal(
    collidingRow?.provider,
    `gigachat-compatible-${bareId}`,
    "pre-existing colliding row untouched"
  );
});

serialTest("migration renames multiple bare gigachat rows independently", async () => {
  const id1 = `${RUN_PREFIX}-multi-1`;
  const id2 = `${RUN_PREFIX}-multi-2`;
  const id3 = `${RUN_PREFIX}-multi-3`;
  await seedRows([
    { id: id1, provider: "gigachat" },
    { id: id2, provider: "gigachat" },
    { id: id3, provider: "gigachat" },
  ]);

  await runMigration();

  assert.equal((await getRow(id1))?.provider, `gigachat-compatible-${id1}`);
  assert.equal((await getRow(id2))?.provider, `gigachat-compatible-${id2}`);
  assert.equal((await getRow(id3))?.provider, `gigachat-compatible-${id3}`);
  assert.equal(await countByProviderPrefix("gigachat-compatible-"), 3, "all three rows renamed");
});

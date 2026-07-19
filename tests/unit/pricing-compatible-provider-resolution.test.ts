import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-pricing-compat-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const ORIGINAL_INITIAL_PASSWORD = process.env.INITIAL_PASSWORD;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const readCacheDb = await import("../../src/lib/db/readCache.ts");
const pgModule = await import("../../src/lib/db/postgres.ts");
const { computeCostFromPricing } = await import("../../src/lib/usage/costCalculator.ts");

const MUTABLE_TEST_TABLES = [
  "key_value",
  "provider_nodes",
  "provider_connections",
  "usage_history",
];

async function purgePostgresTables() {
  const schema = pgModule.getSchema();
  const tables = MUTABLE_TEST_TABLES.map((table) => `${schema}.${table}`).join(", ");
  await pgModule.query(`TRUNCATE ${tables} CASCADE`);
}

async function resetStorage() {
  await purgePostgresTables();
  core.resetDbInstance();
  readCacheDb.invalidateDbCache();

  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  delete process.env.INITIAL_PASSWORD;
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  if (ORIGINAL_INITIAL_PASSWORD === undefined) {
    delete process.env.INITIAL_PASSWORD;
  } else {
    process.env.INITIAL_PASSWORD = ORIGINAL_INITIAL_PASSWORD;
  }
});

test("gigachat-compatible usage row resolves pricing via the gigachat family key", async () => {
  const node = await providersDb.createProviderNode({
    id: "gigachat-compatible-abc123",
    type: "gigachat-compatible",
    name: "GigaChat prod",
    prefix: "gc-prod",
  });
  assert.equal(node.id, "gigachat-compatible-abc123");

  await settingsDb.updatePricing({
    gigachat: {
      "GigaChat-Max": { input: 1000, output: 2000 },
    },
  });

  const pricing = await settingsDb.getPricingForModel("gigachat-compatible-abc123", "GigaChat-Max");
  assert.ok(pricing, "family-key pricing should resolve for a gigachat-compatible node id");

  const cost = computeCostFromPricing(pricing as Record<string, unknown>, {
    input: 1_000_000,
    output: 500_000,
  });
  assert.equal(cost, 1000 * 1 + 2000 * 0.5);
});

test("node prefix pricing takes precedence over the family key", async () => {
  await providersDb.createProviderNode({
    id: "gigachat-compatible-def456",
    type: "gigachat-compatible",
    name: "GigaChat prefixed",
    prefix: "gc-prod",
  });

  await settingsDb.updatePricing({
    gigachat: {
      "GigaChat-Max": { input: 1000, output: 2000 },
    },
    "gc-prod": {
      "GigaChat-Max": { input: 3000, output: 4000 },
    },
  });

  const pricing = await settingsDb.getPricingForModel("gigachat-compatible-def456", "GigaChat-Max");
  assert.deepEqual(pricing, { input: 3000, output: 4000 });

  const cost = computeCostFromPricing(pricing as Record<string, unknown>, {
    input: 2_000_000,
    output: 1_000_000,
  });
  assert.equal(cost, 3000 * 2 + 4000 * 1);
});

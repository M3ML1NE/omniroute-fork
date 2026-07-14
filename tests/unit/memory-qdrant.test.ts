import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-qdrant-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const pgModule = await import("../../src/lib/db/postgres.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const qdrant = await import("../../src/lib/memory/qdrant.ts");

function serialTest(name: string, fn: () => Promise<void>) {
  test(name, { concurrency: false }, fn);
}

async function resetStorage() {
  const schema = pgModule.getSchema();
  await pgModule.query(
    `DELETE FROM ${schema}.key_value WHERE namespace = 'settings' AND key LIKE 'qdrant%'`
  );
  core.resetDbInstance();
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  await resetStorage();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// ── normalizeQdrantConfig (pure) ────────────────────────────────────────────

test("normalizeQdrantConfig applies documented defaults when settings are empty", () => {
  const cfg = qdrant.normalizeQdrantConfig({});
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.host, "");
  assert.equal(cfg.port, 6333);
  assert.equal(cfg.apiKey, null);
  assert.equal(cfg.collection, "omniroute_memory");
  assert.equal(cfg.embeddingModel, "openai/text-embedding-3-small");
});

test("normalizeQdrantConfig reads explicit values through", () => {
  const cfg = qdrant.normalizeQdrantConfig({
    qdrantEnabled: true,
    qdrantHost: " qdrant.internal ",
    qdrantPort: 7333,
    qdrantApiKey: " secret-key ",
    qdrantCollection: " my_memories ",
    qdrantEmbeddingModel: " openai/text-embedding-3-large ",
  });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.host, "qdrant.internal");
  assert.equal(cfg.port, 7333);
  assert.equal(cfg.apiKey, "secret-key");
  assert.equal(cfg.collection, "my_memories");
  assert.equal(cfg.embeddingModel, "openai/text-embedding-3-large");
});

test("normalizeQdrantConfig parses a numeric string port and rounds it", () => {
  const cfg = qdrant.normalizeQdrantConfig({ qdrantPort: "6334.7" });
  assert.equal(cfg.port, 6335);
});

test("normalizeQdrantConfig falls back to 6333 for an unparseable port string", () => {
  const cfg = qdrant.normalizeQdrantConfig({ qdrantPort: "not-a-number" });
  assert.equal(cfg.port, 6333);
});

test("normalizeQdrantConfig treats a whitespace-only apiKey as absent (null)", () => {
  const cfg = qdrant.normalizeQdrantConfig({ qdrantApiKey: "   " });
  assert.equal(cfg.apiKey, null);
});

test("normalizeQdrantConfig treats a whitespace-only host as empty string", () => {
  const cfg = qdrant.normalizeQdrantConfig({ qdrantHost: "   " });
  assert.equal(cfg.host, "");
});

// ── getQdrantConfig (DB-backed) ─────────────────────────────────────────────

serialTest("getQdrantConfig reads persisted settings from the key_value table", async () => {
  await settingsDb.updateSettings({
    qdrantEnabled: true,
    qdrantHost: "localhost",
    qdrantPort: 6333,
  });

  const cfg = await qdrant.getQdrantConfig();
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.host, "localhost");
  assert.equal(cfg.port, 6333);
});

// ── Early "not_configured" guard across all network-touching exports ───────

serialTest("checkQdrantHealth returns not_configured when qdrant is disabled", async () => {
  const result = await qdrant.checkQdrantHealth();
  assert.equal(result.ok, false);
  assert.equal(result.error, "not_configured");
  assert.equal(result.latencyMs, 0);
});

serialTest("checkQdrantHealth returns not_configured when enabled but host is empty", async () => {
  await settingsDb.updateSettings({ qdrantEnabled: true, qdrantHost: "" });
  const result = await qdrant.checkQdrantHealth();
  assert.equal(result.ok, false);
  assert.equal(result.error, "not_configured");
});

serialTest("upsertSemanticMemoryPoint returns not_configured when qdrant is disabled", async () => {
  const result = await qdrant.upsertSemanticMemoryPoint({
    id: "point-1",
    apiKeyId: "key-1",
    sessionId: "session-1",
    key: "fact",
    content: "the sky is blue",
    metadata: {},
    createdAt: new Date().toISOString(),
    expiresAt: null,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "not_configured");
  assert.equal(result.latencyMs, 0);
});

serialTest("searchSemanticMemory returns not_configured when qdrant is disabled", async () => {
  const result = await qdrant.searchSemanticMemory("some query");
  assert.equal(result.ok, false);
  assert.equal(result.error, "not_configured");
  assert.equal(result.results, undefined);
});

serialTest("deleteSemanticMemoryPoint returns not_configured when qdrant is disabled", async () => {
  const result = await qdrant.deleteSemanticMemoryPoint("point-1");
  assert.equal(result.ok, false);
  assert.equal(result.error, "not_configured");
});

serialTest("cleanupSemanticMemoryPoints returns not_configured when qdrant is disabled", async () => {
  const result = await qdrant.cleanupSemanticMemoryPoints({ retentionDays: 30 });
  assert.equal(result.ok, false);
  assert.equal(result.deletedCount, 0);
  assert.equal(result.error, "not_configured");
});

// ── Network failure branch: enabled + host set, but unreachable ────────────

serialTest("checkQdrantHealth surfaces a connection error when the host is unreachable", async () => {
  await settingsDb.updateSettings({
    qdrantEnabled: true,
    qdrantHost: "127.0.0.1",
    qdrantPort: 1, // reserved port, nothing listens here in CI
  });
  const result = await qdrant.checkQdrantHealth();
  assert.equal(result.ok, false);
  assert.ok(result.error);
  assert.notEqual(result.error, "not_configured");
  assert.ok(result.latencyMs >= 0);
});

serialTest("deleteSemanticMemoryPoint surfaces a connection error when the host is unreachable", async () => {
  await settingsDb.updateSettings({
    qdrantEnabled: true,
    qdrantHost: "127.0.0.1",
    qdrantPort: 1,
  });
  const result = await qdrant.deleteSemanticMemoryPoint("point-1");
  assert.equal(result.ok, false);
  assert.ok(result.error);
  assert.notEqual(result.error, "not_configured");
});

serialTest("cleanupSemanticMemoryPoints surfaces a connection error when the host is unreachable", async () => {
  await settingsDb.updateSettings({
    qdrantEnabled: true,
    qdrantHost: "127.0.0.1",
    qdrantPort: 1,
  });
  const result = await qdrant.cleanupSemanticMemoryPoints({ retentionDays: 30 });
  assert.equal(result.ok, false);
  assert.equal(result.deletedCount, 0);
  assert.ok(result.error);
});

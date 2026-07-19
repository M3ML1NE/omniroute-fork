import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-usage-history-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const usageHistory = await import("../../src/lib/usage/usageHistory.ts");
const { extractUsageFromResponse } = await import("../../open-sse/handlers/usageExtractor.ts");

const clearPendingRequests = usageHistory.clearPendingRequests;

async function resetStorage() {
  core.resetDbInstance();
  const db = core.getDbInstance();
  await db.prepare("DELETE FROM usage_history").run();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  clearPendingRequests();
}

async function seedUsageEntries(
  entries: Array<{
    provider: string;
    model: string;
    connectionId?: string;
    tokens: { input?: number; output?: number };
    success?: boolean;
    latencyMs?: number;
    minutesAgo?: number;
    serviceTier?: string;
  }>
) {
  for (const [i, e] of entries.entries()) {
    await usageHistory.saveRequestUsage({
      provider: e.provider,
      model: e.model,
      connectionId: e.connectionId || `conn-${i}`,
      apiKeyId: `key-${i}`,
      apiKeyName: `Key ${i}`,
      tokens: e.tokens,
      success: e.success !== false,
      latencyMs: e.latencyMs || 100,
      timestamp: new Date(Date.now() - (e.minutesAgo || i) * 60 * 1000).toISOString(),
      serviceTier: e.serviceTier,
    });
  }
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// ──────────────── getUsageDb ────────────────

test("getUsageDb returns all rows up to MAX_ROWS limit in ASC order", async () => {
  // Save 12 entries (limit is 10000, so all should return)
  const entries = Array.from({ length: 12 }, (_, i) => ({
    provider: `prov-${i}`,
    model: `model-${i}`,
    tokens: { input: i * 10, output: i },
    success: true,
    minutesAgo: i,
  }));
  await seedUsageEntries(entries);

  const result = await usageHistory.getUsageDb();

  assert.equal(result.data.history.length, 12);
  assert.equal(result.data.history[0].provider, "prov-11");
  assert.equal(result.data.history[11].provider, "prov-0");
  assert.equal(result.data.nextCursor, null); // No next cursor (didn't hit limit)
});

test("getUsageDb filters by sinceIso date", async () => {
  const entries = [
    { provider: "old", model: "m", tokens: { input: 10 }, minutesAgo: 120 },
    { provider: "new", model: "m", tokens: { input: 20 }, minutesAgo: 1 },
  ];
  await seedUsageEntries(entries);

  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const result = await usageHistory.getUsageDb(cutoff);

  assert.equal(result.data.history.length, 1);
  assert.equal(result.data.history[0].provider, "new");
});

test("usage history persists service tier and defaults to standard", async () => {
  await usageHistory.saveRequestUsage({
    provider: "codex",
    model: "gpt-5.5",
    tokens: { input: 100, output: 50 },
    success: true,
    serviceTier: "priority",
    timestamp: new Date().toISOString(),
  });
  await usageHistory.saveRequestUsage({
    provider: "openai",
    model: "gpt-4o",
    tokens: { input: 10, output: 5 },
    success: true,
    timestamp: new Date(Date.now() + 1).toISOString(),
  });
  await usageHistory.saveRequestUsage({
    provider: "codex",
    model: "gpt-5.5",
    tokens: { input: 40, output: 20 },
    success: true,
    serviceTier: "flex",
    timestamp: new Date(Date.now() + 2).toISOString(),
  });

  const history = await usageHistory.getUsageHistory({ provider: "codex" });
  const usageDb = await usageHistory.getUsageDb();

  assert.equal(history.length, 2);
  assert.equal(history[0].serviceTier, "priority");
  assert.equal(history[1].serviceTier, "flex");
  assert.equal(usageDb.data.history[0].serviceTier, "priority");
  assert.equal(usageDb.data.history[1].serviceTier, "standard");
  assert.equal(usageDb.data.history[2].serviceTier, "flex");
});

test("getUsageDb provides nextCursor when rows exceed MAX_ROWS", async () => {
  const db = core.getDbInstance();
  await db.exec(`
    INSERT INTO usage_history (provider, model, timestamp, tokens_input, tokens_output, success, latency_ms)
    SELECT
      'prov-' || i,
      'model-' || i,
      to_char((now() - (i || ' seconds')::interval) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      10,
      5,
      1,
      100
    FROM generate_series(0, 10000) AS g(i)
  `);

  const result = await usageHistory.getUsageDb();

  assert.equal(result.data.history.length, 10000);
  assert.notEqual(result.data.nextCursor, null);
});

test("getUsageDb cursor-based pagination fetches subsequent pages", async () => {
  const entries = Array.from({ length: 5 }, (_, i) => ({
    provider: `prov-${i}`,
    model: `model-${i}`,
    tokens: { input: 10 },
    success: true,
    minutesAgo: i,
  }));
  await seedUsageEntries(entries);

  // First page (limit=2)
  const page1 = await usageHistory.getUsageDb(undefined, 2);
  assert.equal(page1.data.history.length, 2);
  assert.notEqual(page1.data.nextCursor, null);
});

// ──────────────── Prompt cache CREATION token persistence ────────────────
// Regression coverage for the bug where cache creation tokens never reached
// usage_history (only cache READ tokens survived). Both upstream shapes are
// exercised through the real extractUsageFromResponse → saveRequestUsage path.

test("saveRequestUsage persists top-level cache_creation_input_tokens shape", async () => {
  // Upstream shape A (reproduced case): prompt_tokens_details.cached_tokens for
  // read + top-level cache_creation_input_tokens for creation (Claude-style field
  // riding on an OpenAI-format body).
  const responseBody = {
    usage: {
      prompt_tokens: 100,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 64 },
      cache_creation_input_tokens: 16,
    },
  };
  const usage = extractUsageFromResponse(responseBody);
  assert.equal(usage.cached_tokens, 64);
  assert.equal(usage.cache_creation_input_tokens, 16);

  await usageHistory.saveRequestUsage({
    provider: "openai-compatible-test",
    model: "test-model",
    tokens: usage,
    success: true,
    timestamp: new Date().toISOString(),
  });

  const history = await usageHistory.getUsageHistory({ provider: "openai-compatible-test" });
  assert.equal(history.length, 1);
  assert.equal(history[0].tokens.cacheRead, 64);
  assert.equal(history[0].tokens.cacheCreation, 16);
});

test("saveRequestUsage persists nested prompt_tokens_details.cache_creation_tokens shape", async () => {
  // Upstream shape B (reproduced case): both read and creation nested under
  // prompt_tokens_details (no top-level cache_creation_input_tokens).
  const responseBody = {
    usage: {
      prompt_tokens: 200,
      completion_tokens: 8,
      prompt_tokens_details: { cached_tokens: 128, cache_creation_tokens: 32 },
    },
  };
  const usage = extractUsageFromResponse(responseBody);
  assert.equal(usage.cached_tokens, 128);
  assert.equal(usage.cache_creation_input_tokens, 32);

  await usageHistory.saveRequestUsage({
    provider: "openai-compatible-test",
    model: "test-model",
    tokens: usage,
    success: true,
    timestamp: new Date().toISOString(),
  });

  const history = await usageHistory.getUsageHistory({ provider: "openai-compatible-test" });
  assert.equal(history.length, 1);
  assert.equal(history[0].tokens.cacheRead, 128);
  assert.equal(history[0].tokens.cacheCreation, 32);
});

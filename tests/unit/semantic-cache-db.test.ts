import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-semantic-cache-db-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const pgModule = await import("../../src/lib/db/postgres.ts");
const semanticCache = await import("../../src/lib/semanticCache.ts");

const RUN_PREFIX = `semcache-${process.pid}`;

function serialTest(name: string, fn: () => Promise<void>) {
  test(name, { concurrency: false }, fn);
}

async function resetStorage() {
  const schema = pgModule.getSchema();
  await pgModule.query(`DELETE FROM ${schema}.semantic_cache WHERE signature LIKE $1`, [
    `${RUN_PREFIX}-%`,
  ]);
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

function uniqueSignature(suffix: string): string {
  return `${RUN_PREFIX}-${suffix}-${Math.random().toString(16).slice(2, 8)}`;
}

serialTest("getCachedResponse returns null for a signature that was never cached", async () => {
  const result = await semanticCache.getCachedResponse(uniqueSignature("missing"));
  assert.equal(result, null);
});

serialTest("setCachedResponse then getCachedResponse round-trips the exact response payload", async () => {
  const signature = uniqueSignature("roundtrip");
  const response = { id: "resp-1", choices: [{ message: { content: "hello" } }] };

  await semanticCache.setCachedResponse(signature, "gpt-4", response, 42);

  const cached = await semanticCache.getCachedResponse(signature);
  assert.deepEqual(cached, response);
});

serialTest("setCachedResponse upserts on a repeated signature (ON CONFLICT updates the row)", async () => {
  const signature = uniqueSignature("upsert");
  await semanticCache.setCachedResponse(signature, "gpt-4", { v: 1 }, 10);
  await semanticCache.setCachedResponse(signature, "gpt-4", { v: 2 }, 20);

  const cached = await semanticCache.getCachedResponse(signature);
  assert.deepEqual(cached, { v: 2 });
});

serialTest("getCachedResponse does not return an entry whose expires_at has already passed", async () => {
  const signature = uniqueSignature("expired");
  await semanticCache.setCachedResponse(signature, "gpt-4", { v: 1 }, 0, -1000);

  const cached = await semanticCache.getCachedResponse(signature);
  assert.equal(cached, null);
});

serialTest("cleanExpiredEntries removes only expired rows and reports the deleted count", async () => {
  const expiredSig = uniqueSignature("cleanup-expired");
  const freshSig = uniqueSignature("cleanup-fresh");
  await semanticCache.setCachedResponse(expiredSig, "gpt-4", { v: 1 }, 0, -1000);
  await semanticCache.setCachedResponse(freshSig, "gpt-4", { v: 2 }, 0, 3600000);

  const removed = await semanticCache.cleanExpiredEntries();
  assert.ok(removed >= 1);

  const db = core.getDbInstance();
  const expiredRow = await db
    .prepare("SELECT signature FROM semantic_cache WHERE signature = ?")
    .get(expiredSig);
  const freshRow = await db
    .prepare("SELECT signature FROM semantic_cache WHERE signature = ?")
    .get(freshSig);
  assert.equal(expiredRow, undefined);
  assert.ok(freshRow);
});

serialTest("invalidateByModel removes only entries for the given model", async () => {
  const sigA = uniqueSignature("model-a");
  const sigB = uniqueSignature("model-b");
  const modelName = `test-model-${RUN_PREFIX}`;
  await semanticCache.setCachedResponse(sigA, modelName, { v: 1 }, 0);
  await semanticCache.setCachedResponse(sigB, "other-model", { v: 2 }, 0);

  const removed = await semanticCache.invalidateByModel(modelName);
  assert.equal(removed, 1);

  assert.equal(await semanticCache.getCachedResponse(sigA), null);
  // sigB's memory cache was cleared by invalidateByModel's full clear, but
  // its DB row (a different model) must still be present.
  const db = core.getDbInstance();
  const row = await db.prepare("SELECT signature FROM semantic_cache WHERE signature = ?").get(sigB);
  assert.ok(row);
});

serialTest("invalidateBySignature removes a single entry and returns true, false for a missing one", async () => {
  const signature = uniqueSignature("single");
  await semanticCache.setCachedResponse(signature, "gpt-4", { v: 1 }, 0);

  const removed = await semanticCache.invalidateBySignature(signature);
  assert.equal(removed, true);
  assert.equal(await semanticCache.getCachedResponse(signature), null);

  const removedAgain = await semanticCache.invalidateBySignature(signature);
  assert.equal(removedAgain, false);
});

serialTest("invalidateStale removes entries older than maxAgeMs based on created_at", async () => {
  const signature = uniqueSignature("stale");
  await semanticCache.setCachedResponse(signature, "gpt-4", { v: 1 }, 0);

  // Backdate created_at directly so the entry looks old without waiting.
  const db = core.getDbInstance();
  const oldCreatedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  await db
    .prepare("UPDATE semantic_cache SET created_at = ? WHERE signature = ?")
    .run(oldCreatedAt, signature);

  const removed = await semanticCache.invalidateStale(60 * 1000);
  assert.ok(removed >= 1);

  const row = await db.prepare("SELECT signature FROM semantic_cache WHERE signature = ?").get(signature);
  assert.equal(row, undefined);
});

serialTest("clearCache removes every entry and resets cache_metrics to 0", async () => {
  const signature = uniqueSignature("clear-all");
  await semanticCache.setCachedResponse(signature, "gpt-4", { v: 1 }, 0);
  // Drive a hit/miss so cache_metrics has non-zero values before clearing.
  await semanticCache.getCachedResponse(signature);
  await semanticCache.getCachedResponse(uniqueSignature("clear-all-miss"));

  const removed = await semanticCache.clearCache();
  assert.ok(removed >= 1);

  const stats = await semanticCache.getCacheStats();
  assert.equal(stats.hits, 0);
  assert.equal(stats.misses, 0);
  assert.equal(stats.tokensSaved, 0);
});

serialTest("getCacheStats reports dbEntries and a computed hitRate", async () => {
  await semanticCache.clearCache();
  const signature = uniqueSignature("stats");
  await semanticCache.setCachedResponse(signature, "gpt-4", { v: 1 }, 5);

  await semanticCache.getCachedResponse(signature); // hit
  await semanticCache.getCachedResponse(uniqueSignature("stats-miss")); // miss

  // incrementMetric() is fire-and-forget (`void`ed) at both call sites in
  // getCachedResponse, so the cache_metrics row write can still be in
  // flight when getCacheStats() runs immediately after — poll briefly.
  let stats = await semanticCache.getCacheStats();
  for (let i = 0; i < 20 && (stats.hits < 1 || stats.misses < 1); i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    stats = await semanticCache.getCacheStats();
  }
  assert.ok(stats.dbEntries >= 1);
  assert.ok(stats.hits >= 1);
  assert.ok(stats.misses >= 1);
  assert.match(stats.hitRate, /^\d+\.\d$/);
});

serialTest("startAutoCleanup / stopAutoCleanup do not throw and stop is idempotent", async () => {
  assert.doesNotThrow(() => semanticCache.startAutoCleanup(60_000));
  assert.doesNotThrow(() => semanticCache.stopAutoCleanup());
  assert.doesNotThrow(() => semanticCache.stopAutoCleanup());
});

serialTest("cleanOldMetrics removes entries older than retentionDays based on created_at", async () => {
  const signature = uniqueSignature("old-metrics");
  await semanticCache.setCachedResponse(signature, "gpt-4", { v: 1 }, 0);

  const db = core.getDbInstance();
  const veryOldCreatedAt = new Date(Date.now() - 100 * 86400000).toISOString();
  await db
    .prepare("UPDATE semantic_cache SET created_at = ? WHERE signature = ?")
    .run(veryOldCreatedAt, signature);

  const removed = await semanticCache.cleanOldMetrics(90);
  assert.ok(removed >= 1);

  const row = await db.prepare("SELECT signature FROM semantic_cache WHERE signature = ?").get(signature);
  assert.equal(row, undefined);
});

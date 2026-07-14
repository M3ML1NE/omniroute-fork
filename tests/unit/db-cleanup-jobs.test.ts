import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-db-cleanup-jobs-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const pgModule = await import("../../src/lib/db/postgres.ts");
const databaseSettingsDb = await import("../../src/lib/db/databaseSettings.ts");
const cleanup = await import("../../src/lib/db/cleanup.ts");

const RUN_PREFIX = `cleanup-jobs-${process.pid}`;

function serialTest(name: string, fn: () => Promise<void>) {
  test(name, { concurrency: false }, fn);
}

async function resetStorage() {
  const schema = pgModule.getSchema();
  await pgModule.query(
    `DELETE FROM ${schema}.compression_analytics WHERE request_id LIKE $1`,
    [`${RUN_PREFIX}-%`]
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

function uniqueRequestId(suffix: string): string {
  return `${RUN_PREFIX}-${suffix}-${Math.random().toString(16).slice(2, 8)}`;
}

async function insertCompressionAnalyticsRow(requestId: string, timestamp: string) {
  const db = core.getDbInstance();
  await db
    .prepare(
      `INSERT INTO compression_analytics
       (timestamp, mode, original_tokens, compressed_tokens, tokens_saved, request_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(timestamp, "lite", 100, 80, 20, requestId);
}

serialTest("cleanupCompressionAnalytics deletes rows older than the configured retention and keeps recent ones", async () => {
  await databaseSettingsDb.updateDatabaseSettings({ retention: { compressionAnalytics: 5 } as any });

  const oldRequestId = uniqueRequestId("old");
  const freshRequestId = uniqueRequestId("fresh");
  const oldTimestamp = new Date(Date.now() - 10 * 86400000).toISOString();
  const freshTimestamp = new Date().toISOString();

  await insertCompressionAnalyticsRow(oldRequestId, oldTimestamp);
  await insertCompressionAnalyticsRow(freshRequestId, freshTimestamp);

  const result = await cleanup.cleanupCompressionAnalytics();
  assert.ok(result.deleted >= 1);
  assert.equal(result.errors, 0);

  const db = core.getDbInstance();
  const oldRow = await db
    .prepare("SELECT request_id FROM compression_analytics WHERE request_id = ?")
    .get(oldRequestId);
  const freshRow = await db
    .prepare("SELECT request_id FROM compression_analytics WHERE request_id = ?")
    .get(freshRequestId);
  assert.equal(oldRow, undefined);
  assert.ok(freshRow);
});

serialTest("runAutoCleanup is a no-op and returns zeroed totals when autoCleanupEnabled is false", async () => {
  await databaseSettingsDb.updateDatabaseSettings({
    retention: { autoCleanupEnabled: false } as any,
  });

  const result = await cleanup.runAutoCleanup();
  assert.equal(result.totalDeleted, 0);
  assert.equal(result.totalErrors, 0);
  assert.deepEqual(result.results, {});
});

serialTest("runAutoCleanup runs all six cleanup jobs and aggregates their results when enabled", async () => {
  await databaseSettingsDb.updateDatabaseSettings({
    retention: {
      autoCleanupEnabled: true,
      compressionAnalytics: 1,
      mcpAudit: 30,
      a2aEvents: 30,
      callLogs: 30,
      usageHistory: 30,
      memoryEntries: 30,
    } as any,
  });

  const result = await cleanup.runAutoCleanup();
  assert.equal(typeof result.totalDeleted, "number");
  assert.equal(typeof result.totalErrors, "number");
  assert.deepEqual(Object.keys(result.results).sort(), [
    "a2aEvents",
    "callLogs",
    "compressionAnalytics",
    "mcpAudit",
    "memoryEntries",
    "usageHistory",
  ]);
  for (const key of Object.keys(result.results)) {
    const entry = result.results[key];
    assert.equal(typeof entry.deleted, "number");
    assert.equal(typeof entry.errors, "number");
  }
});

// The cleanup* helpers below target tables that don't exist in this fork's
// schema (mcp_audit_log/a2a_events/memory_entries were renamed or dropped —
// see src/lib/db/cleanup.ts's docstrings vs. db/migrations/postgres/0001 and
// 0002). Each function's try/catch turns that into a documented fail-safe
// error count rather than a thrown exception or process crash.

serialTest("cleanupMcpAudit reports an error (rather than throwing) against the renamed mcp_tool_audit table", async () => {
  const result = await cleanup.cleanupMcpAudit();
  assert.equal(result.deleted, 0);
  assert.equal(result.errors, 1);
});

serialTest("cleanupA2aEvents reports an error (rather than throwing) since a2a_events was dropped from this fork", async () => {
  const result = await cleanup.cleanupA2aEvents();
  assert.equal(result.deleted, 0);
  assert.equal(result.errors, 1);
});

serialTest("cleanupMemoryEntries reports an error (rather than throwing) against the renamed memories table", async () => {
  const result = await cleanup.cleanupMemoryEntries();
  assert.equal(result.deleted, 0);
  assert.equal(result.errors, 1);
});

serialTest("purgeQuotaSnapshots reports an error (rather than throwing) since quota_snapshots was dropped from this fork", async () => {
  const result = await cleanup.purgeQuotaSnapshots();
  assert.equal(result.deleted, 0);
  assert.equal(result.errors, 1);
});

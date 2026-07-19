import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-log-retention-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.APP_LOG_RETENTION_DAYS = "2";
process.env.CALL_LOG_RETENTION_DAYS = "1";
process.env.CALL_LOGS_TABLE_MAX_ROWS = "5";
// getProxyLogsTableMaxRows() still parses this env var even though the
// proxy_logs table itself was dropped by 0004_drop_dead_subsystems.sql.
process.env.PROXY_LOGS_TABLE_MAX_ROWS = "5";

const core = await import("../../src/lib/db/core.ts");
const compliance = await import("../../src/lib/compliance/index.ts");

function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

const OWN_CALL_LOG_IDS = ["old-call", "fresh-call", ...Array.from({ length: 10 }, (_, i) => `call-${i}`)];
const OWN_REQUEST_DETAIL_IDS = ["old-detail", "fresh-detail"];
const OWN_AUDIT_ACTIONS = ["old-audit", "fresh-audit"];
const OWN_MCP_TOOL_NAMES = ["old-tool", "fresh-tool"];
const OWN_USAGE_MODELS = ["old-usage", "fresh-usage"];

async function deleteWhereIn(
  db: ReturnType<typeof core.getDbInstance>,
  table: string,
  column: string,
  values: string[]
) {
  const placeholders = values.map(() => "?").join(", ");
  await db.prepare(`DELETE FROM ${table} WHERE ${column} IN (${placeholders})`).run(...values);
}

// The shared Postgres tables below may carry rows left by other test files
// (or by this file's own previous run), and trimCallLogsToMaxRows() operates
// on the real table-wide count — so every fixture row this file inserts must
// be purged by its own known id before and after each test.
async function purgeOwnFixtureRows(db: ReturnType<typeof core.getDbInstance>) {
  await deleteWhereIn(db, "call_logs", "id", OWN_CALL_LOG_IDS);
  await deleteWhereIn(db, "request_detail_logs", "id", OWN_REQUEST_DETAIL_IDS);
  await deleteWhereIn(db, "audit_log", "action", OWN_AUDIT_ACTIONS);
  await deleteWhereIn(db, "mcp_tool_audit", "tool_name", OWN_MCP_TOOL_NAMES);
  await deleteWhereIn(db, "usage_history", "model", OWN_USAGE_MODELS);
}

async function countMatching(
  db: ReturnType<typeof core.getDbInstance>,
  table: string,
  column: string,
  values: string[]
): Promise<number> {
  const placeholders = values.map(() => "?").join(", ");
  const row = (await db
    .prepare(`SELECT COUNT(*) AS cnt FROM ${table} WHERE ${column} IN (${placeholders})`)
    .get(...values)) as { cnt: unknown };
  return Number(row.cnt);
}

test.beforeEach(async () => {
  resetStorage();
  await purgeOwnFixtureRows(core.getDbInstance());
});

test.after(async () => {
  await purgeOwnFixtureRows(core.getDbInstance());
  resetStorage();
});

test("cleanupExpiredLogs uses separate APP and CALL retention windows", async () => {
  compliance.initAuditLog();
  const db = core.getDbInstance();
  await purgeOwnFixtureRows(db);

  const oldCallTs = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const freshCallTs = new Date().toISOString();
  const oldAppTs = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
  const freshAppTs = new Date().toISOString();

  await db
    .prepare(
      "INSERT INTO usage_history (provider, model, tokens_input, tokens_output, success, latency_ms, ttft_ms, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run("openai", "old-usage", 1, 1, 1, 1, 1, oldCallTs);
  await db
    .prepare(
      "INSERT INTO usage_history (provider, model, tokens_input, tokens_output, success, latency_ms, ttft_ms, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run("openai", "fresh-usage", 1, 1, 1, 1, 1, freshCallTs);

  await db
    .prepare(
      "INSERT INTO call_logs (id, timestamp, method, path, status, model, provider, account, duration, tokens_in, tokens_out, has_pipeline_details) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      "old-call",
      oldCallTs,
      "POST",
      "/v1/chat/completions",
      200,
      "old",
      "openai",
      "-",
      1,
      1,
      1,
      0
    );
  await db
    .prepare(
      "INSERT INTO call_logs (id, timestamp, method, path, status, model, provider, account, duration, tokens_in, tokens_out, has_pipeline_details) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      "fresh-call",
      freshCallTs,
      "POST",
      "/v1/chat/completions",
      200,
      "fresh",
      "openai",
      "-",
      1,
      1,
      1,
      0
    );

  await db
    .prepare("INSERT INTO request_detail_logs (id, timestamp, duration_ms) VALUES (?, ?, ?)")
    .run("old-detail", oldCallTs, 1);
  await db
    .prepare("INSERT INTO request_detail_logs (id, timestamp, duration_ms) VALUES (?, ?, ?)")
    .run("fresh-detail", freshCallTs, 1);

  await db
    .prepare("INSERT INTO audit_log (timestamp, action, actor) VALUES (?, ?, ?)")
    .run(oldAppTs, "old-audit", "system");
  await db
    .prepare("INSERT INTO audit_log (timestamp, action, actor) VALUES (?, ?, ?)")
    .run(freshAppTs, "fresh-audit", "system");

  await db
    .prepare("INSERT INTO mcp_tool_audit (tool_name, success, created_at) VALUES (?, ?, ?)")
    .run("old-tool", 1, oldAppTs);
  await db
    .prepare("INSERT INTO mcp_tool_audit (tool_name, success, created_at) VALUES (?, ?, ?)")
    .run("fresh-tool", 1, freshAppTs);

  const result = await compliance.cleanupExpiredLogs();

  // cleanupExpiredLogs deletes by age across the whole shared table, so a
  // stale row left by another test file counts too; assert at least this
  // fixture's own old row was deleted rather than an exact global count.
  assert.ok(result.deletedUsage >= 1);
  assert.ok(result.deletedCallLogs >= 1);
  assert.ok(result.deletedRequestDetailLogs >= 1);
  assert.ok(result.deletedAuditLogs >= 1);
  assert.ok(result.deletedMcpAuditLogs >= 1);
  assert.deepEqual(compliance.getRetentionDays(), { app: 2, call: 1 });

  assert.equal(
    await countMatching(db, "usage_history", "model", ["old-usage", "fresh-usage"]),
    1
  );
  assert.equal(await countMatching(db, "call_logs", "id", ["old-call", "fresh-call"]), 1);
  assert.equal(
    await countMatching(db, "request_detail_logs", "id", ["old-detail", "fresh-detail"]),
    1
  );
  assert.equal(
    await countMatching(db, "audit_log", "action", ["old-audit", "fresh-audit"]),
    1
  );
  assert.equal(
    await countMatching(db, "mcp_tool_audit", "tool_name", ["old-tool", "fresh-tool"]),
    1
  );
});

async function countAll(db: ReturnType<typeof core.getDbInstance>, table: string): Promise<number> {
  const row = (await db.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`).get()) as { cnt: unknown };
  return Number(row.cnt);
}

test("cleanupExpiredLogs enforces row count limits", async () => {
  compliance.initAuditLog();
  const db = core.getDbInstance();

  const now = new Date().toISOString();

  for (let i = 0; i < 10; i++) {
    await db
      .prepare(
        "INSERT INTO call_logs (id, timestamp, method, path, status, model, provider, account, duration, tokens_in, tokens_out, has_pipeline_details) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(`call-${i}`, now, "POST", "/v1/chat/completions", 200, "model", "provider", "-", 1, 1, 1, 0);
  }

  const ownIds = Array.from({ length: 10 }, (_, i) => `call-${i}`);
  assert.equal(await countMatching(db, "call_logs", "id", ownIds), 10);

  const totalBeforeCleanup = await countAll(db, "call_logs");
  const result = await compliance.cleanupExpiredLogs();

  // trimCallLogsToMaxRows() trims the whole shared table down to exactly
  // callLogsMaxRows, so the post-trim total is a fixed global invariant
  // regardless of rows other test files may have left behind.
  assert.equal(result.callLogsMaxRows, 5);
  assert.equal(result.trimmedCallLogs, totalBeforeCleanup - 5);
  assert.equal(await countAll(db, "call_logs"), 5);
});

test("getCallLogsTableMaxRows returns configured value", async () => {
  const { getCallLogsTableMaxRows, getProxyLogsTableMaxRows } =
    await import("../../src/lib/logEnv.ts");

  assert.equal(getCallLogsTableMaxRows(), 5);
  assert.equal(getProxyLogsTableMaxRows(), 5);
});

test("call log pipeline env helpers parse stream chunk flag and size cap", async () => {
  const originalCapture = process.env.CALL_LOG_PIPELINE_CAPTURE_STREAM_CHUNKS;
  const originalMaxSize = process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB;
  const { getCallLogPipelineCaptureStreamChunks, getCallLogPipelineMaxSizeBytes } =
    await import("../../src/lib/logEnv.ts");

  try {
    process.env.CALL_LOG_PIPELINE_CAPTURE_STREAM_CHUNKS = "false";
    process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB = "256";

    assert.equal(getCallLogPipelineCaptureStreamChunks(), false);
    assert.equal(getCallLogPipelineMaxSizeBytes(), 256 * 1024);
  } finally {
    if (originalCapture === undefined) {
      delete process.env.CALL_LOG_PIPELINE_CAPTURE_STREAM_CHUNKS;
    } else {
      process.env.CALL_LOG_PIPELINE_CAPTURE_STREAM_CHUNKS = originalCapture;
    }

    if (originalMaxSize === undefined) {
      delete process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB;
    } else {
      process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB = originalMaxSize;
    }
  }
});

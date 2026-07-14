import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-context-handoffs-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const pgModule = await import("../../src/lib/db/postgres.ts");
const handoffsDb = await import("../../src/lib/db/contextHandoffs.ts");

const RUN_PREFIX = `context-handoffs-${process.pid}`;

function serialTest(name: string, fn: () => Promise<void>) {
  test(name, { concurrency: false }, fn);
}

async function resetStorage() {
  const schema = pgModule.getSchema();
  await pgModule.query(`DELETE FROM ${schema}.context_handoffs WHERE session_id LIKE $1`, [
    `${RUN_PREFIX}-%`,
  ]);
  await pgModule.query(
    `DELETE FROM ${schema}.session_model_history WHERE session_id LIKE $1`,
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

function makePayload(overrides: Partial<Parameters<typeof handoffsDb.upsertHandoff>[0]> = {}) {
  return {
    sessionId: `${RUN_PREFIX}-session-a`,
    comboName: "combo-1",
    fromAccount: "account-1",
    summary: "summary text",
    keyDecisions: ["decision 1", "decision 2"],
    taskProgress: "in progress",
    activeEntities: ["entity-1"],
    messageCount: 5,
    model: "gpt-4o",
    warningThresholdPct: 0.85,
    generatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

serialTest("upsertHandoff / getHandoff round-trip persists all fields", async () => {
  const payload = makePayload();
  await handoffsDb.upsertHandoff(payload);

  const result = await handoffsDb.getHandoff(payload.sessionId, payload.comboName);
  assert.ok(result);
  assert.equal(result!.summary, "summary text");
  assert.deepEqual(result!.keyDecisions, ["decision 1", "decision 2"]);
  assert.equal(result!.taskProgress, "in progress");
  assert.deepEqual(result!.activeEntities, ["entity-1"]);
  assert.equal(result!.messageCount, 5);
  assert.equal(result!.model, "gpt-4o");
  assert.equal(result!.fromAccount, "account-1");
});

serialTest("getHandoff returns null when no handoff exists for the session/combo", async () => {
  const result = await handoffsDb.getHandoff(`${RUN_PREFIX}-unknown-session`, "combo-x");
  assert.equal(result, null);
});

serialTest("getHandoff excludes expired handoffs", async () => {
  const payload = makePayload({
    sessionId: `${RUN_PREFIX}-session-expired`,
    expiresAt: new Date(Date.now() - 60 * 1000).toISOString(),
  });
  await handoffsDb.upsertHandoff(payload);

  const result = await handoffsDb.getHandoff(payload.sessionId, payload.comboName);
  assert.equal(result, null);
});

serialTest("upsertHandoff on the same session/combo updates rather than duplicating", async () => {
  const sessionId = `${RUN_PREFIX}-session-upsert`;
  await handoffsDb.upsertHandoff(makePayload({ sessionId, summary: "first" }));
  await handoffsDb.upsertHandoff(makePayload({ sessionId, summary: "second" }));

  const result = await handoffsDb.getHandoff(sessionId, "combo-1");
  assert.equal(result!.summary, "second");
});

serialTest("deleteHandoff removes the handoff", async () => {
  const payload = makePayload({ sessionId: `${RUN_PREFIX}-session-delete` });
  await handoffsDb.upsertHandoff(payload);
  await handoffsDb.deleteHandoff(payload.sessionId, payload.comboName);

  const result = await handoffsDb.getHandoff(payload.sessionId, payload.comboName);
  assert.equal(result, null);
});

serialTest("hasActiveHandoff reflects presence and expiry", async () => {
  const activeSession = `${RUN_PREFIX}-session-active`;
  const expiredSession = `${RUN_PREFIX}-session-expired-2`;
  await handoffsDb.upsertHandoff(makePayload({ sessionId: activeSession }));
  await handoffsDb.upsertHandoff(
    makePayload({
      sessionId: expiredSession,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    })
  );

  assert.equal(await handoffsDb.hasActiveHandoff(activeSession, "combo-1"), true);
  assert.equal(await handoffsDb.hasActiveHandoff(expiredSession, "combo-1"), false);
  assert.equal(
    await handoffsDb.hasActiveHandoff(`${RUN_PREFIX}-session-never`, "combo-1"),
    false
  );
});

serialTest("upsertHandoff parses keyDecisions/activeEntities back as real arrays, not JSON strings", async () => {
  const payload = makePayload({
    sessionId: `${RUN_PREFIX}-session-arrays`,
    keyDecisions: ["a", "b", "c"],
    activeEntities: ["x", "y"],
  });
  await handoffsDb.upsertHandoff(payload);

  const result = await handoffsDb.getHandoff(payload.sessionId, payload.comboName);
  assert.ok(Array.isArray(result!.keyDecisions));
  assert.equal(result!.keyDecisions.length, 3);
  assert.ok(Array.isArray(result!.activeEntities));
  assert.equal(result!.activeEntities.length, 2);
});

serialTest("recordSessionModelUsage / getLastSessionModel round-trip", async () => {
  const sessionId = `${RUN_PREFIX}-session-model-a`;
  await handoffsDb.recordSessionModelUsage(sessionId, "combo-1", "gpt-4o", "openai");

  const lastModel = await handoffsDb.getLastSessionModel(sessionId, "combo-1");
  assert.equal(lastModel, "gpt-4o");
});

serialTest("getLastSessionModel returns null when no usage has been recorded", async () => {
  const lastModel = await handoffsDb.getLastSessionModel(
    `${RUN_PREFIX}-session-no-usage`,
    "combo-1"
  );
  assert.equal(lastModel, null);
});

serialTest("getLastSessionModel returns the most recently recorded model across multiple entries", async () => {
  const sessionId = `${RUN_PREFIX}-session-model-b`;
  await handoffsDb.recordSessionModelUsage(sessionId, "combo-1", "gpt-4o", "openai");
  await handoffsDb.recordSessionModelUsage(sessionId, "combo-1", "claude-3", "anthropic");

  const lastModel = await handoffsDb.getLastSessionModel(sessionId, "combo-1");
  assert.equal(lastModel, "claude-3");
});

serialTest("recordSessionModelUsage tracks distinct session/combo pairs independently", async () => {
  const sessionId = `${RUN_PREFIX}-session-model-c`;
  await handoffsDb.recordSessionModelUsage(sessionId, "combo-a", "model-a", "provider-a");
  await handoffsDb.recordSessionModelUsage(sessionId, "combo-b", "model-b", "provider-b");

  assert.equal(await handoffsDb.getLastSessionModel(sessionId, "combo-a"), "model-a");
  assert.equal(await handoffsDb.getLastSessionModel(sessionId, "combo-b"), "model-b");
});

serialTest("cleanupExpiredHandoffs is throttled and returns 0 on the second call within the throttle window", async () => {
  const first = await handoffsDb.cleanupExpiredHandoffs();
  assert.equal(typeof first, "number");
  const second = await handoffsDb.cleanupExpiredHandoffs();
  assert.equal(second, 0);
});

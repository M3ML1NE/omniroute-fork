import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

// Regression test for a missing `await` on `isNoLog(apiKeyId)` inside
// `saveCallLogInternal` (src/lib/usage/callLogs.ts). Without the await,
// `Boolean(entry.noLog) || (apiKeyId ? isNoLog(apiKeyId) : false)` evaluates
// to a pending Promise object whenever apiKeyId is truthy — which is always
// truthy — so EVERY authenticated request was treated as no-log and had its
// request/response bodies silently dropped (detail_state stayed "none").
//
// Uses unique ids and cleans up so it is safe on the shared Postgres test DB.

const core = await import("../../src/lib/db/core.ts");
const callLogs = await import("../../src/lib/usage/callLogs.ts");
const noLogModule = await import("../../src/lib/compliance/noLog.ts");

const RUN_PREFIX = `clnl-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

describe("saveCallLogInternal: isNoLog is properly awaited", () => {
  after(async () => {
    const db = core.getDbInstance();
    await db.prepare("DELETE FROM call_logs WHERE id LIKE ?").run(`${RUN_PREFIX}%`);
    noLogModule.setNoLog(`${RUN_PREFIX}-key`, false);
  });

  it("persists request/response bodies for an API key that is NOT no-log", async () => {
    const id = `${RUN_PREFIX}-1`;
    const apiKeyId = `${RUN_PREFIX}-key`;

    await callLogs.saveCallLog({
      id,
      timestamp: new Date().toISOString(),
      status: 200,
      model: "gpt-4o-mini",
      provider: "openai-compatible-xyz",
      apiKeyId,
      requestBody: { messages: [{ role: "user", content: "hello" }] },
      responseBody: { choices: [{ message: { role: "assistant", content: "hi" } }] },
    });

    const detail = await callLogs.getCallLogById(id);
    assert.ok(detail, "detail row exists");
    assert.notEqual(detail.detailState, "none", "detail_state must not be 'none' for a logged key");
    assert.equal(detail.hasRequestBody, true, "hasRequestBody must be true");
    assert.equal(detail.hasResponseBody, true, "hasResponseBody must be true");
    assert.deepEqual(detail.requestBody, { messages: [{ role: "user", content: "hello" }] });
  });

  it("still suppresses request/response bodies when the key genuinely IS no-log", async () => {
    const id = `${RUN_PREFIX}-2`;
    const apiKeyId = `${RUN_PREFIX}-key-nolog`;

    // Mark this key no-log via the same in-memory mechanism compliance/noLog.ts
    // uses (isNoLog checks noLogKeys before hitting the DB).
    noLogModule.setNoLog(apiKeyId, true);

    await callLogs.saveCallLog({
      id,
      timestamp: new Date().toISOString(),
      status: 200,
      model: "gpt-4o-mini",
      provider: "openai-compatible-xyz",
      apiKeyId,
      requestBody: { messages: [{ role: "user", content: "secret" }] },
      responseBody: { choices: [{ message: { role: "assistant", content: "secret reply" } }] },
    });

    const detail = await callLogs.getCallLogById(id);
    assert.ok(detail, "detail row exists");
    assert.equal(detail.hasRequestBody, false, "hasRequestBody must be false for no-log key");
    assert.equal(detail.hasResponseBody, false, "hasResponseBody must be false for no-log key");

    noLogModule.setNoLog(apiKeyId, false);
  });
});

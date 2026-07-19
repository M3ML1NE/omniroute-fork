import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

// Proves the dashboard logs card fields added for the X-Request-ID (client
// header, falling back to the upstream-echoed header) and Upstream API
// (GigaChat v1/v2) requirement: saveCallLog persists both columns and both
// the list (getCallLogs) and detail (getCallLogById) read paths surface them.
// Uses unique ids and cleans up so it is safe on the shared Postgres test DB.

const core = await import("../../src/lib/db/core.ts");
const callLogs = await import("../../src/lib/usage/callLogs.ts");

const RUN_PREFIX = `clr-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

describe("call_logs: request_id + upstream_api_version persistence", () => {
  after(async () => {
    const db = core.getDbInstance();
    await db.prepare("DELETE FROM call_logs WHERE id LIKE ?").run(`${RUN_PREFIX}%`);
  });

  it("persists requestId + upstreamApiVersion and both APIs return them", async () => {
    const id = `${RUN_PREFIX}-1`;
    await callLogs.saveCallLog({
      id,
      timestamp: new Date().toISOString(),
      status: 200,
      model: "GigaChat",
      provider: "gigachat-compatible-abc123",
      requestId: "qa-rid-123",
      upstreamApiVersion: "v2",
    });

    const detail = await callLogs.getCallLogById(id);
    assert.ok(detail, "detail row exists");
    assert.equal(detail.requestId, "qa-rid-123", "detail surfaces requestId");
    assert.equal(detail.upstreamApiVersion, "v2", "detail surfaces upstreamApiVersion");

    const list = await callLogs.getCallLogs({ provider: "gigachat-compatible-abc123" });
    const listed = list.find((row) => row.id === id);
    assert.ok(listed, "list row exists");
    assert.equal(listed.requestId, "qa-rid-123", "list surfaces requestId");
    assert.equal(listed.upstreamApiVersion, "v2", "list surfaces upstreamApiVersion");
  });

  it("stores '—'-equivalent null when neither field is provided", async () => {
    const id = `${RUN_PREFIX}-2`;
    await callLogs.saveCallLog({
      id,
      timestamp: new Date().toISOString(),
      status: 200,
      model: "gpt-4o-mini",
      provider: "openai-compatible-xyz",
    });

    const detail = await callLogs.getCallLogById(id);
    assert.ok(detail, "detail row exists");
    assert.equal(detail.requestId, null, "requestId absent when not sent");
    assert.equal(detail.upstreamApiVersion, null, "upstreamApiVersion absent for non-gigachat");
  });

  it("non-gigachat provider keeps upstreamApiVersion null even with a requestId", async () => {
    const id = `${RUN_PREFIX}-3`;
    await callLogs.saveCallLog({
      id,
      timestamp: new Date().toISOString(),
      status: 200,
      model: "gpt-4o-mini",
      provider: "openai-compatible-xyz",
      requestId: "client-sent-id",
    });

    const detail = await callLogs.getCallLogById(id);
    assert.ok(detail, "detail row exists");
    assert.equal(detail.requestId, "client-sent-id", "requestId still persisted");
    assert.equal(detail.upstreamApiVersion, null, "upstreamApiVersion stays null for non-gigachat");
  });
});

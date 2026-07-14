import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-context-relay-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const pgModule = await import("../../src/lib/db/postgres.ts");
const handoffsDb = await import("../../src/lib/db/contextHandoffs.ts");
const contextHandoff = await import("../../open-sse/services/contextHandoff.ts");

const RUN_PREFIX = `context-relay-${process.pid}`;

function serialTest(name: string, fn: () => Promise<void>) {
  test(name, { concurrency: false }, fn);
}

async function resetStorage() {
  const schema = pgModule.getSchema();
  await pgModule.query(`DELETE FROM ${schema}.context_handoffs WHERE session_id LIKE $1`, [
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

// ── resolveContextRelayConfig ─────────────────────────────────────────────

test("resolveContextRelayConfig returns defaults for null/empty config", () => {
  const result = contextHandoff.resolveContextRelayConfig(null);
  assert.equal(result.handoffModel, "");
  assert.equal(result.handoffThreshold, contextHandoff.HANDOFF_WARNING_THRESHOLD);
  assert.deepEqual(result.handoffProviders, ["codex"]);
  assert.equal(result.maxMessagesForSummary, 30);
});

test("resolveContextRelayConfig uses an explicit handoffModel when provided", () => {
  const result = contextHandoff.resolveContextRelayConfig({ handoffModel: "gpt-4o-mini" });
  assert.equal(result.handoffModel, "gpt-4o-mini");
});

test("resolveContextRelayConfig ignores an out-of-range handoffThreshold", () => {
  const tooHigh = contextHandoff.resolveContextRelayConfig({
    handoffThreshold: contextHandoff.HANDOFF_EXHAUSTION_THRESHOLD,
  });
  assert.equal(tooHigh.handoffThreshold, contextHandoff.HANDOFF_WARNING_THRESHOLD);

  const negative = contextHandoff.resolveContextRelayConfig({ handoffThreshold: -1 });
  assert.equal(negative.handoffThreshold, contextHandoff.HANDOFF_WARNING_THRESHOLD);
});

test("resolveContextRelayConfig accepts a valid handoffThreshold", () => {
  const result = contextHandoff.resolveContextRelayConfig({ handoffThreshold: 0.7 });
  assert.equal(result.handoffThreshold, 0.7);
});

test("resolveContextRelayConfig normalizes explicit handoffProviders to lowercase-trimmed strings", () => {
  const result = contextHandoff.resolveContextRelayConfig({
    handoffProviders: [" Codex ", "OPENAI", "", 42],
  });
  assert.deepEqual(result.handoffProviders, ["codex", "openai"]);
});

test("resolveContextRelayConfig clamps maxMessagesForSummary to [5, 100]", () => {
  const tooLow = contextHandoff.resolveContextRelayConfig({ maxMessagesForSummary: 1 });
  assert.equal(tooLow.maxMessagesForSummary, 30);
  const valid = contextHandoff.resolveContextRelayConfig({ maxMessagesForSummary: 50 });
  assert.equal(valid.maxMessagesForSummary, 50);
});

// ── selectMessagesForSummary ──────────────────────────────────────────────

test("selectMessagesForSummary keeps system messages plus the most recent non-system messages", () => {
  const messages = [
    { role: "system", content: "sys prompt" },
    { role: "user", content: "msg 1" },
    { role: "assistant", content: "msg 2" },
    { role: "user", content: "msg 3" },
  ];
  const selected = contextHandoff.selectMessagesForSummary(messages, 2);
  assert.equal(selected[0].role, "system");
  assert.equal(selected.length, 3);
  assert.equal(selected[1].content, "msg 2");
  assert.equal(selected[2].content, "msg 3");
});

test("selectMessagesForSummary filters out non-object entries", () => {
  const messages = [null, undefined, { role: "user", content: "valid" }] as any;
  const selected = contextHandoff.selectMessagesForSummary(messages, 10);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].content, "valid");
});

test("selectMessagesForSummary falls back to the last non-system message when history is oversized and there are no system messages", () => {
  const hugeContent = "x".repeat(2_000_000);
  const messages = [
    { role: "user", content: hugeContent },
    { role: "assistant", content: hugeContent },
    { role: "user", content: "final message" },
  ];
  const selected = contextHandoff.selectMessagesForSummary(messages, 10);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].content, "final message");
});

test("selectMessagesForSummary returns [] when messages is empty", () => {
  const selected = contextHandoff.selectMessagesForSummary([], 10);
  assert.deepEqual(selected, []);
});

// ── parseHandoffJSON ───────────────────────────────────────────────────────

test("parseHandoffJSON parses a well-formed JSON payload", () => {
  const content = JSON.stringify({
    summary: "the summary",
    taskProgress: "in progress",
    keyDecisions: ["d1", "d2"],
    activeEntities: ["e1"],
  });
  const result = contextHandoff.parseHandoffJSON(content);
  assert.ok(result);
  assert.equal(result!.summary, "the summary");
  assert.equal(result!.taskProgress, "in progress");
  assert.deepEqual(result!.keyDecisions, ["d1", "d2"]);
  assert.deepEqual(result!.activeEntities, ["e1"]);
});

test("parseHandoffJSON extracts JSON embedded in a markdown code fence", () => {
  const content = "```json\n" + JSON.stringify({ summary: "fenced summary" }) + "\n```";
  const result = contextHandoff.parseHandoffJSON(content);
  assert.ok(result);
  assert.equal(result!.summary, "fenced summary");
});

test("parseHandoffJSON extracts the first {...} block from surrounding prose", () => {
  const content = `Here is the summary: ${JSON.stringify({ summary: "extracted" })} — done.`;
  const result = contextHandoff.parseHandoffJSON(content);
  assert.ok(result);
  assert.equal(result!.summary, "extracted");
});

test("parseHandoffJSON returns null for empty or unparseable content", () => {
  assert.equal(contextHandoff.parseHandoffJSON(""), null);
  assert.equal(contextHandoff.parseHandoffJSON("not json at all"), null);
});

test("parseHandoffJSON returns null when the parsed object has no summary", () => {
  const content = JSON.stringify({ taskProgress: "progress only" });
  assert.equal(contextHandoff.parseHandoffJSON(content), null);
});

test("parseHandoffJSON defaults keyDecisions/activeEntities to [] when absent or malformed", () => {
  const content = JSON.stringify({ summary: "just a summary" });
  const result = contextHandoff.parseHandoffJSON(content);
  assert.deepEqual(result!.keyDecisions, []);
  assert.deepEqual(result!.activeEntities, []);
});

// ── buildHandoffSystemMessage / injectHandoffIntoBody ─────────────────────

const SAMPLE_PAYLOAD = {
  sessionId: "s1",
  comboName: "c1",
  fromAccount: "acc1",
  summary: "a <script>summary</script>",
  keyDecisions: ["decision & more"],
  taskProgress: "progress",
  activeEntities: ["entity1"],
  messageCount: 3,
  model: "gpt-4o",
  warningThresholdPct: 0.85,
  generatedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60000).toISOString(),
};

test("buildHandoffSystemMessage escapes XML-unsafe characters in the summary", () => {
  const message = contextHandoff.buildHandoffSystemMessage(SAMPLE_PAYLOAD);
  assert.match(message, /&lt;script&gt;/);
  assert.doesNotMatch(message, /<script>/);
});

test("buildHandoffSystemMessage includes the message count and key decisions", () => {
  const message = contextHandoff.buildHandoffSystemMessage(SAMPLE_PAYLOAD);
  assert.match(message, /<messages_processed>3<\/messages_processed>/);
  assert.match(message, /decision &amp; more/);
});

test("injectHandoffIntoBody prepends a system message for chat-completions-style bodies", () => {
  const body = { messages: [{ role: "user", content: "hi" }] };
  const result = contextHandoff.injectHandoffIntoBody(body, SAMPLE_PAYLOAD);
  assert.equal((result.messages as any[])[0].role, "system");
  assert.equal((result.messages as any[]).length, 2);
});

test("injectHandoffIntoBody prepends to instructions for Responses-API-style bodies", () => {
  const body = { input: "user query", instructions: "existing instructions" };
  const result = contextHandoff.injectHandoffIntoBody(body, SAMPLE_PAYLOAD);
  assert.match(result.instructions as string, /existing instructions$/);
  assert.match(result.instructions as string, /^<context_handoff>/);
});

test("injectHandoffIntoBody strips an empty messages array on Responses-API-style bodies", () => {
  const body = { input: "user query", messages: [] };
  const result = contextHandoff.injectHandoffIntoBody(body, SAMPLE_PAYLOAD);
  assert.ok(!("messages" in result));
  assert.ok("instructions" in result);
});

// ── shouldGenerateUniversalHandoff ────────────────────────────────────────

const DEFAULT_UNIVERSAL_CONFIG = contextHandoff.resolveUniversalHandoffConfig(null, null);

test("shouldGenerateUniversalHandoff returns 'skip' when the config is disabled", async () => {
  const decision = await contextHandoff.shouldGenerateUniversalHandoff({
    sessionId: `${RUN_PREFIX}-s1`,
    comboName: "combo-1",
    previousModel: "gpt-4o",
    currentModel: "claude-3",
    universalConfig: { ...DEFAULT_UNIVERSAL_CONFIG, enabled: false },
  });
  assert.equal(decision, "skip");
});

test("shouldGenerateUniversalHandoff returns 'skip' when there is no previous model", async () => {
  const decision = await contextHandoff.shouldGenerateUniversalHandoff({
    sessionId: `${RUN_PREFIX}-s2`,
    comboName: "combo-1",
    previousModel: null,
    currentModel: "claude-3",
    universalConfig: DEFAULT_UNIVERSAL_CONFIG,
  });
  assert.equal(decision, "skip");
});

test("shouldGenerateUniversalHandoff returns 'skip' when previous and current models are the same", async () => {
  const decision = await contextHandoff.shouldGenerateUniversalHandoff({
    sessionId: `${RUN_PREFIX}-s3`,
    comboName: "combo-1",
    previousModel: "gpt-4o",
    currentModel: "gpt-4o",
    universalConfig: DEFAULT_UNIVERSAL_CONFIG,
  });
  assert.equal(decision, "skip");
});

serialTest("shouldGenerateUniversalHandoff returns 'generate' when no handoff exists yet", async () => {
  const decision = await contextHandoff.shouldGenerateUniversalHandoff({
    sessionId: `${RUN_PREFIX}-s4`,
    comboName: "combo-1",
    previousModel: "gpt-4o",
    currentModel: "claude-3",
    universalConfig: DEFAULT_UNIVERSAL_CONFIG,
  });
  assert.equal(decision, "generate");
});

serialTest("shouldGenerateUniversalHandoff returns 'inject' when a handoff with a summary already exists", async () => {
  const sessionId = `${RUN_PREFIX}-s5`;
  await handoffsDb.upsertHandoff({
    sessionId,
    comboName: "combo-1",
    fromAccount: "acc1",
    summary: "existing summary",
    keyDecisions: [],
    taskProgress: "",
    activeEntities: [],
    messageCount: 1,
    model: "gpt-4o",
    warningThresholdPct: 0.85,
    generatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  });

  const decision = await contextHandoff.shouldGenerateUniversalHandoff({
    sessionId,
    comboName: "combo-1",
    previousModel: "gpt-4o",
    currentModel: "claude-3",
    universalConfig: DEFAULT_UNIVERSAL_CONFIG,
  });
  assert.equal(decision, "inject");
});

// ── maybeGenerateHandoff (currently unused in the request pipeline, but
// exported and must still behave correctly for any future caller) ─────────

serialTest("maybeGenerateHandoff is a no-op when sessionId or connectionId is missing", async () => {
  await assert.doesNotReject(
    contextHandoff.maybeGenerateHandoff({
      sessionId: null,
      comboName: "combo-1",
      connectionId: "acc1",
      percentUsed: 0.9,
      messages: [],
      model: "gpt-4o",
      expiresAt: null,
      handleSingleModel: async () => new Response("{}"),
    })
  );
});

serialTest("maybeGenerateHandoff is a no-op when percentUsed is below the configured threshold", async () => {
  let called = false;
  await contextHandoff.maybeGenerateHandoff({
    sessionId: `${RUN_PREFIX}-below-threshold`,
    comboName: "combo-1",
    connectionId: "acc1",
    percentUsed: 0.1,
    messages: [{ role: "user", content: "hi" }],
    model: "gpt-4o",
    expiresAt: null,
    handleSingleModel: async () => {
      called = true;
      return new Response("{}");
    },
  });
  // Below-threshold requests never even schedule the async summary call.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(called, false);
});

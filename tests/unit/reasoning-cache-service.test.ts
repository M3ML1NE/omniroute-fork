import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-reasoning-cache-svc-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const pgModule = await import("../../src/lib/db/postgres.ts");
const reasoningCache = await import("../../open-sse/services/reasoningCache.ts");

const RUN_PREFIX = `reasoning-cache-svc-${process.pid}`;

function serialTest(name: string, fn: () => Promise<void>) {
  test(name, { concurrency: false }, fn);
}

async function resetStorage() {
  const schema = pgModule.getSchema();
  await pgModule.query(`DELETE FROM ${schema}.reasoning_cache WHERE tool_call_id LIKE $1`, [
    `${RUN_PREFIX}-%`,
  ]);
  core.resetDbInstance();
  await reasoningCache.clearReasoningCacheAll();
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  await resetStorage();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function uniqueKey(suffix: string): string {
  return `${RUN_PREFIX}-${suffix}-${Math.random().toString(16).slice(2, 8)}`;
}

// ── isDeepSeekReasoningModel (pure) ─────────────────────────────────────────

test("isDeepSeekReasoningModel requires thinkingEnabled=true and a matching model name", () => {
  assert.equal(
    reasoningCache.isDeepSeekReasoningModel({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      thinkingEnabled: true,
    }),
    true
  );
  assert.equal(
    reasoningCache.isDeepSeekReasoningModel({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      thinkingEnabled: false,
    }),
    false
  );
  assert.equal(
    reasoningCache.isDeepSeekReasoningModel({
      provider: "deepseek",
      model: "deepseek-chat",
      thinkingEnabled: true,
    }),
    false
  );
});

// ── requiresReasoningReplay (pure) ─────────────────────────────────────────

test("requiresReasoningReplay honors an explicit interleavedField signal first", () => {
  assert.equal(
    reasoningCache.requiresReasoningReplay({
      provider: "some-unrelated-provider",
      model: "some-unrelated-model",
      interleavedField: "reasoning_content",
    }),
    true
  );
  assert.equal(
    reasoningCache.requiresReasoningReplay({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      thinkingEnabled: true,
      interleavedField: "reasoning_details",
    }),
    false
  );
});

test("requiresReasoningReplay returns false for the legacy DeepSeek reasoner/R1 family (inverse contract)", () => {
  assert.equal(
    reasoningCache.requiresReasoningReplay({ provider: "deepseek", model: "deepseek-reasoner" }),
    false
  );
  assert.equal(
    reasoningCache.requiresReasoningReplay({ provider: "deepseek", model: "deepseek-r1" }),
    false
  );
});

test("requiresReasoningReplay returns true for DeepSeek V4 thinking models", () => {
  assert.equal(
    reasoningCache.requiresReasoningReplay({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      thinkingEnabled: true,
    }),
    true
  );
});

test("requiresReasoningReplay falls back to the known-provider allowlist", () => {
  assert.equal(
    reasoningCache.requiresReasoningReplay({ provider: "fireworks", model: "some-model" }),
    true
  );
});

test("requiresReasoningReplay falls back to model-name pattern matching (kimi-k2, qwq, etc.)", () => {
  assert.equal(
    reasoningCache.requiresReasoningReplay({ provider: "unknown-provider", model: "kimi-k2-instruct" }),
    true
  );
  assert.equal(
    reasoningCache.requiresReasoningReplay({ provider: "unknown-provider", model: "gpt-4o" }),
    false
  );
});

test("requiresReasoningReplay returns false when allowLegacyFallback is false and no explicit signal matched", () => {
  assert.equal(
    reasoningCache.requiresReasoningReplay({
      provider: "fireworks",
      model: "some-model",
      allowLegacyFallback: false,
    }),
    false
  );
});

// ── cacheReasoningFromAssistantMessage / lookupReasoning ────────────────────

serialTest("cacheReasoningFromAssistantMessage returns 0 for a non-assistant message", async () => {
  const written = reasoningCache.cacheReasoningFromAssistantMessage(
    { role: "user", reasoning_content: "x" },
    "deepseek",
    "deepseek-v4-flash"
  );
  assert.equal(written, 0);
});

serialTest("cacheReasoningFromAssistantMessage returns 0 when there is no reasoning content", async () => {
  const written = reasoningCache.cacheReasoningFromAssistantMessage(
    { role: "assistant" },
    "deepseek",
    "deepseek-v4-flash"
  );
  assert.equal(written, 0);
});

serialTest("cacheReasoningFromAssistantMessage caches per tool_call_id and lookupReasoning retrieves it", async () => {
  const toolCallId = uniqueKey("tool-call");
  const written = reasoningCache.cacheReasoningFromAssistantMessage(
    {
      role: "assistant",
      reasoning_content: "the model's reasoning",
      tool_calls: [{ id: toolCallId }],
    },
    "deepseek",
    "deepseek-v4-flash"
  );
  assert.equal(written, 1);

  const result = await reasoningCache.lookupReasoning(toolCallId);
  assert.equal(result, "the model's reasoning");
});

serialTest("cacheReasoningFromAssistantMessage falls back to a request/message-index key when there are no tool_calls", async () => {
  const requestId = uniqueKey("req");
  const written = reasoningCache.cacheReasoningFromAssistantMessage(
    { role: "assistant", reasoning: "fallback-path reasoning" },
    "deepseek",
    "deepseek-v4-flash",
    { requestId, messageIndex: 0 }
  );
  assert.equal(written, 1);

  const result = await reasoningCache.lookupReasoning(`request:${requestId}:message:0`);
  assert.equal(result, "fallback-path reasoning");
});

serialTest("cacheReasoningFromAssistantMessage returns 0 with no tool_calls and no requestId/messageIndex context", async () => {
  const written = reasoningCache.cacheReasoningFromAssistantMessage(
    { role: "assistant", reasoning: "orphaned reasoning" },
    "deepseek",
    "deepseek-v4-flash"
  );
  assert.equal(written, 0);
});

serialTest("lookupReasoning returns null for an unknown key", async () => {
  const result = await reasoningCache.lookupReasoning(uniqueKey("missing"));
  assert.equal(result, null);
});

serialTest("lookupReasoning returns null immediately for an empty string key", async () => {
  const result = await reasoningCache.lookupReasoning("");
  assert.equal(result, null);
});

serialTest("cacheReasoningFromAssistantMessage batches the same reasoning across multiple tool_call_ids", async () => {
  const idA = uniqueKey("batch-a");
  const idB = uniqueKey("batch-b");
  const written = reasoningCache.cacheReasoningFromAssistantMessage(
    {
      role: "assistant",
      reasoning_content: "shared reasoning",
      tool_calls: [{ id: idA }, { id: idB }],
    },
    "deepseek",
    "deepseek-v4-flash"
  );
  assert.equal(written, 2);

  assert.equal(await reasoningCache.lookupReasoning(idA), "shared reasoning");
  assert.equal(await reasoningCache.lookupReasoning(idB), "shared reasoning");
});

// ── recordReplay / stats ────────────────────────────────────────────────────

serialTest("getReasoningCacheServiceStats reflects hits/misses/replays and memoryEntries", async () => {
  const toolCallId = uniqueKey("stats");
  reasoningCache.cacheReasoning(toolCallId, "deepseek", "deepseek-v4-flash", "reasoning text");

  await reasoningCache.lookupReasoning(toolCallId); // hit
  await reasoningCache.lookupReasoning(uniqueKey("stats-miss")); // miss
  reasoningCache.recordReplay();

  const stats = await reasoningCache.getReasoningCacheServiceStats();
  assert.ok(stats.hits >= 1);
  assert.ok(stats.misses >= 1);
  assert.ok(stats.replays >= 1);
  assert.ok(stats.memoryEntries >= 1);
  assert.match(stats.replayRate, /%$/);
});

// ── deleteReasoningCacheEntry / clearReasoningCacheAll / cleanupReasoningCache ──

serialTest("deleteReasoningCacheEntry removes a cached entry so a subsequent lookup misses", async () => {
  const toolCallId = uniqueKey("delete");
  reasoningCache.cacheReasoning(toolCallId, "deepseek", "deepseek-v4-flash", "to be deleted");
  assert.equal(await reasoningCache.lookupReasoning(toolCallId), "to be deleted");

  await reasoningCache.deleteReasoningCacheEntry(toolCallId);

  assert.equal(await reasoningCache.lookupReasoning(toolCallId), null);
});

serialTest("deleteReasoningCacheEntry returns 0 for an empty key without touching the cache", async () => {
  const result = await reasoningCache.deleteReasoningCacheEntry("");
  assert.equal(result, 0);
});

serialTest("clearReasoningCacheAll wipes every entry and resets hit/miss/replay counters", async () => {
  const toolCallId = uniqueKey("clear-all");
  reasoningCache.cacheReasoning(toolCallId, "deepseek", "deepseek-v4-flash", "clear me");
  await reasoningCache.lookupReasoning(toolCallId);
  reasoningCache.recordReplay();

  await reasoningCache.clearReasoningCacheAll();

  assert.equal(await reasoningCache.lookupReasoning(toolCallId), null);
  const stats = await reasoningCache.getReasoningCacheServiceStats();
  assert.equal(stats.hits, 0);
  assert.equal(stats.misses, 1); // the lookup above (post-clear) counts as a fresh miss
  assert.equal(stats.replays, 0);
});

serialTest("clearReasoningCacheAll(provider) only clears memory entries for that provider", async () => {
  const keepId = uniqueKey("keep");
  const clearId = uniqueKey("clear-provider");
  reasoningCache.cacheReasoning(keepId, "fireworks", "some-model", "keep this");
  reasoningCache.cacheReasoning(clearId, "deepseek", "deepseek-v4-flash", "clear this");

  await reasoningCache.clearReasoningCacheAll("deepseek");

  assert.equal(await reasoningCache.lookupReasoning(keepId), "keep this");
});

serialTest("cleanupReasoningCache does not throw and returns a number", async () => {
  const result = await reasoningCache.cleanupReasoningCache();
  assert.equal(typeof result, "number");
});

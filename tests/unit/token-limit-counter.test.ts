import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-token-limit-counter-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const pgModule = await import("../../src/lib/db/postgres.ts");
const tokenLimitsDb = await import("../../src/lib/db/tokenLimits.ts");
const counter = await import("../../open-sse/services/tokenLimitCounter.ts");

const RUN_PREFIX = `token-limit-counter-${process.pid}`;
const API_KEY = `${RUN_PREFIX}-key`;

function serialTest(name: string, fn: () => Promise<void>) {
  test(name, { concurrency: false }, fn);
}

async function resetStorage() {
  const schema = pgModule.getSchema();
  await pgModule.query(
    `DELETE FROM ${schema}.api_key_token_counters WHERE limit_id IN (SELECT id FROM ${schema}.api_key_token_limits WHERE api_key_id = $1)`,
    [API_KEY]
  );
  await pgModule.query(
    `DELETE FROM ${schema}.api_key_token_limit_reset_logs WHERE limit_id IN (SELECT id FROM ${schema}.api_key_token_limits WHERE api_key_id = $1)`,
    [API_KEY]
  );
  await pgModule.query(`DELETE FROM ${schema}.api_key_token_limits WHERE api_key_id = $1`, [
    API_KEY,
  ]);
  await pgModule.query(`DELETE FROM ${schema}.usage_history WHERE api_key_id = $1`, [API_KEY]);
  core.resetDbInstance();
  counter.clearTokenLimitCache();
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  await resetStorage();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

async function insertUsageRow({
  provider = "openai",
  model = "gpt-4o",
  tokensInput = 0,
  tokensOutput = 0,
  tokensReasoning = 0,
  timestamp = new Date().toISOString(),
}: {
  provider?: string;
  model?: string;
  tokensInput?: number;
  tokensOutput?: number;
  tokensReasoning?: number;
  timestamp?: string;
}) {
  const db = core.getDbInstance();
  await db
    .prepare(
      `INSERT INTO usage_history (provider, model, api_key_id, tokens_input, tokens_output, tokens_reasoning, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(provider, model, API_KEY, tokensInput, tokensOutput, tokensReasoning, timestamp);
}

serialTest("seedWindowUsageFromHistory sums tokens for a global-scope limit", async () => {
  await insertUsageRow({ tokensInput: 100, tokensOutput: 50 });
  await insertUsageRow({ tokensInput: 30, tokensOutput: 20, tokensReasoning: 10 });

  const limit = await tokenLimitsDb.upsertTokenLimit({
    apiKeyId: API_KEY,
    scopeType: "global",
    tokenLimit: 100000,
  });

  const seeded = await counter.seedWindowUsageFromHistory(limit);
  assert.equal(seeded, 210);
});

serialTest("seedWindowUsageFromHistory filters by model for a model-scope limit", async () => {
  await insertUsageRow({ model: "gpt-4o", tokensInput: 100 });
  await insertUsageRow({ model: "gpt-3.5-turbo", tokensInput: 500 });

  const limit = await tokenLimitsDb.upsertTokenLimit({
    apiKeyId: API_KEY,
    scopeType: "model",
    scopeValue: "gpt-4o",
    tokenLimit: 100000,
  });

  const seeded = await counter.seedWindowUsageFromHistory(limit);
  assert.equal(seeded, 100);
});

serialTest("seedWindowUsageFromHistory filters by provider for a provider-scope limit", async () => {
  await insertUsageRow({ provider: "openai", tokensInput: 100 });
  await insertUsageRow({ provider: "anthropic", tokensInput: 500 });

  const limit = await tokenLimitsDb.upsertTokenLimit({
    apiKeyId: API_KEY,
    scopeType: "provider",
    scopeValue: "openai",
    tokenLimit: 100000,
  });

  const seeded = await counter.seedWindowUsageFromHistory(limit);
  assert.equal(seeded, 100);
});

serialTest("seedWindowUsageFromHistory returns 0 when there is no matching usage history", async () => {
  const limit = await tokenLimitsDb.upsertTokenLimit({
    apiKeyId: API_KEY,
    scopeType: "global",
    tokenLimit: 100000,
  });
  assert.equal(await counter.seedWindowUsageFromHistory(limit), 0);
});

serialTest("getCurrentWindowUsage seeds from history on first read of a fresh window", async () => {
  await insertUsageRow({ tokensInput: 200 });

  const limit = await tokenLimitsDb.upsertTokenLimit({
    apiKeyId: API_KEY,
    scopeType: "global",
    tokenLimit: 100000,
  });

  const usage = await counter.getCurrentWindowUsage(limit);
  assert.equal(usage, 200);
});

serialTest("getCurrentWindowUsage serves from cache on a repeated call without forceFresh", async () => {
  await insertUsageRow({ tokensInput: 200 });
  const limit = await tokenLimitsDb.upsertTokenLimit({
    apiKeyId: API_KEY,
    scopeType: "global",
    tokenLimit: 100000,
  });

  const first = await counter.getCurrentWindowUsage(limit);
  // Insert more usage history after the first read — a cached second read
  // should NOT pick this up since seeding only fires once per fresh window.
  await insertUsageRow({ tokensInput: 999 });
  const second = await counter.getCurrentWindowUsage(limit);

  assert.equal(first, 200);
  assert.equal(second, 200);
});

serialTest("addWindowTokens increments usage and updates the cache", async () => {
  const limit = await tokenLimitsDb.upsertTokenLimit({
    apiKeyId: API_KEY,
    scopeType: "global",
    tokenLimit: 100000,
  });

  const total1 = await counter.addWindowTokens(limit, 500);
  assert.equal(total1, 500);

  const total2 = await counter.addWindowTokens(limit, 250);
  assert.equal(total2, 750);

  const usage = await counter.getCurrentWindowUsage(limit, Date.now(), true);
  assert.equal(usage, 750);
});

serialTest("addWindowTokens floors non-positive token deltas to 0", async () => {
  const limit = await tokenLimitsDb.upsertTokenLimit({
    apiKeyId: API_KEY,
    scopeType: "global",
    tokenLimit: 100000,
  });
  const total = await counter.addWindowTokens(limit, -5);
  assert.equal(total, 0);
});

serialTest("syncCache and invalidateLimit control the in-memory cache directly", async () => {
  const limit = await tokenLimitsDb.upsertTokenLimit({
    apiKeyId: API_KEY,
    scopeType: "global",
    tokenLimit: 100000,
  });
  const { windowStart } = tokenLimitsDb.resetWindowIfElapsed(limit);

  counter.syncCache(limit.id, windowStart, 12345);
  const cached = await counter.getCurrentWindowUsage(limit);
  assert.equal(cached, 12345);

  counter.invalidateLimit(limit.id);
  // After invalidation, a forceFresh=false read falls through to the DB
  // (which has no counter row yet) rather than the stale cached value.
  const afterInvalidate = await counter.getCurrentWindowUsage(limit);
  assert.notEqual(afterInvalidate, 12345);
});

serialTest("checkTokenLimits returns null when the api key has no active limits", async () => {
  const breach = await counter.checkTokenLimits(API_KEY, "openai", "gpt-4o");
  assert.equal(breach, null);
});

serialTest("checkTokenLimits returns null for an empty apiKeyId", async () => {
  assert.equal(await counter.checkTokenLimits("", "openai", "gpt-4o"), null);
});

serialTest("checkTokenLimits returns null when usage is under the limit", async () => {
  await tokenLimitsDb.upsertTokenLimit({
    apiKeyId: API_KEY,
    scopeType: "global",
    tokenLimit: 100000,
  });
  const breach = await counter.checkTokenLimits(API_KEY, "openai", "gpt-4o");
  assert.equal(breach, null);
});

serialTest("checkTokenLimits reports a breach once usage reaches the configured limit", async () => {
  const limit = await tokenLimitsDb.upsertTokenLimit({
    apiKeyId: API_KEY,
    scopeType: "global",
    tokenLimit: 100,
  });
  await counter.addWindowTokens(limit, 150);

  const breach = await counter.checkTokenLimits(API_KEY, "openai", "gpt-4o");
  assert.ok(breach);
  assert.equal(breach!.limitId, limit.id);
  assert.equal(breach!.remaining, 0);
  assert.equal(breach!.tokensUsed, 150);
});

serialTest("checkTokenLimits skips disabled limits", async () => {
  const limit = await tokenLimitsDb.upsertTokenLimit({
    apiKeyId: API_KEY,
    scopeType: "global",
    tokenLimit: 100,
    enabled: false,
  });
  await counter.addWindowTokens(limit, 500);

  const breach = await counter.checkTokenLimits(API_KEY, "openai", "gpt-4o");
  assert.equal(breach, null);
});

serialTest("checkTokenLimits returns the tightest (least-remaining) breach across multiple limits", async () => {
  const tightLimit = await tokenLimitsDb.upsertTokenLimit({
    apiKeyId: API_KEY,
    scopeType: "model",
    scopeValue: "gpt-4o",
    tokenLimit: 100,
  });
  const looseLimit = await tokenLimitsDb.upsertTokenLimit({
    apiKeyId: API_KEY,
    scopeType: "global",
    tokenLimit: 1000,
  });
  await counter.addWindowTokens(tightLimit, 100);
  await counter.addWindowTokens(looseLimit, 1000);

  const breach = await counter.checkTokenLimits(API_KEY, "openai", "gpt-4o");
  assert.ok(breach);
  // Both are fully breached (remaining=0); the tiebreaker prefers the
  // smaller limitValue, i.e. the tighter (model-scope) limit.
  assert.equal(breach!.limitId, tightLimit.id);
});

serialTest("recordTokenUsage is a fire-and-forget no-op for an empty apiKeyId or non-positive tokens", () => {
  assert.doesNotThrow(() => counter.recordTokenUsage("", "openai", "gpt-4o", 100));
  assert.doesNotThrow(() => counter.recordTokenUsage(API_KEY, "openai", "gpt-4o", 0));
  assert.doesNotThrow(() => counter.recordTokenUsage(API_KEY, "openai", "gpt-4o", -5));
});

serialTest("recordTokenUsage increments the window total for a matching limit (async, best-effort)", async () => {
  const limit = await tokenLimitsDb.upsertTokenLimit({
    apiKeyId: API_KEY,
    scopeType: "global",
    tokenLimit: 100000,
  });

  counter.recordTokenUsage(API_KEY, "openai", "gpt-4o", 300);

  // recordTokenUsage is intentionally fire-and-forget (returns void); poll
  // briefly for its internal async chain to land.
  let usage = 0;
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    usage = await counter.getCurrentWindowUsage(limit, Date.now(), true);
    if (usage > 0) break;
  }
  assert.equal(usage, 300);
});

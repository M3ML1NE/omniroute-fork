import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-token-limits-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const pgModule = await import("../../src/lib/db/postgres.ts");
const tokenLimitsDb = await import("../../src/lib/db/tokenLimits.ts");

const RUN_PREFIX = `token-limits-${process.pid}`;
const API_KEY = `${RUN_PREFIX}-key-a`;

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

serialTest("upsertTokenLimit creates a global limit with normalized defaults", async () => {
  const created = await tokenLimitsDb.upsertTokenLimit({
    apiKeyId: API_KEY,
    scopeType: "global",
    tokenLimit: 100000,
  });

  assert.equal(created.apiKeyId, API_KEY);
  assert.equal(created.scopeType, "global");
  assert.equal(created.scopeValue, "");
  assert.equal(created.tokenLimit, 100000);
  assert.equal(created.resetInterval, "monthly");
  assert.equal(created.resetTime, "00:00");
  assert.equal(created.enabled, true);
});

serialTest("upsertTokenLimit normalizes an invalid scopeType to 'global'", async () => {
  const created = await tokenLimitsDb.upsertTokenLimit({
    apiKeyId: API_KEY,
    scopeType: "bogus" as any,
    tokenLimit: 500,
  });
  assert.equal(created.scopeType, "global");
});

serialTest("upsertTokenLimit normalizes an invalid resetInterval to 'monthly'", async () => {
  const created = await tokenLimitsDb.upsertTokenLimit({
    apiKeyId: API_KEY,
    scopeType: "global",
    tokenLimit: 500,
    resetInterval: "yearly" as any,
  });
  assert.equal(created.resetInterval, "monthly");
});

serialTest("upsertTokenLimit floors fractional token limits", async () => {
  const created = await tokenLimitsDb.upsertTokenLimit({
    apiKeyId: API_KEY,
    scopeType: "global",
    tokenLimit: 1500.9,
  });
  assert.equal(created.tokenLimit, 1500);
});

serialTest("upsertTokenLimit on the same scope updates rather than duplicating", async () => {
  await tokenLimitsDb.upsertTokenLimit({
    apiKeyId: API_KEY,
    scopeType: "model",
    scopeValue: "gpt-4o",
    tokenLimit: 1000,
  });
  await tokenLimitsDb.upsertTokenLimit({
    apiKeyId: API_KEY,
    scopeType: "model",
    scopeValue: "gpt-4o",
    tokenLimit: 2000,
  });

  const all = await tokenLimitsDb.listTokenLimits(API_KEY);
  const modelLimits = all.filter((l) => l.scopeType === "model" && l.scopeValue === "gpt-4o");
  assert.equal(modelLimits.length, 1);
  assert.equal(modelLimits[0].tokenLimit, 2000);
});

serialTest("upsertTokenLimit respects enabled: false", async () => {
  const created = await tokenLimitsDb.upsertTokenLimit({
    apiKeyId: API_KEY,
    scopeType: "provider",
    scopeValue: "openai",
    tokenLimit: 5000,
    enabled: false,
  });
  assert.equal(created.enabled, false);
});

serialTest("listTokenLimits orders model, then provider, then global", async () => {
  await tokenLimitsDb.upsertTokenLimit({ apiKeyId: API_KEY, scopeType: "global", tokenLimit: 1 });
  await tokenLimitsDb.upsertTokenLimit({
    apiKeyId: API_KEY,
    scopeType: "provider",
    scopeValue: "openai",
    tokenLimit: 2,
  });
  await tokenLimitsDb.upsertTokenLimit({
    apiKeyId: API_KEY,
    scopeType: "model",
    scopeValue: "gpt-4o",
    tokenLimit: 3,
  });

  const all = await tokenLimitsDb.listTokenLimits(API_KEY);
  assert.equal(all.length, 3);
  assert.equal(all[0].scopeType, "model");
  assert.equal(all[1].scopeType, "provider");
  assert.equal(all[2].scopeType, "global");
});

serialTest("getTokenLimitsForRequest matches global, model, and provider scopes", async () => {
  await tokenLimitsDb.upsertTokenLimit({ apiKeyId: API_KEY, scopeType: "global", tokenLimit: 1 });
  await tokenLimitsDb.upsertTokenLimit({
    apiKeyId: API_KEY,
    scopeType: "model",
    scopeValue: "gpt-4o",
    tokenLimit: 2,
  });
  await tokenLimitsDb.upsertTokenLimit({
    apiKeyId: API_KEY,
    scopeType: "provider",
    scopeValue: "openai",
    tokenLimit: 3,
  });
  await tokenLimitsDb.upsertTokenLimit({
    apiKeyId: API_KEY,
    scopeType: "model",
    scopeValue: "claude-3",
    tokenLimit: 4,
  });

  const matched = await tokenLimitsDb.getTokenLimitsForRequest(API_KEY, "openai", "gpt-4o");
  const scopeValues = matched.map((l) => `${l.scopeType}:${l.scopeValue}`).sort();
  assert.deepEqual(scopeValues, ["global:", "model:gpt-4o", "provider:openai"]);
});

serialTest("getTokenLimitsForRequest excludes disabled limits", async () => {
  await tokenLimitsDb.upsertTokenLimit({
    apiKeyId: API_KEY,
    scopeType: "global",
    tokenLimit: 1,
    enabled: false,
  });

  const matched = await tokenLimitsDb.getTokenLimitsForRequest(API_KEY, "openai", "gpt-4o");
  assert.equal(matched.length, 0);
});

serialTest("deleteTokenLimit removes the limit and reports success", async () => {
  const created = await tokenLimitsDb.upsertTokenLimit({
    apiKeyId: API_KEY,
    scopeType: "global",
    tokenLimit: 1,
  });

  const deleted = await tokenLimitsDb.deleteTokenLimit(created.id);
  assert.equal(deleted, true);

  const all = await tokenLimitsDb.listTokenLimits(API_KEY);
  assert.equal(all.length, 0);
});

serialTest("deleteTokenLimit returns false for a nonexistent id", async () => {
  const deleted = await tokenLimitsDb.deleteTokenLimit("00000000-0000-0000-0000-000000000000");
  assert.equal(deleted, false);
});

serialTest("resetWindowIfElapsed derives a stable window for a fixed 'now'", async () => {
  const limit = {
    id: "x",
    apiKeyId: API_KEY,
    scopeType: "global" as const,
    scopeValue: "",
    tokenLimit: 1000,
    resetInterval: "daily" as const,
    resetTime: "00:00",
    enabled: true,
    createdAt: "",
    updatedAt: "",
  };
  const now = new Date("2026-06-15T12:00:00.000Z").getTime();
  const window = tokenLimitsDb.resetWindowIfElapsed(limit, now);
  assert.equal(typeof window.windowStart, "string");
  assert.ok(window.periodStartAt <= now);
  assert.ok(window.nextResetAt > now);
});

serialTest("incrementWindowTokens accumulates usage within the same window and getWindowUsage reflects it", async () => {
  const created = await tokenLimitsDb.upsertTokenLimit({
    apiKeyId: API_KEY,
    scopeType: "global",
    tokenLimit: 100000,
    resetInterval: "daily",
  });

  const now = Date.now();
  const { windowStart } = tokenLimitsDb.resetWindowIfElapsed(created, now);

  const afterFirst = await tokenLimitsDb.incrementWindowTokens(created.id, windowStart, 500);
  assert.equal(afterFirst, 500);

  const afterSecond = await tokenLimitsDb.incrementWindowTokens(created.id, windowStart, 250);
  assert.equal(afterSecond, 750);

  const usage = await tokenLimitsDb.getWindowUsage(created, now);
  assert.equal(usage, 750);
});

serialTest("incrementWindowTokens floors negative/fractional deltas at 0", async () => {
  const created = await tokenLimitsDb.upsertTokenLimit({
    apiKeyId: API_KEY,
    scopeType: "global",
    tokenLimit: 100000,
  });
  const { windowStart } = tokenLimitsDb.resetWindowIfElapsed(created);

  const result = await tokenLimitsDb.incrementWindowTokens(created.id, windowStart, -50);
  assert.equal(result, 0);
});

serialTest("getWindowUsage returns 0 for a window with no recorded usage", async () => {
  const created = await tokenLimitsDb.upsertTokenLimit({
    apiKeyId: API_KEY,
    scopeType: "global",
    tokenLimit: 1000,
  });
  const usage = await tokenLimitsDb.getWindowUsage(created);
  assert.equal(usage, 0);
});

serialTest("logTokenLimitReset writes a reset-log row without throwing", async () => {
  const created = await tokenLimitsDb.upsertTokenLimit({
    apiKeyId: API_KEY,
    scopeType: "global",
    tokenLimit: 1000,
  });
  await assert.doesNotReject(
    tokenLimitsDb.logTokenLimitReset(created.id, 999, String(Date.now()))
  );
});

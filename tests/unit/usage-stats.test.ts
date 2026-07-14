import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-usage-stats-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const pgModule = await import("../../src/lib/db/postgres.ts");
const usageHistory = await import("../../src/lib/usage/usageHistory.ts");
const usageStats = await import("../../src/lib/usage/usageStats.ts");

const RUN_PREFIX = `usage-stats-${process.pid}`;

function serialTest(name: string, fn: () => Promise<void>) {
  test(name, { concurrency: false }, fn);
}

async function resetStorage() {
  const schema = pgModule.getSchema();
  await pgModule.query(`DELETE FROM ${schema}.usage_history WHERE api_key_id LIKE $1`, [
    `${RUN_PREFIX}-%`,
  ]);
  core.resetDbInstance();
  usageHistory.clearPendingRequests();
}

async function seedUsageEntry({
  provider,
  model,
  connectionId,
  apiKeyId,
  apiKeyName,
  tokensInput = 0,
  tokensOutput = 0,
  minutesAgo = 0,
  success = true,
}: {
  provider: string;
  model: string;
  connectionId?: string;
  apiKeyId?: string;
  apiKeyName?: string;
  tokensInput?: number;
  tokensOutput?: number;
  minutesAgo?: number;
  success?: boolean;
}) {
  await usageHistory.saveRequestUsage({
    provider,
    model,
    connectionId: connectionId ?? null,
    apiKeyId: apiKeyId ?? `${RUN_PREFIX}-default-key`,
    apiKeyName: apiKeyName ?? "default key",
    tokens: { input: tokensInput, output: tokensOutput },
    success,
    latencyMs: 100,
    timestamp: new Date(Date.now() - minutesAgo * 60 * 1000).toISOString(),
  });
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  await resetStorage();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

serialTest("getUsageStats returns zeroed totals when there is no usage history", async () => {
  const stats = await usageStats.getUsageStats();
  assert.equal(typeof stats.totalRequests, "number");
  assert.equal(typeof stats.totalPromptTokens, "number");
  assert.equal(typeof stats.totalCompletionTokens, "number");
  assert.equal(typeof stats.totalCost, "number");
  assert.ok(Array.isArray(stats.last10Minutes));
  assert.equal(stats.last10Minutes.length, 10);
});

serialTest("getUsageStats aggregates totalRequests/totalPromptTokens/totalCompletionTokens across entries", async () => {
  await seedUsageEntry({
    provider: `${RUN_PREFIX}-openai`,
    model: `${RUN_PREFIX}-gpt-4o`,
    apiKeyId: `${RUN_PREFIX}-k1`,
    tokensInput: 100,
    tokensOutput: 50,
  });
  await seedUsageEntry({
    provider: `${RUN_PREFIX}-openai`,
    model: `${RUN_PREFIX}-gpt-4o`,
    apiKeyId: `${RUN_PREFIX}-k1`,
    tokensInput: 200,
    tokensOutput: 75,
  });

  const stats = await usageStats.getUsageStats();
  const modelKey = `${RUN_PREFIX}-gpt-4o (${RUN_PREFIX}-openai)`;
  const modelStats = stats.byModel[modelKey];
  assert.ok(modelStats, `expected byModel entry for ${modelKey}`);
  assert.equal(modelStats.requests, 2);
  assert.equal(modelStats.promptTokens, 300);
  assert.equal(modelStats.completionTokens, 125);
});

serialTest("getUsageStats groups usage by provider across multiple models", async () => {
  await seedUsageEntry({
    provider: `${RUN_PREFIX}-shared-provider`,
    model: `${RUN_PREFIX}-model-a`,
    apiKeyId: `${RUN_PREFIX}-k2`,
    tokensInput: 10,
    tokensOutput: 5,
  });
  await seedUsageEntry({
    provider: `${RUN_PREFIX}-shared-provider`,
    model: `${RUN_PREFIX}-model-b`,
    apiKeyId: `${RUN_PREFIX}-k2`,
    tokensInput: 20,
    tokensOutput: 10,
  });

  const stats = await usageStats.getUsageStats();
  const providerStats = stats.byProvider[`${RUN_PREFIX}-shared-provider`];
  assert.ok(providerStats);
  assert.equal(providerStats.requests, 2);
  assert.equal(providerStats.promptTokens, 30);
  assert.equal(providerStats.completionTokens, 15);
});

serialTest("getUsageStats groups usage by connectionId (account) with a display name", async () => {
  await seedUsageEntry({
    provider: `${RUN_PREFIX}-acct-provider`,
    model: `${RUN_PREFIX}-acct-model`,
    connectionId: `${RUN_PREFIX}-conn-1`,
    apiKeyId: `${RUN_PREFIX}-k3`,
    tokensInput: 15,
    tokensOutput: 5,
  });

  const stats = await usageStats.getUsageStats();
  const accountEntries = Object.values(stats.byAccount).filter(
    (entry) => entry.connectionId === `${RUN_PREFIX}-conn-1`
  );
  assert.equal(accountEntries.length, 1);
  assert.equal(accountEntries[0].requests, 1);
  assert.ok(accountEntries[0].accountName);
});

serialTest("getUsageStats does not create a byAccount entry for requests with no connectionId", async () => {
  await seedUsageEntry({
    provider: `${RUN_PREFIX}-no-conn-provider`,
    model: `${RUN_PREFIX}-no-conn-model`,
    apiKeyId: `${RUN_PREFIX}-k4`,
    tokensInput: 5,
    tokensOutput: 5,
  });

  const stats = await usageStats.getUsageStats();
  const hasEntry = Object.values(stats.byAccount).some(
    (entry) => entry.rawModel === `${RUN_PREFIX}-no-conn-model`
  );
  assert.equal(hasEntry, false);
});

serialTest("getUsageStats groups usage by apiKeyId and tracks historical apiKeyNames", async () => {
  await seedUsageEntry({
    provider: `${RUN_PREFIX}-key-provider`,
    model: `${RUN_PREFIX}-key-model`,
    apiKeyId: `${RUN_PREFIX}-key-x`,
    apiKeyName: "First Name",
    tokensInput: 1,
    tokensOutput: 1,
  });
  await seedUsageEntry({
    provider: `${RUN_PREFIX}-key-provider`,
    model: `${RUN_PREFIX}-key-model`,
    apiKeyId: `${RUN_PREFIX}-key-x`,
    apiKeyName: "Renamed",
    tokensInput: 2,
    tokensOutput: 2,
  });

  const stats = await usageStats.getUsageStats();
  const keyStats = stats.byApiKey[`id:${RUN_PREFIX}-key-x`];
  assert.ok(keyStats, "expected byApiKey entry keyed by id:<apiKeyId>");
  assert.equal(keyStats.requests, 2);
  assert.ok(keyStats.historicalApiKeyNames?.includes("First Name"));
  assert.ok(keyStats.historicalApiKeyNames?.includes("Renamed"));
});

serialTest("getUsageStats falls back to a name-based key when apiKeyId is absent but apiKeyName is present", async () => {
  await usageHistory.saveRequestUsage({
    provider: `${RUN_PREFIX}-name-only-provider`,
    model: `${RUN_PREFIX}-name-only-model`,
    connectionId: null,
    apiKeyId: null,
    apiKeyName: `${RUN_PREFIX}-legacy-key-name`,
    tokens: { input: 1, output: 1 },
    success: true,
    latencyMs: 50,
    timestamp: new Date().toISOString(),
  });

  const stats = await usageStats.getUsageStats();
  const keyStats = stats.byApiKey[`name:${RUN_PREFIX}-legacy-key-name`];
  assert.ok(keyStats, "expected byApiKey entry keyed by name:<apiKeyName>");
  assert.equal(keyStats.requests, 1);
});

serialTest("getUsageStats includes counted requests from the last 10 minutes in last10Minutes buckets", async () => {
  await seedUsageEntry({
    provider: `${RUN_PREFIX}-recent-provider`,
    model: `${RUN_PREFIX}-recent-model`,
    apiKeyId: `${RUN_PREFIX}-k5`,
    tokensInput: 7,
    tokensOutput: 3,
    minutesAgo: 1,
  });

  const stats = await usageStats.getUsageStats();
  const totalRecentRequests = stats.last10Minutes.reduce((sum, bucket) => sum + bucket.requests, 0);
  assert.ok(totalRecentRequests >= 1, "expected at least 1 request counted in the last10Minutes buckets");
});

serialTest("getUsageStats returns exactly 10 fixed-size minute buckets regardless of data volume", async () => {
  const stats = await usageStats.getUsageStats();
  assert.equal(stats.last10Minutes.length, 10);
  for (const bucket of stats.last10Minutes) {
    assert.equal(typeof bucket.requests, "number");
    assert.equal(typeof bucket.promptTokens, "number");
    assert.equal(typeof bucket.completionTokens, "number");
    assert.equal(typeof bucket.cost, "number");
  }
});

serialTest("getUsageStats surfaces pending (in-flight) requests via the pending field", async () => {
  usageHistory.clearPendingRequests();
  const pending = usageHistory.getPendingRequests();
  const stats = await usageStats.getUsageStats();
  assert.deepEqual(stats.pending, pending);
});

serialTest("getUsageStats returns an empty activeRequests array when no requests are pending", async () => {
  usageHistory.clearPendingRequests();
  const stats = await usageStats.getUsageStats();
  assert.deepEqual(stats.activeRequests, []);
});

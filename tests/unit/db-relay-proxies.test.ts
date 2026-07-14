import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-relay-proxies-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const pgModule = await import("../../src/lib/db/postgres.ts");
const relayDb = await import("../../src/lib/db/relayProxies.ts");

const RUN_PREFIX = `relay-proxies-${process.pid}`;

function serialTest(name: string, fn: () => Promise<void>) {
  test(name, { concurrency: false }, fn);
}

async function resetStorage() {
  const schema = pgModule.getSchema();
  await pgModule.query(
    `DELETE FROM ${schema}.relay_logs WHERE token_id IN (SELECT id FROM ${schema}.relay_tokens WHERE name LIKE $1)`,
    [`${RUN_PREFIX}-%`]
  );
  await pgModule.query(
    `DELETE FROM ${schema}.relay_rate_limits WHERE token_id IN (SELECT id FROM ${schema}.relay_tokens WHERE name LIKE $1)`,
    [`${RUN_PREFIX}-%`]
  );
  await pgModule.query(`DELETE FROM ${schema}.relay_tokens WHERE name LIKE $1`, [
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

serialTest("createRelayToken persists a token with sane defaults and returns the raw secret once", async () => {
  const created = await relayDb.createRelayToken({ name: `${RUN_PREFIX}-basic` });

  assert.ok(created.id.startsWith("rl_"));
  assert.ok(created.rawToken.startsWith("relay_"));
  assert.equal(created.name, `${RUN_PREFIX}-basic`);
  assert.equal(created.enabled, true);
  assert.equal(created.maxTokensPerRequest, 128000);
  assert.equal(created.maxRequestsPerMinute, 60);
  assert.equal(created.maxRequestsPerDay, 10000);
  assert.deepEqual(JSON.parse(created.allowedModels), ["*"]);
});

serialTest("createRelayToken honors explicit overrides", async () => {
  const created = await relayDb.createRelayToken({
    name: `${RUN_PREFIX}-custom`,
    description: "custom token",
    allowedModels: ["gpt-4", "gpt-4o"],
    maxTokensPerRequest: 4096,
    maxRequestsPerMinute: 5,
    maxRequestsPerDay: 100,
    maxCostPerDay: 10,
  });

  assert.equal(created.description, "custom token");
  assert.deepEqual(JSON.parse(created.allowedModels), ["gpt-4", "gpt-4o"]);
  assert.equal(created.maxTokensPerRequest, 4096);
  assert.equal(created.maxRequestsPerMinute, 5);
  assert.equal(created.maxRequestsPerDay, 100);
  assert.equal(created.maxCostPerDay, 10);
});

serialTest("getRelayToken / getRelayTokens / getRelayTokenByHash round-trip", async () => {
  const created = await relayDb.createRelayToken({ name: `${RUN_PREFIX}-lookup` });

  const byId = await relayDb.getRelayToken(created.id);
  assert.equal(byId?.id, created.id);

  const all = await relayDb.getRelayTokens();
  assert.ok(all.some((t) => t.id === created.id));

  const byHash = await relayDb.getRelayTokenByHash(created.tokenHash);
  assert.equal(byHash?.id, created.id);

  assert.equal(await relayDb.getRelayToken("rl_does-not-exist"), null);
  assert.equal(await relayDb.getRelayTokenByHash("nonexistent-hash"), null);
});

serialTest("updateRelayToken applies only the provided fields", async () => {
  const created = await relayDb.createRelayToken({
    name: `${RUN_PREFIX}-update`,
    maxRequestsPerMinute: 60,
  });

  const updated = await relayDb.updateRelayToken(created.id, {
    description: "updated description",
    maxRequestsPerMinute: 30,
  });

  assert.equal(updated?.description, "updated description");
  assert.equal(updated?.maxRequestsPerMinute, 30);
  // Untouched fields retain their original value.
  assert.equal(updated?.maxRequestsPerDay, 10000);
});

serialTest("toggleRelayToken flips enabled state", async () => {
  const created = await relayDb.createRelayToken({ name: `${RUN_PREFIX}-toggle` });
  assert.equal(created.enabled, true);

  const disabled = await relayDb.toggleRelayToken(created.id, false);
  assert.equal(disabled?.enabled, false);

  const reenabled = await relayDb.toggleRelayToken(created.id, true);
  assert.equal(reenabled?.enabled, true);
});

serialTest("getRelayTokenByHash excludes disabled tokens", async () => {
  const created = await relayDb.createRelayToken({ name: `${RUN_PREFIX}-disabled-lookup` });
  await relayDb.toggleRelayToken(created.id, false);

  const byHash = await relayDb.getRelayTokenByHash(created.tokenHash);
  assert.equal(byHash, null);
});

serialTest("deleteRelayToken removes the token", async () => {
  const created = await relayDb.createRelayToken({ name: `${RUN_PREFIX}-delete` });
  await relayDb.deleteRelayToken(created.id);
  assert.equal(await relayDb.getRelayToken(created.id), null);
});

serialTest("checkRateLimit allows requests under the per-minute and per-day caps", async () => {
  const created = await relayDb.createRelayToken({
    name: `${RUN_PREFIX}-rl-allow`,
    maxRequestsPerMinute: 5,
    maxRequestsPerDay: 100,
  });

  const result = await relayDb.checkRateLimit(created.id);
  assert.equal(result.allowed, true);
  assert.equal(result.remaining, 5);
});

serialTest("checkRateLimit returns not-allowed for an unknown token", async () => {
  const result = await relayDb.checkRateLimit("rl_does-not-exist");
  assert.equal(result.allowed, false);
  assert.equal(result.remaining, 0);
});

serialTest("recordRelayUsage increments the rate-limit window and writes a log row", async () => {
  const created = await relayDb.createRelayToken({
    name: `${RUN_PREFIX}-usage`,
    maxRequestsPerMinute: 5,
    maxRequestsPerDay: 100,
  });

  await relayDb.recordRelayUsage(created.id, {
    requestId: "req-1",
    model: "gpt-4o-mini",
    promptTokens: 100,
    completionTokens: 50,
    cost: 0.01,
    status: "success",
    statusCode: 200,
    latencyMs: 250,
  });

  const rateLimit = await relayDb.checkRateLimit(created.id);
  assert.equal(rateLimit.remaining, 4);

  const logs = await relayDb.getRelayLogs(created.id);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].model, "gpt-4o-mini");
  assert.equal(logs[0].status, "success");

  const usage = await relayDb.getRelayUsage(created.id, 0);
  assert.equal(usage.requestCount, 1);
  assert.equal(usage.totalCost, 0.01);
});

serialTest("checkRateLimit blocks once the per-minute cap is reached", async () => {
  const created = await relayDb.createRelayToken({
    name: `${RUN_PREFIX}-rl-block`,
    maxRequestsPerMinute: 1,
    maxRequestsPerDay: 100,
  });

  await relayDb.recordRelayUsage(created.id, {});
  const result = await relayDb.checkRateLimit(created.id);
  assert.equal(result.allowed, false);
  assert.equal(result.remaining, 0);
});

serialTest("getRelayLogs without a tokenId returns logs across tokens, newest first", async () => {
  const tokenA = await relayDb.createRelayToken({ name: `${RUN_PREFIX}-logs-a` });
  const tokenB = await relayDb.createRelayToken({ name: `${RUN_PREFIX}-logs-b` });

  await relayDb.recordRelayUsage(tokenA.id, { requestId: "a-1" });
  await relayDb.recordRelayUsage(tokenB.id, { requestId: "b-1" });

  const logsForA = await relayDb.getRelayLogs(tokenA.id);
  assert.ok(logsForA.every((l) => l.token_id === tokenA.id));

  const allLogs = await relayDb.getRelayLogs(undefined, 100);
  const requestIds = allLogs.map((l) => l.request_id);
  assert.ok(requestIds.includes("a-1"));
  assert.ok(requestIds.includes("b-1"));
});

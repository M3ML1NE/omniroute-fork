import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-token-health-conn-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.OMNIROUTE_HIDE_HEALTHCHECK_LOGS = "1";

const core = await import("../../src/lib/db/core.ts");
const pgModule = await import("../../src/lib/db/postgres.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const tokenHealthCheck = await import("../../src/lib/tokenHealthCheck.ts");

const RUN_PREFIX = `token-health-conn-${process.pid}`;

function serialTest(name: string, fn: () => Promise<void>) {
  test(name, { concurrency: false }, fn);
}

async function resetStorage() {
  const schema = pgModule.getSchema();
  await pgModule.query(`DELETE FROM ${schema}.provider_connections WHERE name LIKE $1`, [
    `${RUN_PREFIX}-%`,
  ]);
  core.resetDbInstance();
}

test.beforeEach(async () => {
  await resetStorage();
  tokenHealthCheck.stopTokenHealthCheck();
});

test.after(async () => {
  await resetStorage();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function uniqueName(suffix: string): string {
  return `${RUN_PREFIX}-${suffix}-${Math.random().toString(16).slice(2, 8)}`;
}

async function createOAuthConnection(overrides: Record<string, unknown> = {}) {
  return providersDb.createProviderConnection({
    provider: "openai-compatible",
    authType: "oauth",
    name: uniqueName("conn"),
    refreshToken: "refresh-token-value",
    accessToken: "access-token-value",
    isActive: true,
    ...overrides,
  });
}

serialTest("checkConnection is a no-op for a connection with no id", async () => {
  await assert.doesNotReject(tokenHealthCheck.checkConnection({}));
});

serialTest("checkConnection returns early when healthCheckInterval is 0 (disabled)", async () => {
  // healthCheckInterval isn't in createProviderConnection's optionalFields
  // allowlist (only settable post-creation, mirroring the dashboard's PATCH
  // route), so it must be applied via updateProviderConnection here.
  const created = await createOAuthConnection();
  assert.ok(created);
  const withIntervalDisabled = await providersDb.updateProviderConnection(
    (created as any).id,
    { healthCheckInterval: 0 }
  );
  assert.equal((withIntervalDisabled as any).healthCheckInterval, 0);
  const before = await providersDb.getProviderConnectionById((created as any).id);

  await tokenHealthCheck.checkConnection(withIntervalDisabled);

  const after = await providersDb.getProviderConnectionById((created as any).id);
  assert.equal((after as any).lastHealthCheckAt, (before as any).lastHealthCheckAt);
});

serialTest("checkConnection returns early for an inactive connection", async () => {
  const created = await createOAuthConnection({ isActive: false });
  assert.ok(created);
  const before = await providersDb.getProviderConnectionById((created as any).id);

  await tokenHealthCheck.checkConnection(created);

  const after = await providersDb.getProviderConnectionById((created as any).id);
  assert.equal((after as any).lastHealthCheckAt, (before as any).lastHealthCheckAt);
});

serialTest("checkConnection returns early when there is no refreshToken", async () => {
  const created = await providersDb.createProviderConnection({
    provider: "openai-compatible",
    authType: "oauth",
    name: uniqueName("no-refresh"),
    accessToken: "access-token-value",
    isActive: true,
  });
  assert.ok(created);
  const before = await providersDb.getProviderConnectionById((created as any).id);

  await tokenHealthCheck.checkConnection(created);

  const after = await providersDb.getProviderConnectionById((created as any).id);
  assert.equal((after as any).lastHealthCheckAt, (before as any).lastHealthCheckAt);
});

serialTest("checkConnection marks lastHealthCheckAt and does not throw for a provider with unsupported refresh", async () => {
  // "openai-compatible" is not in tokenRefresh's supportsTokenRefresh() allowlist
  // and has no refreshUrl/tokenUrl in the provider registry, so this exercises
  // the "Skipping ... refresh unsupported" branch without any network call.
  const created = await createOAuthConnection();
  assert.ok(created);

  await tokenHealthCheck.checkConnection(created);

  const after = await providersDb.getProviderConnectionById((created as any).id);
  assert.ok((after as any).lastHealthCheckAt);
});

serialTest("checkConnection skips an expired connection that has exhausted its retry budget", async () => {
  // EXPIRED_RETRY_MAX is 3 — a connection already at that count must be
  // skipped entirely (no lastHealthCheckAt update, no network call).
  const created = await createOAuthConnection({
    provider: "claude",
    testStatus: "expired",
  });
  assert.ok(created);
  const withMaxRetries = await providersDb.updateProviderConnection((created as any).id, {
    expiredRetryCount: 3,
  });
  assert.equal((withMaxRetries as any).expiredRetryCount, 3);
  const before = await providersDb.getProviderConnectionById((created as any).id);

  await tokenHealthCheck.checkConnection(withMaxRetries);

  const after = await providersDb.getProviderConnectionById((created as any).id);
  assert.equal((after as any).lastHealthCheckAt, (before as any).lastHealthCheckAt);
});

serialTest("checkConnection skips an expired connection still inside its backoff window", async () => {
  // retryCount=1 means the backoff window is EXPIRED_RETRY_BACKOFF_MIN * 2^1
  // = 10 minutes from expiredRetryAt — "just now" is well inside that window.
  const created = await createOAuthConnection({
    provider: "claude",
    testStatus: "expired",
  });
  assert.ok(created);
  const withRecentRetry = await providersDb.updateProviderConnection((created as any).id, {
    expiredRetryCount: 1,
    expiredRetryAt: new Date().toISOString(),
  });
  assert.equal((withRecentRetry as any).expiredRetryCount, 1);
  const before = await providersDb.getProviderConnectionById((created as any).id);

  await tokenHealthCheck.checkConnection(withRecentRetry);

  const after = await providersDb.getProviderConnectionById((created as any).id);
  assert.equal((after as any).lastHealthCheckAt, (before as any).lastHealthCheckAt);
});

serialTest("buildRefreshFailureUpdate output round-trips through updateProviderConnection", async () => {
  const created = await createOAuthConnection();
  assert.ok(created);
  const connectionId = (created as any).id;

  const now = new Date().toISOString();
  const update = tokenHealthCheck.buildRefreshFailureUpdate(created, now);
  const updated = await providersDb.updateProviderConnection(connectionId, update);
  assert.ok(updated);
  assert.equal((updated as any).testStatus, "active");
  assert.equal((updated as any).lastError, "Health check: token refresh failed");
  assert.equal((updated as any).errorCode, "refresh_failed");
});

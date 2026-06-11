import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-sse-auth-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "sse-auth-test-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const readCacheDb = await import("../../src/lib/db/readCache.ts");
const pgModule = await import("../../src/lib/db/postgres.ts");
const auth = await import("../../src/sse/services/auth.ts");

const MUTABLE_TEST_TABLES = [
  "provider_connections",
  "api_keys",
  "key_value",
  "session_account_affinity",
];

async function purgePostgresTables() {
  const schema = pgModule.getSchema();
  const tables = MUTABLE_TEST_TABLES.map((table) => `${schema}.${table}`).join(", ");
  await pgModule.query(`TRUNCATE ${tables} CASCADE`);
}

async function resetStorage() {
  await purgePostgresTables();
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  readCacheDb.invalidateDbCache();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

function futureMs(ms = 60_000) {
  return Date.now() + ms;
}

async function seedConnection(provider: string, overrides: any = {}) {
  return providersDb.createProviderConnection({
    provider,
    authType: overrides.authType || "apikey",
    name: overrides.name || `${provider}-${Math.random().toString(16).slice(2, 8)}`,
    email: overrides.email,
    apiKey: overrides.apiKey || "sk-test",
    accessToken: overrides.accessToken,
    refreshToken: overrides.refreshToken,
    isActive: overrides.isActive ?? true,
    testStatus: overrides.testStatus || "active",
    priority: overrides.priority,
    rateLimitedUntil: overrides.rateLimitedUntil,
    lastError: overrides.lastError,
    lastErrorType: overrides.lastErrorType,
    lastErrorSource: overrides.lastErrorSource,
    errorCode: overrides.errorCode,
    backoffLevel: overrides.backoffLevel,
    providerSpecificData: overrides.providerSpecificData || {},
    lastUsedAt: overrides.lastUsedAt,
    consecutiveUseCount: overrides.consecutiveUseCount,
  });
}

function msUntil(timestamp) {
  return new Date(timestamp).getTime() - Date.now();
}

async function flushWrites() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("extractApiKey parses bearer headers and isValidApiKey validates persisted keys", async () => {
  const created = await apiKeysDb.createApiKey("auth-check", "machine-auth-check");

  const request = new Request("http://localhost/v1/chat/completions", {
    headers: { Authorization: `Bearer ${created.key}` },
  });

  assert.equal(auth.extractApiKey(request), created.key);
  assert.equal(
    auth.extractApiKey(
      new Request("http://localhost/v1/chat/completions", {
        headers: { Authorization: "Basic abc123" },
      })
    ),
    null
  );
  assert.equal(await auth.isValidApiKey(created.key), true);
  assert.equal(await auth.isValidApiKey("sk-missing"), false);
  assert.equal(await auth.isValidApiKey(""), false);
});

test("getProviderCredentials reports rate limiting when only inactive suppressed records remain", async () => {
  const retryAfter = futureMs();
  await seedConnection("openai", {
    name: "inactive-rate-limited",
    isActive: false,
    rateLimitedUntil: retryAfter,
  });

  const result = await auth.getProviderCredentials("openai");

  assert.equal(result.allRateLimited, true);
  assert.equal(new Date(result.retryAfter).getTime(), retryAfter);
  assert.match(String(result.retryAfterHuman), /reset after/i);
});

test("getProviderCredentials returns last error metadata when active accounts are all rate limited", async () => {
  const retryAfter = futureMs();
  await seedConnection("openai", {
    name: "active-rate-limited",
    rateLimitedUntil: retryAfter,
    lastError: "provider rate limit",
    errorCode: 429,
  });

  const result = await auth.getProviderCredentials("openai");

  assert.equal(result.allRateLimited, true);
  assert.equal(new Date(result.retryAfter).getTime(), retryAfter);
  assert.equal(Number(result.lastErrorCode), 429);
  assert.equal(result.lastError, "provider rate limit");
});

test("getProviderCredentials round-robin stays on the current account while below the sticky limit", async () => {
  await settingsDb.updateSettings({
    fallbackStrategy: "round-robin",
    stickyRoundRobinLimit: 3,
  });
  const current = await seedConnection("openai", {
    name: "round-robin-current",
    priority: 1,
  });
  const other = await seedConnection("openai", {
    name: "round-robin-other",
    priority: 2,
  });

  await providersDb.updateProviderConnection(current.id, {
    lastUsedAt: new Date().toISOString(),
    consecutiveUseCount: 1,
  });
  await providersDb.updateProviderConnection(other.id, {
    lastUsedAt: Date.now() - 60_000,
    consecutiveUseCount: 0,
  });

  const selected = await auth.getProviderCredentials("openai");
  const updated = await providersDb.getProviderConnectionById(current.id);

  assert.equal(selected.connectionId, current.id);
  assert.equal(updated.consecutiveUseCount, 2);
});

test("getProviderCredentials returns null when only inactive non-rate-limited records remain", async () => {
  await seedConnection("openai", {
    name: "inactive-no-limit",
    isActive: false,
    testStatus: "active",
  });

  const result = await auth.getProviderCredentials("openai");

  assert.equal(result, null);
});

test("getProviderCredentials honors allowedConnections filters", async () => {
  const skipped = await seedConnection("openai", {
    name: "allowed-skip",
    apiKey: "sk-skip",
  });
  const selectedConn = await seedConnection("openai", {
    name: "allowed-select",
    apiKey: "sk-selected",
  });

  const selected = await auth.getProviderCredentials("openai", null, [(selectedConn as any).id]);

  assert.equal(selected.connectionId, selectedConn.id);
  assert.equal(selected.apiKey, "sk-selected");
  assert.notEqual(selected.connectionId, skipped.id);
});

test("getProviderCredentials honors forcedConnectionId even when another account is preferred", async () => {
  await seedConnection("openai", {
    name: "forced-default",
    priority: 1,
    apiKey: "sk-default",
  });
  const forcedConn = await seedConnection("openai", {
    name: "forced-target",
    priority: 99,
    apiKey: "sk-forced",
  });

  const selected = await auth.getProviderCredentials("openai", null, null, null, {
    forcedConnectionId: (forcedConn as any).id,
  });

  assert.equal(selected.connectionId, forcedConn.id);
  assert.equal(selected.apiKey, "sk-forced");
});

test("getProviderCredentials intersects forcedConnectionId with allowedConnections", async () => {
  const allowedConn = await seedConnection("openai", {
    name: "forced-allowed",
    apiKey: "sk-allowed",
  });
  const blockedConn = await seedConnection("openai", {
    name: "forced-blocked",
    apiKey: "sk-blocked",
  });

  const selected = await auth.getProviderCredentials(
    "openai",
    null,
    [(allowedConn as any).id],
    null,
    {
      forcedConnectionId: (blockedConn as any).id,
    }
  );

  assert.equal(selected, null);
});

test("getProviderCredentials retains rate-limited accounts when allowSuppressedConnections is enabled", async () => {
  const connection = await seedConnection("openai", {
    name: "suppressed-rate-limit",
    rateLimitedUntil: futureMs(),
  });

  const blocked = await auth.getProviderCredentials("openai");
  const bypassed = await auth.getProviderCredentials("openai", null, null, null, {
    allowSuppressedConnections: true,
  });

  assert.equal(blocked.allRateLimited, true);
  assert.equal(bypassed.connectionId, connection.id);
});

test("getProviderCredentials retains rate-limited accounts when allowRateLimitedConnections is enabled", async () => {
  const connection = await seedConnection("openai", {
    name: "allow-rate-limit-option",
    rateLimitedUntil: futureMs(),
  });

  const blocked = await auth.getProviderCredentials("openai");
  const bypassed = await auth.getProviderCredentials("openai", null, null, null, {
    allowRateLimitedConnections: true,
  });

  assert.equal(blocked.allRateLimited, true);
  assert.equal(bypassed.connectionId, connection.id);
});

test("getProviderCredentials retains terminal accounts for combo live tests", async () => {
  const connection = await seedConnection("openai", {
    name: "suppressed-terminal",
    testStatus: "banned",
    backoffLevel: 4,
  });

  const blocked = await auth.getProviderCredentials("openai");
  const bypassed = await auth.getProviderCredentials("openai", null, null, null, {
    allowSuppressedConnections: true,
  });
  const updated = await providersDb.getProviderConnectionById(connection.id);

  assert.equal(blocked, null);
  assert.equal(bypassed.connectionId, connection.id);
  assert.equal(updated.testStatus, "banned");
});

test("getProviderCredentials reports allRateLimited when every account is model-locked", async () => {
  const first = await seedConnection("gemini", {
    name: "gemini-model-lock-first",
  });
  const second = await seedConnection("gemini", {
    name: "gemini-model-lock-second",
  });

  await auth.markAccountUnavailable(first.id, 429, "too many requests", "gemini", "gemini-2.5-pro");
  await auth.markAccountUnavailable(
    second.id,
    429,
    "too many requests",
    "gemini",
    "gemini-2.5-pro"
  );

  const blocked = await auth.getProviderCredentials("gemini", null, null, "gemini-2.5-pro");

  assert.equal(blocked.allRateLimited, true);
  assert.equal(Number(blocked.lastErrorCode), 429);
  assert.ok(typeof blocked.retryAfter === "string" && blocked.retryAfter.length > 0);
  assert.match(String(blocked.retryAfterHuman), /reset after/i);
});

test("getProviderCredentials auto-decays stale backoff metadata for recovered accounts", async () => {
  const connection = await seedConnection("openai", {
    name: "stale-backoff",
    testStatus: "unavailable",
    rateLimitedUntil: Date.now() - 60_000,
    lastError: "old error",
    errorCode: 429,
    backoffLevel: 3,
  });

  const selected = await auth.getProviderCredentials("openai");
  await flushWrites();
  const updated = await providersDb.getProviderConnectionById(connection.id);

  assert.equal(selected.connectionId, connection.id);
  assert.equal(updated.backoffLevel, 0);
});

test("getProviderCredentials round-robin switches to the least recently used account after the sticky limit", async () => {
  await settingsDb.updateSettings({
    fallbackStrategy: "round-robin",
    stickyRoundRobinLimit: 2,
  });
  const current = await seedConnection("openai", {
    name: "round-robin-limit-current",
    priority: 1,
  });
  const fallback = await seedConnection("openai", {
    name: "round-robin-limit-fallback",
    priority: 2,
  });

  await providersDb.updateProviderConnection(current.id, {
    lastUsedAt: new Date().toISOString(),
    consecutiveUseCount: 2,
  });
  await providersDb.updateProviderConnection(fallback.id, {
    lastUsedAt: new Date(Date.now() - 120_000).toISOString(),
    consecutiveUseCount: 0,
  });

  const selected = await auth.getProviderCredentials("openai");
  const updated = await providersDb.getProviderConnectionById(fallback.id);

  assert.equal(selected.connectionId, fallback.id);
  assert.equal(updated.consecutiveUseCount, 1);
});

test("getProviderCredentials round-robin fallback mode excludes the failed account and picks the LRU peer", async () => {
  await settingsDb.updateSettings({
    fallbackStrategy: "round-robin",
    stickyRoundRobinLimit: 2,
  });
  const failed = await seedConnection("openai", {
    name: "round-robin-failed",
    priority: 1,
  });
  const fallback = await seedConnection("openai", {
    name: "round-robin-fallback",
    priority: 2,
  });

  await providersDb.updateProviderConnection(failed.id, {
    lastUsedAt: new Date().toISOString(),
    consecutiveUseCount: 3,
  });
  await providersDb.updateProviderConnection(fallback.id, {
    lastUsedAt: new Date(Date.now() - 120_000).toISOString(),
    consecutiveUseCount: 0,
  });

  const selected = await auth.getProviderCredentials("openai", failed.id);
  const updated = await providersDb.getProviderConnectionById(fallback.id);

  assert.equal(selected.connectionId, fallback.id);
  assert.equal(updated.consecutiveUseCount, 1);
});

for (const strategy of ["random", "p2c", "least-used", "cost-optimized", "strict-random"]) {
  test(`getProviderCredentials supports the ${strategy} selection strategy`, async () => {
    await settingsDb.updateSettings({ fallbackStrategy: strategy });
    const connection = await seedConnection("openai", {
      name: `strategy-${strategy}`,
      priority: 7,
    });

    const selected = await auth.getProviderCredentials("openai");

    assert.equal(selected.connectionId, connection.id);
  });
}

test("getProviderCredentials least-used prefers accounts that were never used", async () => {
  await settingsDb.updateSettings({ fallbackStrategy: "least-used" });
  const recentlyUsed = await seedConnection("openai", {
    name: "least-used-recent",
    priority: 1,
  });
  const neverUsed = await seedConnection("openai", {
    name: "least-used-never",
    priority: 9,
  });
  await providersDb.updateProviderConnection(recentlyUsed.id, {
    lastUsedAt: new Date().toISOString(),
  });
  await providersDb.updateProviderConnection(neverUsed.id, {
    lastUsedAt: null,
  });

  const selected = await auth.getProviderCredentials("openai");

  assert.equal(selected.connectionId, neverUsed.id);
  assert.notEqual(selected.connectionId, recentlyUsed.id);
});

test("getProviderCredentials least-used prefers the oldest timestamp when all accounts were used", async () => {
  await settingsDb.updateSettings({ fallbackStrategy: "least-used" });
  const oldest = await seedConnection("openai", {
    name: "least-used-oldest",
    priority: 9,
  });
  const newest = await seedConnection("openai", {
    name: "least-used-newest",
    priority: 1,
  });

  await providersDb.updateProviderConnection(oldest.id, {
    lastUsedAt: new Date(Date.now() - 120_000).toISOString(),
  });
  await providersDb.updateProviderConnection(newest.id, {
    lastUsedAt: new Date().toISOString(),
  });

  const selected = await auth.getProviderCredentials("openai");

  assert.equal(selected.connectionId, oldest.id);
});

test("getProviderCredentials cost-optimized selects the lowest priority account", async () => {
  await settingsDb.updateSettings({ fallbackStrategy: "cost-optimized" });
  const cheapest = await seedConnection("openai", {
    name: "cost-low",
    priority: 1,
  });
  await seedConnection("openai", {
    name: "cost-high",
    priority: 8,
  });

  const selected = await auth.getProviderCredentials("openai");

  assert.equal(selected.connectionId, cheapest.id);
});

test("getProviderCredentials p2c deprioritizes accounts with recent rate-limit/backoff signals", async () => {
  await settingsDb.updateSettings({ fallbackStrategy: "p2c" });
  await seedConnection("openai", {
    name: "p2c-rate-limited-history",
    priority: 1,
    apiKey: "sk-p2c-rate-limited",
    lastError: "rate limit",
    lastErrorType: "rate_limited",
    errorCode: 429,
    backoffLevel: 3,
  });
  const healthy = await seedConnection("openai", {
    name: "p2c-clean-account",
    priority: 8,
    apiKey: "sk-p2c-clean",
  });

  const selected = await auth.getProviderCredentials("openai");

  assert.equal(selected.connectionId, healthy.id);
});

test("getProviderCredentials resolves the nvidia special alias pool", async () => {
  const connection = await seedConnection("nvidia_nim", {
    name: "nvidia-special-alias",
  });

  const selected = await auth.getProviderCredentials("nvidia");

  assert.equal(selected.connectionId, connection.id);
});

test("markAccountUnavailable uses configured cooldowns for local 404 model lockouts", async () => {
  await settingsDb.updateSettings({
    providerProfiles: {
      apikey: {
        transientCooldown: 250,
        rateLimitCooldown: 125,
        maxBackoffLevel: 3,
        circuitBreakerThreshold: 60,
        circuitBreakerReset: 5000,
      },
    },
  });

  const connection = await seedConnection("openai", {
    name: "local-openai",
    providerSpecificData: {
      baseUrl: "http://127.0.0.1:8080/v1",
    },
  });

  const result = await auth.markAccountUnavailable(
    connection.id,
    404,
    "model not found",
    "openai",
    "local-model"
  );
  const updated = await providersDb.getProviderConnectionById(connection.id);

  assert.equal(result.shouldFallback, true);
  assert.equal(result.cooldownMs, 250);
  assert.equal(updated.testStatus, "active");
  assert.equal(updated.rateLimitedUntil, undefined);
  assert.equal(updated.lastErrorType, "not_found");
  assert.equal(Number(updated.errorCode), 404);
});

test("markAccountUnavailable applies a model-only lockout for Gemini 429 responses", async () => {
  const connection = await seedConnection("gemini", {
    name: "gemini-model-limit",
  });

  const result = await auth.markAccountUnavailable(
    connection.id,
    429,
    "too many requests",
    "gemini",
    "gemini-2.5-pro"
  );
  await flushWrites();
  const updated = await providersDb.getProviderConnectionById(connection.id);

  assert.equal(result.shouldFallback, true);
  assert.ok(result.cooldownMs > 0);
  assert.equal(updated.testStatus, "active");
  assert.equal(updated.rateLimitedUntil, undefined);
  assert.equal(updated.lastErrorType, "rate_limited");
  assert.equal(Number(updated.errorCode), 429);
});

test("markAccountUnavailable applies a model-only lockout for compatible provider 429 responses", async () => {
  const connection = await seedConnection("openai-compatible-custom-node", {
    name: "compatible-model-limit",
  });

  const result = await auth.markAccountUnavailable(
    connection.id,
    429,
    "The upstream compatible service exhausted its capacity",
    "openai-compatible-custom-node",
    "custom-model-a"
  );
  await flushWrites();
  const updated = await providersDb.getProviderConnectionById(connection.id);

  assert.equal(result.shouldFallback, true);
  assert.ok(result.cooldownMs > 0);
  assert.equal(updated.testStatus, "active");
  assert.equal(updated.rateLimitedUntil, undefined);
  assert.equal(updated.lastErrorType, "rate_limited");
  assert.equal(Number(updated.errorCode), 429);
});

test("markAccountUnavailable honors configured api-key rate-limit cooldowns", async () => {
  await settingsDb.updateSettings({
    providerProfiles: {
      apikey: {
        transientCooldown: 125,
        rateLimitCooldown: 125,
        maxBackoffLevel: 3,
        circuitBreakerThreshold: 60,
        circuitBreakerReset: 5000,
      },
    },
  });

  const connection = await seedConnection("openai", {
    name: "configured-rate-limit-cooldown",
  });

  const result = await auth.markAccountUnavailable(
    connection.id,
    429,
    "too many requests",
    "openai",
    "gpt-4o-mini"
  );

  assert.equal(result.shouldFallback, true);
  assert.equal(result.cooldownMs, 125);
});

test("markAccountUnavailable returns without fallback on bad requests", async () => {
  const connection = await seedConnection("openai", {
    name: "bad-request-no-fallback",
  });

  const result = await auth.markAccountUnavailable(
    connection.id,
    400,
    "schema mismatch",
    "openai",
    "gpt-4o"
  );
  const updated = await providersDb.getProviderConnectionById(connection.id);

  assert.deepEqual(result, { shouldFallback: false, cooldownMs: 0 });
  assert.equal(updated.testStatus, "active");
  assert.equal(updated.rateLimitedUntil, undefined);
});

test("markAccountUnavailable preserves terminal statuses without overwriting them", async () => {
  const connection = await seedConnection("openai", {
    name: "terminal-status",
    testStatus: "expired",
    rateLimitedUntil: null,
  });

  const result = await auth.markAccountUnavailable(connection.id, 503, "upstream error", "openai");
  const updated = await providersDb.getProviderConnectionById(connection.id);

  assert.equal(result.shouldFallback, true);
  assert.equal(result.cooldownMs, 0);
  assert.equal(updated.testStatus, "expired");
  assert.equal(updated.rateLimitedUntil, undefined);
});

test("markAccountUnavailable reuses an existing connection-wide cooldown", async () => {
  const retryAfter = futureMs(90_000);
  const connection = await seedConnection("openai", {
    name: "existing-cooldown",
    rateLimitedUntil: retryAfter,
  });

  const result = await auth.markAccountUnavailable(connection.id, 503, "upstream error", "openai");
  const updated = await providersDb.getProviderConnectionById(connection.id);

  assert.equal(result.shouldFallback, true);
  assert.ok(result.cooldownMs > 0);
  assert.equal(Number(updated.rateLimitedUntil), retryAfter);
});

test("markAccountUnavailable uses a connection-wide cooldown for non-local 404 errors", async () => {
  const connection = await seedConnection("openai", {
    name: "remote-404",
    providerSpecificData: {
      baseUrl: "https://api.openai.com/v1",
    },
  });

  const result = await auth.markAccountUnavailable(
    connection.id,
    404,
    "model not found",
    "openai",
    "gpt-missing"
  );
  const updated = await providersDb.getProviderConnectionById(connection.id);

  assert.equal(result.shouldFallback, true);
  assert.ok(result.cooldownMs > 0);
  assert.equal(updated.testStatus, "unavailable");
  assert.ok(updated.rateLimitedUntil);
});

test("markAccountUnavailable auto-disables permanently banned accounts when the setting is enabled", async () => {
  await settingsDb.updateSettings({ autoDisableBannedAccounts: true });
  const connection = await seedConnection("openai", {
    name: "permanent-ban",
  });

  const result = await auth.markAccountUnavailable(
    connection.id,
    401,
    "Verify your account to continue",
    "openai",
    "gpt-4o"
  );
  const updated = await providersDb.getProviderConnectionById(connection.id);

  assert.equal(result.shouldFallback, true);
  assert.equal(updated.isActive, false);
  assert.equal(updated.testStatus, "banned");
});

test("markAccountUnavailable leaves permanently banned accounts active when auto-disable is disabled", async () => {
  await settingsDb.updateSettings({ autoDisableBannedAccounts: false });
  const connection = await seedConnection("openai", {
    name: "permanent-ban-disabled",
  });

  const result = await auth.markAccountUnavailable(
    connection.id,
    401,
    "Verify your account to continue",
    "openai",
    "gpt-4o"
  );
  const updated = await providersDb.getProviderConnectionById(connection.id);

  assert.equal(result.shouldFallback, true);
  assert.equal(updated.isActive, true);
  assert.equal(updated.testStatus, "banned");
});

test("markAccountUnavailable swallows auto-disable persistence errors", async () => {
  await settingsDb.updateSettings({ autoDisableBannedAccounts: true });
  const connection = await seedConnection("openai", {
    name: "permanent-ban-update-fails",
  });

  const db = core.getDbInstance();
  const originalPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const statement = originalPrepare(sql);
    if (!String(sql).includes("UPDATE provider_connections SET")) {
      return statement;
    }

    return new Proxy(statement, {
      get(target, prop, receiver) {
        if (prop === "run") {
          return (params) => {
            if (params && typeof params === "object" && params.isActive === 0) {
              throw new Error("persist disable failed");
            }
            return target.run(params);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  };

  try {
    const result = await auth.markAccountUnavailable(
      connection.id,
      401,
      "Verify your account to continue",
      "openai",
      "gpt-4o"
    );
    const updated = await providersDb.getProviderConnectionById(connection.id);

    assert.equal(result.shouldFallback, true);
    assert.equal(updated.isActive, true);
    assert.equal(updated.testStatus, "banned");
  } finally {
    db.prepare = originalPrepare;
  }
});

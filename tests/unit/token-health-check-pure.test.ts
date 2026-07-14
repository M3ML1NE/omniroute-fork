import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractResolvedProxyConfig,
  buildRefreshFailureUpdate,
  clearHealthCheckLogCache,
  initTokenHealthCheck,
  stopTokenHealthCheck,
} from "../../src/lib/tokenHealthCheck.ts";

describe("extractResolvedProxyConfig", () => {
  it("returns null for null/undefined input", () => {
    assert.equal(extractResolvedProxyConfig(null), null);
    assert.equal(extractResolvedProxyConfig(undefined), null);
  });

  it("extracts the .proxy field when the object has a 'proxy' key", () => {
    const proxyConfig = { host: "1.2.3.4", port: 8080 };
    const result = extractResolvedProxyConfig({ proxy: proxyConfig, other: "field" });
    assert.deepEqual(result, proxyConfig);
  });

  it("returns null when .proxy is explicitly null", () => {
    assert.equal(extractResolvedProxyConfig({ proxy: null }), null);
  });

  it("returns the value unchanged when it has no 'proxy' key", () => {
    const config = { host: "1.2.3.4" };
    assert.deepEqual(extractResolvedProxyConfig(config), config);
  });

  it("returns arrays unchanged (not treated as a proxy wrapper)", () => {
    const arr = [1, 2, 3];
    assert.deepEqual(extractResolvedProxyConfig(arr), arr);
  });

  it("returns primitive values unchanged", () => {
    assert.equal(extractResolvedProxyConfig("some-string"), "some-string");
    assert.equal(extractResolvedProxyConfig(42), 42);
  });
});

describe("buildRefreshFailureUpdate", () => {
  it("marks the connection active (not expired) when it was not previously expired", () => {
    const now = new Date().toISOString();
    const update = buildRefreshFailureUpdate({ testStatus: "active" }, now);
    assert.equal(update.testStatus, "active");
    assert.equal(update.lastHealthCheckAt, now);
    assert.equal(update.lastError, "Health check: token refresh failed");
    assert.equal(update.lastErrorType, "token_refresh_failed");
    assert.equal(update.errorCode, "refresh_failed");
    assert.ok(!("expiredRetryCount" in update));
  });

  it("keeps 'expired' status and increments expiredRetryCount when already expired", () => {
    const now = new Date().toISOString();
    const update = buildRefreshFailureUpdate(
      { testStatus: "expired", expiredRetryCount: 2 },
      now
    );
    assert.equal(update.testStatus, "expired");
    assert.equal(update.expiredRetryCount, 3);
    assert.equal(update.expiredRetryAt, now);
  });

  it("treats a missing expiredRetryCount as 0 before incrementing", () => {
    const now = new Date().toISOString();
    const update = buildRefreshFailureUpdate({ testStatus: "expired" }, now);
    assert.equal(update.expiredRetryCount, 1);
  });
});

describe("clearHealthCheckLogCache", () => {
  it("does not throw when called", () => {
    assert.doesNotThrow(() => clearHealthCheckLogCache());
  });
});

describe("initTokenHealthCheck / stopTokenHealthCheck", () => {
  it("does not throw on init/stop, and stop is idempotent", () => {
    // NODE_ENV=test/automated-test-process detection short-circuits the
    // scheduler to a no-op here, so this only exercises the lifecycle guard
    // logic (initialized flag, interval teardown) rather than real ticking.
    assert.doesNotThrow(() => initTokenHealthCheck());
    assert.doesNotThrow(() => initTokenHealthCheck());
    assert.doesNotThrow(() => stopTokenHealthCheck());
    assert.doesNotThrow(() => stopTokenHealthCheck());
  });
});

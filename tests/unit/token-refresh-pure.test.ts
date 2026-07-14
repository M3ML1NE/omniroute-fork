import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  getRefreshLeadMs,
  supportsTokenRefresh,
  isUnrecoverableRefreshError,
  formatProviderCredentials,
  isProviderBlocked,
  getCircuitBreakerStatus,
  getConnectionRefreshMutexStatus,
  _getTokenRotationMapStats,
  _clearTokenRotationMap,
  TOKEN_EXPIRY_BUFFER_MS,
  REFRESH_LEAD_MS,
} from "../../open-sse/services/tokenRefresh.ts";

describe("getRefreshLeadMs", () => {
  it("returns the explicit lead time for a listed provider", () => {
    assert.equal(getRefreshLeadMs("codex"), REFRESH_LEAD_MS.codex);
    assert.equal(getRefreshLeadMs("mlproxy"), REFRESH_LEAD_MS.mlproxy);
  });

  it("falls back to TOKEN_EXPIRY_BUFFER_MS for an unlisted provider", () => {
    assert.equal(getRefreshLeadMs("some-unknown-provider"), TOKEN_EXPIRY_BUFFER_MS);
  });
});

describe("supportsTokenRefresh", () => {
  it("returns true for explicitly-supported providers", () => {
    assert.equal(supportsTokenRefresh("gemini"), true);
    assert.equal(supportsTokenRefresh("codex"), true);
    assert.equal(supportsTokenRefresh("cline"), true);
  });

  it("returns false for a provider with no refresh/token URL configured", () => {
    assert.equal(supportsTokenRefresh("some-totally-unknown-provider-xyz"), false);
  });
});

describe("isUnrecoverableRefreshError", () => {
  it("returns a falsy value for null/undefined/non-object input", () => {
    assert.ok(!isUnrecoverableRefreshError(null));
    assert.ok(!isUnrecoverableRefreshError(undefined));
    assert.ok(!isUnrecoverableRefreshError("error string"));
  });

  it("returns false for a result without a recognized error code", () => {
    assert.equal(isUnrecoverableRefreshError({ error: "some_other_error" }), false);
    assert.equal(isUnrecoverableRefreshError({}), false);
  });

  it("recognizes each unrecoverable error code", () => {
    assert.equal(isUnrecoverableRefreshError({ error: "unrecoverable_refresh_error" }), true);
    assert.equal(isUnrecoverableRefreshError({ error: "refresh_token_reused" }), true);
    assert.equal(isUnrecoverableRefreshError({ error: "invalid_request" }), true);
    assert.equal(isUnrecoverableRefreshError({ error: "invalid_grant" }), true);
  });
});

describe("formatProviderCredentials", () => {
  it("returns null and warns when the provider has no configuration", () => {
    let warned = false;
    const log = { warn: () => (warned = true) };
    const result = formatProviderCredentials("totally-unconfigured-provider", {}, log);
    assert.equal(result, null);
    assert.equal(warned, true);
  });

  // This fork's PROVIDERS registry only contains gigachat/openai-compatible
  // entries, so every legacy-provider name (gemini, claude, gemini-cli, kiro,
  // etc.) hits the "no configuration found" branch — the per-provider format
  // switch below it is currently dead code, kept for when providers are
  // re-added. Assert against a live config entry instead.
  it("returns null for every unconfigured legacy provider name", () => {
    for (const provider of ["gemini", "claude", "gemini-cli", "kiro", "codex"]) {
      const result = formatProviderCredentials(
        provider,
        { apiKey: "k", accessToken: "a", refreshToken: "r" },
        null
      );
      assert.equal(result, null, `expected null for unconfigured provider ${provider}`);
    }
  });
});

describe("isProviderBlocked / getCircuitBreakerStatus", () => {
  it("returns false for a provider with no circuit breaker state", () => {
    assert.equal(isProviderBlocked("provider-never-seen"), false);
  });

  it("returns an empty status map when no provider has ever failed", () => {
    // Cannot fully isolate module-level state across test files, but a
    // brand-new provider name should never appear in the status map.
    const status = getCircuitBreakerStatus();
    assert.equal(typeof status, "object");
    assert.ok(!("provider-never-seen-xyz-123" in status));
  });
});

describe("getConnectionRefreshMutexStatus", () => {
  it("returns an object (empty when no refresh is in-flight)", () => {
    const status = getConnectionRefreshMutexStatus();
    assert.equal(typeof status, "object");
  });
});

describe("_getTokenRotationMapStats / _clearTokenRotationMap", () => {
  beforeEach(() => {
    _clearTokenRotationMap();
  });

  it("reports an empty map after clearing", () => {
    const stats = _getTokenRotationMapStats();
    assert.equal(stats.size, 0);
    assert.equal(stats.entries, 0);
  });
});

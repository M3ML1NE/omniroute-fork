import { describe, it, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  resolveMlproxyConfig,
  computeCookieExpiry,
} from "../../../open-sse/executors/mlproxyConfig.ts";
import { parseSetCookies, redactMlproxyAuthBody } from "../../../open-sse/executors/mlproxyCookies.ts";
import {
  getMlproxyDispatcher,
  clearPool,
  _getPoolSize,
} from "../../../open-sse/executors/mlproxyAgent.ts";
import { MlproxyExecutor } from "../../../open-sse/executors/mlproxy.ts";
import type { ProviderCredentials } from "../../../open-sse/executors/base.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_PSD = {
  baseHost: "https://ml-proxy.internal.example.com",
  proxyId: "gateway-01",
  login: "svc-omniroute",
};

function makeCreds(overrides: Partial<ProviderCredentials> = {}): ProviderCredentials {
  return {
    providerSpecificData: {
      baseHost: "https://ml-proxy.internal.example.com",
      proxyId: "gateway-01",
      login: "svc-omniroute",
    },
    accessToken: "session=abc; csrf=xyz",
    refreshToken: "testpassword",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. resolveMlproxyConfig
// ---------------------------------------------------------------------------

describe("resolveMlproxyConfig", () => {
  it("returns a config for a valid full object", () => {
    const cfg = resolveMlproxyConfig({
      ...VALID_PSD,
      refreshIntervalMinutes: 30,
      caPath: "/etc/certs/ca.pem",
      tlsInsecure: false,
    });
    assert.ok(cfg, "config must not be null");
    assert.equal(cfg!.baseHost, "https://ml-proxy.internal.example.com");
    assert.equal(cfg!.proxyId, "gateway-01");
    assert.equal(cfg!.login, "svc-omniroute");
    assert.equal(cfg!.refreshIntervalMinutes, 30);
    assert.equal(cfg!.caPath, "/etc/certs/ca.pem");
    assert.equal(cfg!.tlsInsecure, false);
  });

  it("returns null when baseHost is missing", () => {
    assert.equal(resolveMlproxyConfig({ proxyId: "g", login: "u" }), null);
  });

  it("returns null when baseHost is not https", () => {
    assert.equal(
      resolveMlproxyConfig({ baseHost: "http://evil.com", proxyId: "g", login: "u" }),
      null
    );
  });

  it("returns null when baseHost is an invalid URL", () => {
    assert.equal(
      resolveMlproxyConfig({ baseHost: "not-a-url", proxyId: "g", login: "u" }),
      null
    );
  });

  it("returns null when proxyId is missing", () => {
    assert.equal(
      resolveMlproxyConfig({ baseHost: "https://h.example.com", login: "u" }),
      null
    );
  });

  it("returns null when login is missing", () => {
    assert.equal(
      resolveMlproxyConfig({ baseHost: "https://h.example.com", proxyId: "g" }),
      null
    );
  });

  it("returns null for non-object input", () => {
    assert.equal(resolveMlproxyConfig(null), null);
    assert.equal(resolveMlproxyConfig(undefined), null);
    assert.equal(resolveMlproxyConfig("string"), null);
    assert.equal(resolveMlproxyConfig(42), null);
  });

  it("defaults refreshIntervalMinutes to 15 when not provided", () => {
    const cfg = resolveMlproxyConfig(VALID_PSD);
    assert.ok(cfg);
    assert.equal(cfg!.refreshIntervalMinutes, 15);
  });

  it("defaults refreshIntervalMinutes to 15 when zero or negative", () => {
    const cfgZero = resolveMlproxyConfig({ ...VALID_PSD, refreshIntervalMinutes: 0 });
    assert.equal(cfgZero!.refreshIntervalMinutes, 15);

    const cfgNeg = resolveMlproxyConfig({ ...VALID_PSD, refreshIntervalMinutes: -5 });
    assert.equal(cfgNeg!.refreshIntervalMinutes, 15);
  });

  it("strips trailing whitespace from string fields", () => {
    const cfg = resolveMlproxyConfig({
      baseHost: "  https://h.example.com  ",
      proxyId: "  g  ",
      login: "  u  ",
    });
    assert.ok(cfg);
    assert.equal(cfg!.baseHost, "https://h.example.com");
    assert.equal(cfg!.proxyId, "g");
    assert.equal(cfg!.login, "u");
  });

  it("omits caPath and tlsInsecure when not present", () => {
    const cfg = resolveMlproxyConfig(VALID_PSD);
    assert.ok(cfg);
    assert.equal((cfg! as unknown as Record<string, unknown>).caPath, undefined);
    assert.equal((cfg! as unknown as Record<string, unknown>).tlsInsecure, undefined);
  });

  it("strips caPath when it is an empty string", () => {
    const cfg = resolveMlproxyConfig({ ...VALID_PSD, caPath: "   " });
    assert.ok(cfg);
    assert.equal((cfg! as unknown as Record<string, unknown>).caPath, undefined);
  });
});

// ---------------------------------------------------------------------------
// 2. computeCookieExpiry
// ---------------------------------------------------------------------------

describe("computeCookieExpiry", () => {
  it("returns a future ISO string for a positive interval", () => {
    const before = new Date();
    const iso = computeCookieExpiry(15);
    const expiry = new Date(iso);
    assert.ok(expiry > before, "expiry must be in the future");
    // 15 min ± 2 s tolerance
    const diffMs = expiry.getTime() - before.getTime();
    assert.ok(diffMs > 14 * 60_000, "expiry at least 14 min ahead");
    assert.ok(diffMs < 16 * 60_000, "expiry at most 16 min ahead");
  });

  it("returns the current time for interval 0 (no advancement)", () => {
    const before = new Date();
    const iso = computeCookieExpiry(0);
    const expiry = new Date(iso);
    // 0 minutes → now-ish (±1 s)
    const diffMs = Math.abs(expiry.getTime() - before.getTime());
    assert.ok(diffMs < 2000, "expiry should be within 2 s of now");
  });

  it("handles interval 1 correctly", () => {
    const before = new Date();
    const iso = computeCookieExpiry(1);
    const expiry = new Date(iso);
    const diffMs = expiry.getTime() - before.getTime();
    assert.ok(diffMs > 0, "expiry must be future");
    assert.ok(diffMs < 90_000, "expiry should be approx 1 min ahead");
  });
});

// ---------------------------------------------------------------------------
// 3. parseSetCookies
// ---------------------------------------------------------------------------

describe("parseSetCookies", () => {
  it("extracts name=value from a single Set-Cookie header", () => {
    const res = new Response(null, {
      headers: { "Set-Cookie": "session=abc; Path=/; HttpOnly" },
    });
    assert.equal(parseSetCookies(res), "session=abc");
  });

  it("handles multiple Set-Cookie headers", () => {
    // Use an array-style header definition — undici exposes these via getSetCookie()
    const res = new Response(null, {
      headers: [
        ["Set-Cookie", "session=abc; Path=/"],
        ["Set-Cookie", "csrf=xyz; Secure"],
      ],
    });
    assert.equal(parseSetCookies(res), "session=abc; csrf=xyz");
  });

  it("returns empty string when no Set-Cookie headers present", () => {
    const res = new Response(null, { headers: { "Content-Type": "application/json" } });
    assert.equal(parseSetCookies(res), "");
  });

  it("returns empty string for empty Set-Cookie array", () => {
    const res = new Response(null);
    // No headers at all → getSetCookie() returns []
    assert.equal(parseSetCookies(res), "");
  });

  it("ignores malformed Set-Cookie entries without =", () => {
    const res = new Response(null, {
      headers: { "Set-Cookie": "bogus" },
    });
    // "bogus" has no "=" → skipped
    assert.equal(parseSetCookies(res), "");
  });
});

// ---------------------------------------------------------------------------
// 4. redactMlproxyAuthBody
// ---------------------------------------------------------------------------

describe("redactMlproxyAuthBody", () => {
  it("redacts both login and password to ***", () => {
    const body = { login: "svc-user", password: "s3cret" };
    const redacted = redactMlproxyAuthBody(body);
    assert.deepEqual(redacted, { login: "***", password: "***" });
  });

  it("preserves non-sensitive fields", () => {
    const body = { login: "u", password: "p", extra: "keep-me", num: 42 };
    const redacted = redactMlproxyAuthBody(body);
    assert.deepEqual(redacted, {
      login: "***",
      password: "***",
      extra: "keep-me",
      num: 42,
    });
  });

  it("redacts password even when login is missing", () => {
    const body = { password: "only-pw" };
    const redacted = redactMlproxyAuthBody(body);
    assert.deepEqual(redacted, { password: "***" });
  });
});

// ---------------------------------------------------------------------------
// 5. getMlproxyDispatcher
// ---------------------------------------------------------------------------

describe("getMlproxyDispatcher", () => {
  const TEMP_CA_DIR = path.join(os.tmpdir(), "mlproxy-test-ca");

  afterEach(() => {
    // Clear the LRU pool between tests so each test gets a fresh Agent.
    clearPool();
  });

  after(() => {
    // Best-effort cleanup of temp CA file.
    try { fs.rmSync(TEMP_CA_DIR, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("returns an undici Agent with default TLS settings", () => {
    const agent = getMlproxyDispatcher({});
    assert.ok(agent, "agent must not be null");
    assert.equal(typeof agent.close, "function", "Agent must have close()");
  });

  it("uses caPath when provided", () => {
    fs.mkdirSync(TEMP_CA_DIR, { recursive: true });
    const caPath = path.join(TEMP_CA_DIR, "ca.pem");
    // Write a dummy certificate (Agent loads the file, doesn't validate content
    // until a connection is actually made).
    fs.writeFileSync(
      caPath,
      "-----BEGIN CERTIFICATE-----\nMIIDdTCCAl2gAwIBAgIJAOxfakecert0001\n-----END CERTIFICATE-----\n"
    );

    try {
      const agent = getMlproxyDispatcher({ caPath });
      assert.ok(agent, "agent must not be null");
      assert.equal(typeof agent.close, "function");
      assert.equal(_getPoolSize(), 1, "Agent should be cached in pool");
    } finally {
      fs.unlinkSync(caPath);
      fs.rmdirSync(TEMP_CA_DIR);
    }
  });

  it("throws when caPath points to a non-existent file", () => {
    assert.throws(
      () => getMlproxyDispatcher({ caPath: "/nonexistent/ca-bundle.pem" }),
      /cannot read CA file/
    );
  });

  it("uses tlsInsecure when set to true", () => {
    const agent = getMlproxyDispatcher({ tlsInsecure: true });
    assert.ok(agent, "agent must not be null");
    assert.equal(typeof agent.close, "function");
  });

  it("reuses cached Agent for same config fingerprint", () => {
    clearPool();
    const agent1 = getMlproxyDispatcher({ caPath: undefined, tlsInsecure: false });
    const agent2 = getMlproxyDispatcher({ caPath: undefined, tlsInsecure: false });
    assert.equal(agent1, agent2, "same config should reuse the cached Agent");
    assert.equal(_getPoolSize(), 1, "pool should contain exactly one Agent");
  });

  it("creates distinct Agents for different configs", () => {
    clearPool();
    const agent1 = getMlproxyDispatcher({ tlsInsecure: false });
    const agent2 = getMlproxyDispatcher({ tlsInsecure: true });
    assert.notEqual(agent1, agent2, "different configs should create different Agents");
    assert.equal(_getPoolSize(), 2, "pool should contain two Agents");
  });
});

// ---------------------------------------------------------------------------
// 6. MlproxyExecutor.buildUrl
// ---------------------------------------------------------------------------

describe("MlproxyExecutor.buildUrl", () => {
  const executor = new MlproxyExecutor();

  it("returns the correct chat completions URL", () => {
    const url = executor.buildUrl("any-model", false, 0, makeCreds());
    assert.equal(
      url,
      "https://ml-proxy.internal.example.com/path/proxy/gateway-01/v1/chat/completions"
    );
  });

  it("strips trailing slash from baseHost", () => {
    const creds = makeCreds({
      providerSpecificData: {
        baseHost: "https://ml-proxy.internal.example.com/",
        proxyId: "gateway-01",
        login: "svc-omniroute",
      },
    });
    const url = executor.buildUrl("any-model", true, 0, creds);
    assert.equal(
      url,
      "https://ml-proxy.internal.example.com/path/proxy/gateway-01/v1/chat/completions"
    );
  });

  it("throws when credentials are null", () => {
    assert.throws(() => executor.buildUrl("m", false, 0, null), /missing or invalid/);
  });

  it("throws when providerSpecificData is missing", () => {
    assert.throws(() => executor.buildUrl("m", false, 0, {}), /missing or invalid/);
  });
});

// ---------------------------------------------------------------------------
// 6b. MlproxyExecutor.modelsUrl
// ---------------------------------------------------------------------------

describe("MlproxyExecutor.modelsUrl", () => {
  const executor = new MlproxyExecutor();

  it("returns the correct models URL", () => {
    const url = executor.modelsUrl(makeCreds());
    assert.equal(
      url,
      "https://ml-proxy.internal.example.com/path/proxy/gateway-01/v1/models"
    );
  });

  it("strips trailing slash from baseHost", () => {
    const creds = makeCreds({
      providerSpecificData: {
        baseHost: "https://ml-proxy.internal.example.com/",
        proxyId: "gateway-01",
        login: "svc-omniroute",
      },
    });
    const url = executor.modelsUrl(creds);
    assert.equal(
      url,
      "https://ml-proxy.internal.example.com/path/proxy/gateway-01/v1/models"
    );
  });
});

// ---------------------------------------------------------------------------
// 7. MlproxyExecutor.buildHeaders
// ---------------------------------------------------------------------------

describe("MlproxyExecutor.buildHeaders", () => {
  const executor = new MlproxyExecutor();

  it("sets Cookie from accessToken", () => {
    const creds = makeCreds({ accessToken: "session=abc; csrf=xyz" });
    const headers = executor.buildHeaders(creds, false);
    assert.equal(headers["Cookie"], "session=abc; csrf=xyz");
  });

  it("sets Content-Type to application/json", () => {
    const headers = executor.buildHeaders(makeCreds(), false);
    assert.equal(headers["Content-Type"], "application/json");
  });

  it("sets Accept to text/event-stream when stream=true", () => {
    const headers = executor.buildHeaders(makeCreds(), true);
    assert.equal(headers["Accept"], "text/event-stream");
  });

  it("sets Accept to application/json when stream=false", () => {
    const headers = executor.buildHeaders(makeCreds(), false);
    assert.equal(headers["Accept"], "application/json");
  });

  it("does NOT set Authorization header", () => {
    const headers = executor.buildHeaders(makeCreds(), false);
    assert.equal(headers["Authorization"], undefined);
  });

  it("omits Cookie header when accessToken is empty", () => {
    const creds = makeCreds({ accessToken: "" });
    const headers = executor.buildHeaders(creds, false);
    assert.equal(Object.hasOwn(headers, "Cookie"), false);
  });
});

// ---------------------------------------------------------------------------
// 8. MlproxyExecutor.needsRefresh
// ---------------------------------------------------------------------------

describe("MlproxyExecutor.needsRefresh", () => {
  const executor = new MlproxyExecutor();

  it("returns false when expiresAt is far in the future", () => {
    const farFuture = new Date(Date.now() + 3600_000).toISOString();
    assert.equal(executor.needsRefresh({ ...makeCreds(), expiresAt: farFuture }), false);
  });

  it("returns true when expiresAt is in the past", () => {
    const past = new Date(Date.now() - 10_000).toISOString();
    assert.equal(executor.needsRefresh({ ...makeCreds(), expiresAt: past }), true);
  });

  it("returns true when expiresAt is within the 60s lead window", () => {
    const withinLead = new Date(Date.now() + 30_000).toISOString();
    assert.equal(executor.needsRefresh({ ...makeCreds(), expiresAt: withinLead }), true);
  });

  it("returns false when expiresAt is just outside the 60s lead window", () => {
    const justOutside = new Date(Date.now() + 61_000).toISOString();
    assert.equal(executor.needsRefresh({ ...makeCreds(), expiresAt: justOutside }), false);
  });

  it("returns false when expiresAt is missing", () => {
    assert.equal(executor.needsRefresh(makeCreds()), false);
  });

  it("returns false when expiresAt is not a valid date", () => {
    assert.equal(
      executor.needsRefresh({ ...makeCreds(), expiresAt: "not-a-date" }),
      false
    );
  });

  it("returns false for null credentials", () => {
    assert.equal(executor.needsRefresh(null), false);
  });
});

// ---------------------------------------------------------------------------
// 9. MlproxyExecutor.refreshCredentials mutex
// ---------------------------------------------------------------------------

describe("MlproxyExecutor.refreshCredentials mutex", () => {
  it("reuses in-flight refresh promise for concurrent calls", async () => {
    const executor = new MlproxyExecutor();
    const creds = makeCreds();

    // Override the login method to track calls and resolve after a short delay.
    let loginCallCount = 0;
    const originalLogin = (executor as unknown as { login: typeof executor["refreshCredentials"] })
      .login;
    (executor as unknown as { login: (c: ProviderCredentials, log: unknown) => Promise<unknown> }).login =
      async function () {
        loginCallCount++;
        // Simulate a network round-trip.
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { accessToken: `session=cookie-${loginCallCount}`, expiresAt: computeCookieExpiry(15) };
      };

    try {
      // Fire two concurrent refreshes.
      const [r1, r2] = await Promise.all([
        executor.refreshCredentials(creds, null),
        executor.refreshCredentials(creds, null),
      ]);

      // Both must resolve to the same result.
      assert.equal(r1, r2, "concurrent calls must share the same promise");
      // Only one login POST should have been made.
      assert.equal(loginCallCount, 1, "login must be called exactly once for concurrent requests");
    } finally {
      // Restore original login method.
      (executor as unknown as { login: unknown }).login = originalLogin;
    }
  });
});

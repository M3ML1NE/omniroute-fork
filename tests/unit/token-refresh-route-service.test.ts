import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-token-refresh-route-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-api-key-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const tokenRefresh = await import("../../src/sse/services/tokenRefresh.ts");
const { PROVIDERS, OAUTH_ENDPOINTS } = await import("../../open-sse/config/constants.ts");

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function withMockedFetch(fetchImpl, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function withMockedNow(now, fn) {
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    return await fn();
  } finally {
    Date.now = originalNow;
  }
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  delete PROVIDERS["custom-oauth-local-608"];
  await resetStorage();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("updateProviderCredentials persists rotated tokens and returns false for missing rows", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: "claude",
    authType: "oauth",
    name: "Refresh Target",
    accessToken: "access-old",
    refreshToken: "refresh-old",
  });

  const updated = await tokenRefresh.updateProviderCredentials((connection as any).id, {
    accessToken: "access-new",
    refreshToken: "refresh-new",
    expiresIn: 600,
    providerSpecificData: { tenant: "team-a" },
  });
  const stored = await providersDb.getProviderConnectionById((connection as any).id);
  const missing = await tokenRefresh.updateProviderCredentials("missing", { accessToken: "nope" });

  assert.equal(updated, true);
  assert.equal(stored.accessToken, "access-new");
  assert.equal(stored.refreshToken, "refresh-new");
  assert.equal(stored.expiresIn, 600);
  assert.equal(typeof stored.expiresAt, "string");
  assert.equal(typeof stored.tokenExpiresAt, "string");
  assert.equal(stored.expiresAt, stored.tokenExpiresAt);
  assert.deepEqual(stored.providerSpecificData, { tenant: "team-a" });
  assert.equal(missing, false);
});

test("checkAndRefreshToken refreshes expiring OAuth access tokens and updates the connection", async () => {
  const now = 1_700_000_000_000;
  const connection = await providersDb.createProviderConnection({
    provider: "claude",
    authType: "oauth",
    name: "Claude OAuth",
    accessToken: "claude-old-access",
    refreshToken: "claude-refresh-old",
    expiresAt: new Date(now + tokenRefresh.TOKEN_EXPIRY_BUFFER_MS - 1_000).toISOString(),
  });

  await withMockedNow(now, async () => {
    await withMockedFetch(
      async (url) => {
        assert.equal(String(url), OAUTH_ENDPOINTS.anthropic.token);
        return jsonResponse({
          access_token: "claude-access-fresh",
          refresh_token: "claude-refresh-fresh",
          expires_in: 900,
        });
      },
      async () => {
        const refreshed = await tokenRefresh.checkAndRefreshToken("claude", {
          ...connection,
          connectionId: connection.id,
        });
        const stored = await providersDb.getProviderConnectionById((connection as any).id);

        assert.equal(refreshed.accessToken, "claude-access-fresh");
        assert.equal(refreshed.refreshToken, "claude-refresh-fresh");
        assert.equal(stored.accessToken, "claude-access-fresh");
        assert.equal(stored.refreshToken, "claude-refresh-fresh");
        assert.equal(stored.expiresIn, 900);
        assert.equal(typeof stored.expiresAt, "string");
      }
    );
  });
});



test("checkAndRefreshToken leaves credentials untouched when nothing is close to expiry", async () => {
  const now = 1_700_000_200_000;
  const credentials = {
    connectionId: "conn-stable",
    accessToken: "stable-access",
    refreshToken: "stable-refresh",
    expiresAt: new Date(now + tokenRefresh.TOKEN_EXPIRY_BUFFER_MS + 60_000).toISOString(),
    providerSpecificData: {
      copilotToken: "copilot-stable",
      copilotTokenExpiresAt: Math.floor(
        (now + tokenRefresh.TOKEN_EXPIRY_BUFFER_MS + 60_000) / 1000
      ),
    },
  };

  await withMockedNow(now, async () => {
    await withMockedFetch(
      async () => {
        throw new Error("fetch should not be called");
      },
      async () => {
        const refreshed = await tokenRefresh.checkAndRefreshToken("github", credentials);
        assert.deepEqual(refreshed, credentials);
      }
    );
  });
});


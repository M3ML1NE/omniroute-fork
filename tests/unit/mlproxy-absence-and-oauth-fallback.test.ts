import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Task 11: Focused regression tests closing genuine gaps left after tasks 2-10.
 *
 * Tasks 2-10 already cover:
 *  - mlproxy/mlspace absence in predicates (providerWhitelist.test.ts, provider-identity.test.ts)
 *  - Migration idempotence/preservation (migration-mlproxy-purge.test.ts, migration-gigachat-compat.test.ts)
 *  - Whitelist rejection at the predicate level (providerWhitelist.test.ts)
 *  - Per-connection model isolation (provider-models-route.test.ts, extended in task 7)
 *  - mTLS routing isolation (gigachat-per-connection-routing.test.ts)
 *  - Dashboard/no-OAuth UI+API shape (provider-nodes-gigachat-dashboard.test.ts)
 *
 * This file closes the remaining gaps called out in the task spec:
 *  1. HTTP-route-level rejection of mlproxy/mlspace/bare-gigachat on POST /api/providers
 *     and POST /api/providers/bulk (existing tests only cover the underlying predicate
 *     functions in isolation, not the actual route's 400 response).
 *  2. Runtime dispatch absence: `getExecutor("mlproxy")` / `getExecutor("mlspace")` never
 *     resolves to a "working" mlproxy-specific executor — it silently falls through to the
 *     generic DefaultExecutor with the OpenAI fallback config (proving the mlproxy executor
 *     class itself is gone, not merely that the route rejects the id upstream).
 *  3. OAuth-shaped payload injection has zero effect end-to-end: fields like accessToken,
 *     refreshToken, authUrl, clientId, clientSecret sent in a provider-node or
 *     provider-connection creation request for a gigachat-compatible provider are (a) not
 *     persisted to the DB's access_token/refresh_token columns and (b) never surface as an
 *     Authorization header even when mTLS creds are simultaneously present.
 *  4. No OAuth fallback path exists for GigaChat: `getAccessToken()` (the OAuth refresh
 *     entry point) returns null immediately for gigachat/gigachat-compatible credentials
 *     with no refreshToken, and `supportsTokenRefresh()` returns false for every GigaChat
 *     identity — proving there is no token-refresh code path that could silently attempt
 *     OAuth for an mTLS-only provider.
 *  5. Malformed mTLS cert path (whitespace-only) is rejected by node-creation validation,
 *     not merely "missing mtls object" (already covered by task 6/9's tests).
 */

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-t11-regression-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const pgModule = await import("../../src/lib/db/postgres.ts");
const nodesRoute = await import("../../src/app/api/provider-nodes/route.ts");
const providersRoute = await import("../../src/app/api/providers/route.ts");
const bulkRoute = await import("../../src/app/api/providers/bulk/route.ts");
const { getExecutor } = await import("../../open-sse/executors/index.ts");
const { DefaultExecutor } = await import("../../open-sse/executors/default.ts");
const { getAccessToken, supportsTokenRefresh } =
  await import("../../open-sse/services/tokenRefresh.ts");

const RUN_PREFIX = `t11-regression-${process.pid}`;

function serialTest(name: string, fn: () => Promise<void> | void) {
  test(name, { concurrency: false }, fn);
}

async function resetStorage() {
  const schema = pgModule.getSchema();
  await pgModule.query(`DELETE FROM ${schema}.provider_connections WHERE name LIKE $1`, [
    `${RUN_PREFIX}-%`,
  ]);
  await pgModule.query(`DELETE FROM ${schema}.provider_nodes WHERE name LIKE $1`, [
    `${RUN_PREFIX}-%`,
  ]);
  core.resetDbInstance();
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  await resetStorage();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function uniqueName(suffix: string): string {
  return `${RUN_PREFIX}-${suffix}-${Math.random().toString(16).slice(2, 8)}`;
}

function makeCreateNodeRequest(body: unknown): Request {
  return new Request("http://localhost/api/provider-nodes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeCreateConnectionRequest(body: unknown): Request {
  return new Request("http://localhost/api/providers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeBulkRequest(body: unknown): Request {
  return new Request("http://localhost/api/providers/bulk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ── Gap 1: HTTP-route-level whitelist rejection ─────────────────────────────

{
  const rejectedIds = ["mlproxy", "mlspace", "gigachat"];

  for (const providerId of rejectedIds) {
    serialTest(
      `POST /api/providers rejects "${providerId}" with 400 Invalid provider (T11.1)`,
      async () => {
        const res = await providersRoute.POST(
          makeCreateConnectionRequest({
            provider: providerId,
            name: uniqueName(`route-reject-${providerId}`),
            apiKey: "irrelevant-key",
            priority: 1,
          })
        );
        assert.equal(res.status, 400);
        const body = (await res.json()) as { error: string };
        assert.equal(body.error, "Invalid provider");
      }
    );

    serialTest(
      `POST /api/providers/bulk rejects "${providerId}" with 400 Invalid provider (T11.1)`,
      async () => {
        const res = await bulkRoute.POST(
          makeBulkRequest({
            provider: providerId,
            entries: [{ name: uniqueName(`bulk-reject-${providerId}`), apiKey: "irrelevant-key" }],
          })
        );
        assert.equal(res.status, 400);
        const body = (await res.json()) as { error: string };
        assert.equal(body.error, "Invalid provider");
      }
    );
  }
}

// ── Gap 2: no working mlproxy/mlspace executor at runtime dispatch ──────────

serialTest(
  'getExecutor("mlproxy") does not resolve to a working mlproxy-specific executor (T11.2)',
  () => {
    const exec = getExecutor("mlproxy");
    // A DefaultExecutor instance is returned (the factory never throws), but it must
    // NOT carry any mlproxy-specific behavior: no registered PROVIDERS[] config, so
    // buildUrl falls through to the generic OpenAI-compatible fallback base URL —
    // proving there is no functional mlproxy executor class wired into the factory.
    assert.ok(exec instanceof DefaultExecutor, "factory returns a DefaultExecutor, not a crash");
    const url = exec.buildUrl("some-model", false, 0, { providerSpecificData: {} });
    assert.equal(
      url,
      "https://api.openai.com/v1/chat/completions",
      "mlproxy has no registered config — falls through to the generic OpenAI fallback, proving no mlproxy-specific executor exists"
    );
  }
);

serialTest(
  'getExecutor("mlspace") does not resolve to a working mlspace-specific executor (T11.2)',
  () => {
    const exec = getExecutor("mlspace");
    assert.ok(exec instanceof DefaultExecutor);
    const url = exec.buildUrl("some-model", false, 0, { providerSpecificData: {} });
    assert.equal(url, "https://api.openai.com/v1/chat/completions");
  }
);

// ── Gap 3: OAuth-shaped payload smuggling has no effect ─────────────────────

serialTest(
  "OAuth-shaped fields sent alongside gigachat-compatible node creation are not reflected as OAuth in the response (T11.3)",
  async () => {
    const res = await nodesRoute.POST(
      makeCreateNodeRequest({
        name: uniqueName("oauth-smuggle-node"),
        prefix: uniqueName("osn"),
        type: "gigachat-compatible",
        baseUrl: "https://gigachat.devices.sberbank.ru/api/v1",
        mtls: { cert_path: "/a", key_path: "/b", ca_path: "/c" },
        // OAuth-shaped extras — createProviderNodeSchema has no such fields, Zod
        // silently strips unrecognized keys (no .passthrough()).
        accessToken: "evil-access",
        refreshToken: "evil-refresh",
        authUrl: "https://evil.example.com/oauth",
        clientId: "evil-client-id",
        clientSecret: "evil-client-secret",
      })
    );
    assert.equal(res.status, 201);
    const data = (await res.json()) as { node: Record<string, unknown> };
    const serialized = JSON.stringify(data.node);
    assert.ok(!serialized.includes("evil-access"), "accessToken must not survive node creation");
    assert.ok(!serialized.includes("evil-refresh"), "refreshToken must not survive node creation");
    assert.ok(!serialized.includes("evil.example.com"), "authUrl must not survive node creation");
    assert.equal(data.node.accessToken, undefined);
    assert.equal(data.node.refreshToken, undefined);
    assert.equal(data.node.authUrl, undefined);
    assert.equal(data.node.clientId, undefined);
    assert.equal(data.node.clientSecret, undefined);
  }
);

serialTest(
  "OAuth-shaped fields sent alongside gigachat-compatible connection creation are never persisted to access_token/refresh_token columns (T11.3)",
  async () => {
    const nodeRes = await nodesRoute.POST(
      makeCreateNodeRequest({
        name: uniqueName("oauth-smuggle-conn-node"),
        prefix: uniqueName("oscn"),
        type: "gigachat-compatible",
        baseUrl: "https://gigachat.devices.sberbank.ru/api/v1",
        mtls: { cert_path: "/a", key_path: "/b", ca_path: "/c" },
      })
    );
    const node = ((await nodeRes.json()) as { node: Record<string, unknown> }).node;

    const connRes = await providersRoute.POST(
      makeCreateConnectionRequest({
        provider: node.id,
        name: uniqueName("oauth-smuggle-conn"),
        priority: 1,
        accessToken: "SHOULD-NOT-PERSIST-access",
        refreshToken: "SHOULD-NOT-PERSIST-refresh",
      })
    );
    assert.equal(connRes.status, 201, await connRes.clone().text());
    const connBody = (await connRes.json()) as { connection: Record<string, unknown> };
    const connId = connBody.connection.id as string;

    // createProviderSchema has no accessToken/refreshToken field, so validation.data
    // never carries them through to createProviderConnection — verify at the DB layer,
    // not just the HTTP response, to rule out "stripped in response but written to DB".
    const schema = pgModule.getSchema();
    const row = await pgModule.query<{ access_token: string | null; refresh_token: string | null }>(
      `SELECT access_token, refresh_token FROM ${schema}.provider_connections WHERE id = $1`,
      [connId]
    );
    assert.equal(row.rows[0]?.access_token, null, "access_token column must remain null");
    assert.equal(row.rows[0]?.refresh_token, null, "refresh_token column must remain null");
  }
);

serialTest(
  "buildHeaders never emits an Authorization header for an mTLS gigachat-compatible connection, even with smuggled accessToken fields (T11.3)",
  () => {
    const exec = new DefaultExecutor("gigachat-compatible-smuggletest");

    // Smuggled inside providerSpecificData.
    const headersA = exec.buildHeaders(
      {
        providerSpecificData: {
          mtls: { cert_path: "/a", key_path: "/b", ca_path: "/c" },
          accessToken: "smuggled-should-not-be-used",
          oauthToken: "also-smuggled",
        },
      },
      false
    );
    assert.equal(headersA["Authorization"], undefined, "psd-smuggled accessToken must be ignored");

    // Smuggled at the top level of credentials, alongside mTLS.
    const headersB = exec.buildHeaders(
      {
        accessToken: "top-level-smuggled",
        providerSpecificData: { mtls: { cert_path: "/a", key_path: "/b", ca_path: "/c" } },
      },
      false
    );
    assert.equal(
      headersB["Authorization"],
      undefined,
      "top-level accessToken must be ignored when mTLS creds are present"
    );
  }
);

// ── Gap 4: no OAuth token-refresh path for GigaChat ─────────────────────────

serialTest(
  "getAccessToken returns null immediately for gigachat-compatible credentials with no refreshToken — no OAuth attempt (T11.4)",
  async () => {
    const result = await getAccessToken(
      "gigachat-compatible-x",
      {
        apiKey: null,
        refreshToken: null,
        providerSpecificData: { mtls: { cert_path: "/a", key_path: "/b", ca_path: "/c" } },
      },
      null
    );
    assert.equal(result, null, "no refreshToken means no OAuth refresh is even attempted");
  }
);

serialTest(
  "getAccessToken returns null immediately for bare gigachat credentials with no refreshToken (T11.4)",
  async () => {
    const result = await getAccessToken("gigachat", { apiKey: null, refreshToken: null }, null);
    assert.equal(result, null);
  }
);

serialTest("supportsTokenRefresh is false for every GigaChat provider identity (T11.4)", () => {
  assert.equal(supportsTokenRefresh("gigachat"), false);
  assert.equal(supportsTokenRefresh("gigachat-compatible-x"), false);
  assert.equal(supportsTokenRefresh("gigachat-compatible-abc123"), false);
});

// ── Gap 5: malformed mTLS cert path rejected (whitespace, not just absent) ──

serialTest(
  "gigachat-compatible node creation rejects a whitespace-only cert_path (T11.5)",
  async () => {
    const res = await nodesRoute.POST(
      makeCreateNodeRequest({
        name: uniqueName("malformed-cert-node"),
        prefix: uniqueName("mcn"),
        type: "gigachat-compatible",
        baseUrl: "https://gigachat.devices.sberbank.ru/api/v1",
        mtls: { cert_path: "   ", key_path: "/a", ca_path: "/b" },
      })
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as {
      error: { details?: { field: string; message: string }[] };
    };
    const details = body.error?.details ?? [];
    assert.ok(
      details.some((d) => d.field === "mtls.cert_path"),
      "validation error must point at mtls.cert_path"
    );
  }
);

serialTest(
  "gigachat-compatible node creation rejects an empty ca_path while cert/key are valid (T11.5)",
  async () => {
    const res = await nodesRoute.POST(
      makeCreateNodeRequest({
        name: uniqueName("malformed-ca-node"),
        prefix: uniqueName("man"),
        type: "gigachat-compatible",
        baseUrl: "https://gigachat.devices.sberbank.ru/api/v1",
        mtls: { cert_path: "/a", key_path: "/b", ca_path: "" },
      })
    );
    assert.equal(res.status, 400);
  }
);

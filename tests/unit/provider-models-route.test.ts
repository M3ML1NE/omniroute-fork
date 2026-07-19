import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-provider-models-route-"));
process.env.DATA_DIR = TEST_DATA_DIR;
// The route's outbound fetches go through safeOutboundFetch's SSRF guard,
// which blocks private/loopback URLs by default — this test's fixture HTTP
// server binds to 127.0.0.1, so private URLs must be explicitly allowed.
process.env.OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS = "true";

const core = await import("../../src/lib/db/core.ts");
const pgModule = await import("../../src/lib/db/postgres.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const modelsDb = await import("../../src/lib/db/models.ts");
const route = await import("../../src/app/api/providers/[id]/models/route.ts");
const mtlsAgent = await import("../../open-sse/services/mtlsAgent.ts");

// mTLS fixtures shared with proxy-fetch-mtls-patch.test.ts and
// keystore-wiring.test.ts — server.{crt,key} + client.{crt,key} + ca.crt are
// one mTLS pair signed by MockGigaChatCA. server2/client2 are a SECOND,
// independently-generated cert pair signed by the SAME CA — used here to
// prove that two gigachat-compatible connections with different mTLS
// certificates get isolated, disjoint model catalogs (Task 7).
const TLS_DIR = path.join(import.meta.dirname, "../fixtures/mock-tls");
const MTLS_CFG_A = {
  cert_path: path.join(TLS_DIR, "client.crt"),
  key_path: path.join(TLS_DIR, "client.key"),
  ca_path: path.join(TLS_DIR, "ca.crt"),
};
const MTLS_CFG_B = {
  cert_path: path.join(TLS_DIR, "client2.crt"),
  key_path: path.join(TLS_DIR, "client2.key"),
  ca_path: path.join(TLS_DIR, "ca.crt"),
};

const RUN_PREFIX = `provider-models-route-${process.pid}`;

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
});

test.after(async () => {
  await resetStorage();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function uniqueName(suffix: string): string {
  return `${RUN_PREFIX}-${suffix}-${Math.random().toString(16).slice(2, 8)}`;
}

function makeRequest(id: string, query = ""): Request {
  return new Request(`http://localhost/api/providers/${id}/models${query}`, { method: "GET" });
}

// Real loopback HTTP server — proxyFetch captures globalThis.fetch once at
// module-import time (frozen inside its own patch state), so a per-test
// `globalThis.fetch = ...` reassignment never actually reaches the route's
// safeOutboundFetch → fetchWithTimeout → proxyFetch chain. A real server on
// 127.0.0.1 is the only reliable way to exercise these HTTP branches.
async function withHttpServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  fn: (baseUrl: string) => Promise<void>
) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await fn(`http://127.0.0.1:${(address as { port: number }).port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

// Real mTLS HTTPS server (client cert required) — used to prove connection
// scoping: each server presents its own model list and only accepts the
// client cert issued for it, so a wrong-cert connection cannot reach it.
async function withMtlsHttpServer(
  serverCertName: string,
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  fn: (baseUrl: string) => Promise<void>
) {
  const server = https.createServer(
    {
      cert: fs.readFileSync(path.join(TLS_DIR, `${serverCertName}.crt`)),
      key: fs.readFileSync(path.join(TLS_DIR, `${serverCertName}.key`)),
      ca: fs.readFileSync(path.join(TLS_DIR, "ca.crt")),
      requestCert: true,
      rejectUnauthorized: true,
    },
    handler
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    // Server certs have CN=localhost, so the baseUrl must use "localhost" (it
    // still resolves to the 127.0.0.1 loopback listener) for TLS hostname
    // verification to pass — matches the pattern in
    // proxy-fetch-mtls-patch.test.ts.
    await fn(`https://localhost:${(address as { port: number }).port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

serialTest("GET returns 404 for a connection that does not exist", async () => {
  const res = await route.GET(makeRequest("does-not-exist"), {
    params: Promise.resolve({ id: "does-not-exist" }),
  });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error, "Connection not found");
});

serialTest("GET returns 400 when the connection has no provider value", async () => {
  // createProviderConnection requires a provider, so write directly to
  // exercise the "Invalid connection provider" guard clause without a
  // constraint violation.
  const created = await providersDb.createProviderConnection({
    provider: "openai-compatible-x",
    authType: "apikey",
    name: uniqueName("blank-provider"),
    apiKey: "sk-test",
  });
  assert.ok(created);
  const db = core.getDbInstance();
  await db
    .prepare("UPDATE provider_connections SET provider = '' WHERE id = ?")
    .run((created as any).id);

  const res = await route.GET(makeRequest((created as any).id), {
    params: Promise.resolve({ id: (created as any).id }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, "Invalid connection provider");
});

serialTest("GET returns 400 for a provider that is not openai/gigachat compatible", async () => {
  // The route's sole discovery path is `isOpenAICompatibleProvider(provider)`
  // (openai-compatible-* / gigachat-compatible-*). Any other provider id
  // falls through to the terminal "does not support models listing" 400 —
  // there is no more legacy PROVIDER_MODELS_CONFIG/local-catalog branch.
  const created = await providersDb.createProviderConnection({
    provider: "unsupported-test-provider",
    authType: "apikey",
    name: uniqueName("unsupported"),
    apiKey: "sk-test",
  });
  assert.ok(created);

  const res = await route.GET(makeRequest((created as any).id), {
    params: Promise.resolve({ id: (created as any).id }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, "Provider unsupported-test-provider does not support models listing");
});

serialTest(
  "GET returns a 'none' response when an openai-compatible provider has no baseUrl configured",
  async () => {
    const created = await providersDb.createProviderConnection({
      provider: "openai-compatible-noconfig",
      authType: "apikey",
      name: uniqueName("no-baseurl"),
      apiKey: "sk-test",
    });
    assert.ok(created);

    const res = await route.GET(makeRequest((created as any).id), {
      params: Promise.resolve({ id: (created as any).id }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.source, "none");
    assert.deepEqual(body.models, []);
    assert.equal(body.warning, "No base URL configured for OpenAI compatible provider");
  }
);

serialTest(
  "GET fetches models from an openai-compatible provider's /v1/models endpoint",
  async () => {
    await withHttpServer(
      (req, res) => {
        if (req.url === "/v1/models") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ data: [{ id: "model-a", owned_by: "test" }] }));
          return;
        }
        res.writeHead(404);
        res.end("not found");
      },
      async (baseUrl) => {
        const created = await providersDb.createProviderConnection({
          provider: "openai-compatible-live",
          authType: "apikey",
          name: uniqueName("live"),
          apiKey: "sk-test",
          providerSpecificData: { baseUrl },
        });
        assert.ok(created);

        const res = await route.GET(makeRequest((created as any).id), {
          params: Promise.resolve({ id: (created as any).id }),
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.source, "api");
        assert.equal(body.provider, "openai-compatible-live");
        assert.ok(Array.isArray(body.models));
        assert.equal(body.models[0].id, "model-a");
      }
    );
  }
);

serialTest(
  "GET returns an empty 'none' response when /v1/models 404s and no cache exists",
  async () => {
    await withHttpServer(
      (_req, res) => {
        res.writeHead(404);
        res.end("not found");
      },
      async (baseUrl) => {
        const created = await providersDb.createProviderConnection({
          provider: "openai-compatible-broken",
          authType: "apikey",
          name: uniqueName("broken"),
          apiKey: "sk-test",
          providerSpecificData: { baseUrl },
        });
        assert.ok(created);

        const res = await route.GET(makeRequest((created as any).id), {
          params: Promise.resolve({ id: (created as any).id }),
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.source, "none");
        assert.deepEqual(body.models, []);
        assert.equal(body.warning, "Live discovery failed — no models returned by provider");
      }
    );
  }
);

serialTest(
  "GET returns a stale cache response when /v1/models 404s but a prior cache exists",
  async () => {
    await withHttpServer(
      (_req, res) => {
        res.writeHead(404);
        res.end("not found");
      },
      async (baseUrl) => {
        const created = await providersDb.createProviderConnection({
          provider: "openai-compatible-stale",
          authType: "apikey",
          name: uniqueName("stale"),
          apiKey: "sk-test",
          providerSpecificData: { baseUrl },
        });
        assert.ok(created);
        const connectionId = (created as any).id;

        const modelDiscovery = await import("../../src/lib/providerModels/modelDiscovery.ts");
        await modelDiscovery.persistDiscoveredModels("openai-compatible-stale", connectionId, [
          { id: "prior-model", owned_by: "test" },
        ]);

        const res = await route.GET(makeRequest(connectionId, "?refresh=true"), {
          params: Promise.resolve({ id: connectionId }),
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.source, "cache-stale");
        assert.equal(body.warning, "Live discovery failed — showing last-known models");
        assert.equal(body.models.length, 1);
        assert.equal(body.models[0].id, "prior-model");
      }
    );
  }
);

serialTest("GET returns the auth-failed status when the provider responds with 401", async () => {
  await withHttpServer(
    (_req, res) => {
      res.writeHead(401);
      res.end("unauthorized");
    },
    async (baseUrl) => {
      const created = await providersDb.createProviderConnection({
        provider: "openai-compatible-authfail",
        authType: "apikey",
        name: uniqueName("authfail"),
        apiKey: "sk-bad",
        providerSpecificData: { baseUrl },
      });
      assert.ok(created);

      const res = await route.GET(makeRequest((created as any).id), {
        params: Promise.resolve({ id: (created as any).id }),
      });
      assert.equal(res.status, 401);
      const body = await res.json();
      assert.match(body.error, /Auth failed: 401/);
    }
  );
});

serialTest("GET excludes hidden models from the response when excludeHidden=true", async () => {
  await withHttpServer(
    (req, res) => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            data: [
              { id: "model-visible", owned_by: "test" },
              { id: "model-hidden", owned_by: "test" },
            ],
          })
        );
        return;
      }
      res.writeHead(404);
      res.end("not found");
    },
    async (baseUrl) => {
      const created = await providersDb.createProviderConnection({
        provider: "openai-compatible-hidden",
        authType: "apikey",
        name: uniqueName("hidden"),
        apiKey: "sk-test",
        providerSpecificData: { baseUrl },
      });
      assert.ok(created);

      await modelsDb.mergeModelCompatOverride("openai-compatible-hidden", "model-hidden", {
        isHidden: true,
      });

      const res = await route.GET(makeRequest((created as any).id, "?excludeHidden=true"), {
        params: Promise.resolve({ id: (created as any).id }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      const ids = body.models.map((m: any) => m.id);
      assert.ok(ids.includes("model-visible"));
      assert.ok(!ids.includes("model-hidden"));
    }
  );
});

// Task 7 — GigaChat model discovery must be connection-scoped: two
// gigachat-compatible-* connections with different mTLS certs and different
// upstream responses must never share a model catalog (no global union
// bucket keyed by a stripped/legacy "gigachat" provider name).
serialTest(
  "GET keeps two gigachat-compatible connections' discovered models disjoint and independently cached",
  async () => {
    await withMtlsHttpServer(
      "server",
      (req, res) => {
        if (req.url === "/api/v1/models") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ data: [{ id: "gigachat-model-a", owned_by: "sber" }] }));
          return;
        }
        res.writeHead(404);
        res.end("not found");
      },
      async (baseUrlA) => {
        await withMtlsHttpServer(
          "server2",
          (req, res) => {
            if (req.url === "/api/v1/models") {
              res.writeHead(200, { "content-type": "application/json" });
              res.end(JSON.stringify({ data: [{ id: "gigachat-model-b", owned_by: "sber" }] }));
              return;
            }
            res.writeHead(404);
            res.end("not found");
          },
          async (baseUrlB) => {
            const connA = await providersDb.createProviderConnection({
              provider: `gigachat-compatible-${uniqueName("a")}`,
              authType: "apikey",
              name: uniqueName("giga-a"),
              providerSpecificData: { baseUrl: `${baseUrlA}/api/v1`, mtls: MTLS_CFG_A },
            });
            const connB = await providersDb.createProviderConnection({
              provider: `gigachat-compatible-${uniqueName("b")}`,
              authType: "apikey",
              name: uniqueName("giga-b"),
              providerSpecificData: { baseUrl: `${baseUrlB}/api/v1`, mtls: MTLS_CFG_B },
            });
            assert.ok(connA);
            assert.ok(connB);
            const idA = (connA as any).id;
            const idB = (connB as any).id;
            const providerA = (connA as any).provider;
            const providerB = (connB as any).provider;
            assert.notEqual(
              providerA,
              providerB,
              "each connection keeps its own unique provider id"
            );

            const resA = await route.GET(makeRequest(idA), {
              params: Promise.resolve({ id: idA }),
            });
            const resB = await route.GET(makeRequest(idB), {
              params: Promise.resolve({ id: idB }),
            });
            assert.equal(resA.status, 200);
            assert.equal(resB.status, 200);
            const bodyA = await resA.json();
            const bodyB = await resB.json();
            const idsA = bodyA.models.map((m: any) => m.id);
            const idsB = bodyB.models.map((m: any) => m.id);

            assert.deepEqual(
              idsA,
              ["gigachat-model-a"],
              "connection A only sees its own upstream model"
            );
            assert.deepEqual(
              idsB,
              ["gigachat-model-b"],
              "connection B only sees its own upstream model"
            );
            assert.ok(!idsA.includes("gigachat-model-b"), "no cross-connection leakage into A");
            assert.ok(!idsB.includes("gigachat-model-a"), "no cross-connection leakage into B");

            // DB-level assertion: no shared/legacy "gigachat" bucket is used —
            // each connection's cache lives under its own providerId:connectionId key.
            const cachedA = await modelsDb.getSyncedAvailableModelsForConnection(providerA, idA);
            const cachedB = await modelsDb.getSyncedAvailableModelsForConnection(providerB, idB);
            assert.deepEqual(
              cachedA.map((m) => m.id),
              ["gigachat-model-a"]
            );
            assert.deepEqual(
              cachedB.map((m) => m.id),
              ["gigachat-model-b"]
            );
            const legacyBucket = await modelsDb.getSyncedAvailableModelsForConnection(
              "gigachat",
              idA
            );
            assert.deepEqual(
              legacyBucket,
              [],
              "no bare 'gigachat' cache bucket receives these models"
            );

            // Invalidate connection A's cache only — B must be untouched.
            await modelsDb.deleteSyncedAvailableModelsForConnection(providerA, idA);
            const cachedAAfterDelete = await modelsDb.getSyncedAvailableModelsForConnection(
              providerA,
              idA
            );
            const cachedBAfterDelete = await modelsDb.getSyncedAvailableModelsForConnection(
              providerB,
              idB
            );
            assert.deepEqual(cachedAAfterDelete, [], "connection A's cache was cleared");
            assert.deepEqual(
              cachedBAfterDelete.map((m) => m.id),
              ["gigachat-model-b"],
              "connection B's cache is untouched by A's invalidation"
            );
          }
        );
      }
    );
  }
);

// Task 8 — a gigachat-compatible connection with apiVersion "v2" must discover
// models at `${base}/models` (relative to the /v2 base), NOT the v1 `/v1/models`
// path that would produce `.../v2/v1/models`.
serialTest("GET discovers v2 gigachat models at /v2/models, not /v2/v1/models", async () => {
  await withMtlsHttpServer(
    "server",
    (req, res) => {
      if (req.url === "/v2/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "GigaChat-2-Max", owned_by: "sber" }] }));
        return;
      }
      res.writeHead(404);
      res.end("not found");
    },
    async (baseUrl) => {
      const conn = await providersDb.createProviderConnection({
        provider: `gigachat-compatible-${uniqueName("v2")}`,
        authType: "apikey",
        name: uniqueName("giga-v2"),
        providerSpecificData: {
          baseUrl: `${baseUrl}/v2`,
          apiVersion: "v2",
          mtls: MTLS_CFG_A,
        },
      });
      assert.ok(conn);
      const id = (conn as any).id;

      const res = await route.GET(makeRequest(id), { params: Promise.resolve({ id }) });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.source, "api");
      assert.deepEqual(
        body.models.map((m: any) => m.id),
        ["GigaChat-2-Max"]
      );
    }
  );
});

test.after(() => {
  mtlsAgent.clearPool();
});

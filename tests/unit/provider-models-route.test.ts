import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-provider-model-routes-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const providerModelsRoute = await import("../../src/app/api/providers/[id]/models/route.ts");

const originalFetch = globalThis.fetch;
const originalAllowPrivateProviderUrls = process.env.OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS;

async function resetStorage() {
  globalThis.fetch = originalFetch;
  if (originalAllowPrivateProviderUrls === undefined) {
    delete process.env.OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS;
  } else {
    process.env.OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS = originalAllowPrivateProviderUrls;
  }
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function seedConnection(provider: string, overrides: Record<string, any> = {}) {
  return providersDb.createProviderConnection({
    provider,
    authType: overrides.authType || "apikey",
    name: overrides.name || `${provider}-${Math.random().toString(16).slice(2, 8)}`,
    apiKey: overrides.apiKey,
    accessToken: overrides.accessToken,
    projectId: overrides.projectId,
    isActive: overrides.isActive ?? true,
    testStatus: overrides.testStatus || "active",
    providerSpecificData: overrides.providerSpecificData || {},
  });
}

async function callRoute(connectionId, search = "") {
  return providerModelsRoute.GET(
    new Request(`http://localhost/api/providers/${connectionId}/models${search}`),
    { params: { id: connectionId } }
  );
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("provider models route returns 404 for unknown connections", async () => {
  const response = await callRoute("missing-connection");

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Connection not found" });
});

test("provider models route rejects connections with an empty provider id", async () => {
  const connection = await seedConnection("openai", {
    apiKey: "sk-openai",
  });
  const db = core.getDbInstance();

  await db.prepare("UPDATE provider_connections SET provider = '' WHERE id = ?").run(connection.id);

  const response = await callRoute(connection.id);

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid connection provider" });
});

test("provider models route rejects OpenAI-compatible providers without a base URL", async () => {
  const connection = await seedConnection("openai-compatible-demo", {
    apiKey: "sk-openai-compatible",
  });

  const response = await callRoute(connection.id);

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "No base URL configured for OpenAI compatible provider",
  });
});

test("provider models route blocks private OpenAI-compatible base URLs", async () => {
  delete process.env.OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS;

  const connection = await seedConnection("openai-compatible-private", {
    apiKey: "sk-openai-compatible",
    providerSpecificData: {
      baseUrl: "http://127.0.0.1:11434/v1",
    },
  });

  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return Response.json({ data: [] });
  };

  const response = await callRoute(connection.id);

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "Blocked private or local provider URL",
  });
  assert.equal(called, false);
});

test("provider models route returns auth failures from OpenAI-compatible upstreams", async () => {
  const connection = await seedConnection("openai-compatible-auth", {
    apiKey: "sk-openai-compatible",
    providerSpecificData: {
      baseUrl: "https://proxy.example.com/v1/chat/completions",
    },
  });
  const seenUrls = [];

  globalThis.fetch = async (url) => {
    seenUrls.push(String(url));
    return new Response("unauthorized", { status: 401 });
  };

  const response = await callRoute(connection.id);

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Auth failed: 401" });
  assert.equal(seenUrls.length, 1);
});

test("provider models route falls back after OpenAI-compatible endpoint probes all fail", async () => {
  const connection = await seedConnection("openai-compatible-fallback", {
    apiKey: "sk-openai-compatible",
    providerSpecificData: {
      baseUrl: "https://proxy.example.com/v1",
    },
  });
  const seenUrls = [];

  globalThis.fetch = async (url) => {
    seenUrls.push(String(url));
    return new Response("bad gateway", { status: 502 });
  };

  const response = await callRoute(connection.id);
  const body = (await response.json()) as any;

  assert.equal(response.status, 200);
  assert.equal(body.provider, "openai-compatible-fallback");
  assert.ok(Array.isArray(body.models));
  assert.ok(seenUrls.length >= 2);
});

test("provider models route retries transient OpenAI-compatible probe failures before succeeding", async () => {
  const connection = await seedConnection("openai-compatible-retry", {
    apiKey: "sk-openai-compatible",
    providerSpecificData: {
      baseUrl: "https://proxy.example.com/v1",
    },
  });
  const seenUrls = [];

  globalThis.fetch = async (url) => {
    seenUrls.push(String(url));
    if (seenUrls.length === 1) {
      throw new Error("temporary upstream failure");
    }

    return Response.json({
      data: [{ id: "demo-model", name: "Demo Model" }],
    });
  };

  const response = await callRoute(connection.id);
  const body = (await response.json()) as any;

  assert.equal(response.status, 200);
  assert.equal(body.source, "api");
  assert.deepEqual(seenUrls, [
    "https://proxy.example.com/v1/models",
    "https://proxy.example.com/v1/models",
  ]);
  assert.deepEqual(body.models, [{ id: "demo-model", name: "Demo Model" }]);
});

test("provider models route rejects unsupported providers without a models config", async () => {
  const connection = await seedConnection("unsupported-provider", {
    apiKey: "sk-unsupported",
  });

  const response = await callRoute(connection.id);

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "Provider unsupported-provider does not support models listing",
  });
});


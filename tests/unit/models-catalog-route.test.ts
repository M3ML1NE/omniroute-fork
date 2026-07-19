import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-model-catalog-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "catalog-test-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const modelsDb = await import("../../src/lib/db/models.ts");
const combosDb = await import("../../src/lib/db/combos.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const readCacheDb = await import("../../src/lib/db/readCache.ts");
const pgModule = await import("../../src/lib/db/postgres.ts");
const v1ModelsCatalog = await import("../../src/app/api/v1/models/catalog.ts");

const MUTABLE_TEST_TABLES = [
  "provider_connections",
  "provider_nodes",
  "combos",
  "api_keys",
  "key_value",
  "model_combo_mappings",
  "usage_history",
];

async function purgePostgresTables() {
  const schema = pgModule.getSchema();
  for (const table of MUTABLE_TEST_TABLES) {
    try {
      await pgModule.query(`TRUNCATE ${schema}.${table} CASCADE`);
    } catch {
      void table;
    }
  }
}

async function resetStorage() {
  await purgePostgresTables();
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  readCacheDb.invalidateDbCache();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function seedConnection(provider: string, overrides: Record<string, unknown> = {}) {
  return providersDb.createProviderConnection({
    provider,
    authType: (overrides.authType as string) || "apikey",
    name: (overrides.name as string) || `${provider}-${Math.random().toString(16).slice(2, 8)}`,
    apiKey: (overrides.apiKey as string) || "sk-test",
    accessToken: overrides.accessToken as string | undefined,
    isActive: (overrides.isActive as boolean) ?? true,
    testStatus: (overrides.testStatus as string) || "active",
    providerSpecificData: (overrides.providerSpecificData as Record<string, unknown>) || {},
  });
}

function capability(overrides = {}) {
  return {
    tool_call: null,
    reasoning: null,
    attachment: null,
    structured_output: null,
    temperature: null,
    modalities_input: JSON.stringify([]),
    modalities_output: JSON.stringify([]),
    knowledge_cutoff: null,
    release_date: null,
    last_updated: null,
    status: null,
    family: null,
    open_weights: null,
    limit_context: null,
    limit_input: null,
    limit_output: null,
    interleaved_field: null,
    ...overrides,
  };
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("v1 models catalog requires auth when the route is protected and login is enabled", async () => {
  await settingsDb.updateSettings({
    requireLogin: true,
    password: "hashed-password",
    requireAuthForModels: true,
  });

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as any;

  assert.equal(response.status, 401);
  assert.equal(body.error.code, "invalid_api_key");
  assert.match(body.error.message, /Authentication required/i);
});

test("v1 models catalog accepts bearer API keys and filters the list by allowed model patterns", async () => {
  await settingsDb.updateSettings({
    requireLogin: true,
    password: "hashed-password",
    requireAuthForModels: true,
  });
  await seedConnection("gigachat", { name: "gigachat-main" });
  await providersDb.createProviderNode({
    id: "openai-compatible-filtered",
    type: "openai-compatible",
    name: "Compatible Filtered",
    prefix: "cf-filter",
    baseUrl: "https://proxy.example.com",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
  });
  await seedConnection("openai-compatible-filtered", {
    name: "compat-filtered",
    providerSpecificData: {
      baseUrl: "https://proxy.example.com",
      chatPath: "/v1/chat/completions",
      modelsPath: "/v1/models",
    },
  });
  await modelsDb.addCustomModel("openai-compatible-filtered", "filtered-model", "Filtered Model");

  const key = await apiKeysDb.createApiKey("catalog-filter", "machine-catalog");
  await apiKeysDb.updateApiKeyPermissions(key.id, {
    allowedModels: ["cf-filter/*"],
  });

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models", {
      headers: { Authorization: `Bearer ${key.key}` },
    })
  );
  const body = (await response.json()) as any;
  const ids = body.data.map((item) => item.id);

  assert.equal(response.status, 200);
  assert.ok(ids.some((id) => id.startsWith("cf-filter/")));
  assert.equal(
    ids.some((id) => id.startsWith("gigachat/")),
    false
  );
});

test("v1 models catalog includes combos and custom models while excluding hidden models and blocked providers", async () => {
  await settingsDb.updateSettings({
    blockedProviders: ["gigachat"],
  });
  await providersDb.createProviderNode({
    id: "openai-compatible-custommodels",
    type: "openai-compatible",
    name: "Compatible Custom",
    prefix: "cc-custom",
    baseUrl: "https://proxy.example.com",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
  });
  await seedConnection("openai-compatible-custommodels", {
    name: "compat-custom",
    providerSpecificData: {
      baseUrl: "https://proxy.example.com",
      chatPath: "/v1/chat/completions",
      modelsPath: "/v1/models",
    },
  });
  await seedConnection("gigachat", {
    name: "gigachat-blocked",
    apiKey: "sk-blocked",
  });

  await modelsDb.addCustomModel("openai-compatible-custommodels", "custom-pl", "Custom PL");
  await combosDb.createCombo({
    name: "team-router",
    strategy: "priority",
    models: ["openai-compatible-custommodels/custom-pl"],
  });

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as any;
  const ids = new Set(body.data.map((item) => item.id));

  assert.equal(response.status, 200);
  assert.ok(ids.has("team-router"));
  assert.ok(ids.has("cc-custom/custom-pl"));
  assert.equal(
    [...ids].some((id) => (id as any).startsWith("gigachat/")),
    false
  );
});

test("v1 models catalog keeps only visible combos when no providers are active", async () => {
  const visible = await combosDb.createCombo({
    name: "visible-combo",
    strategy: "priority",
    models: ["openai/gpt-4o"],
  });
  await combosDb.updateCombo((visible as any).id, { context_length: 32000 });
  const hidden = await combosDb.createCombo({
    name: "hidden-combo",
    strategy: "priority",
    models: ["openai/gpt-4o"],
    isHidden: true,
  });
  const inactive = await combosDb.createCombo({
    name: "inactive-combo",
    strategy: "priority",
    models: ["openai/gpt-4o"],
  });
  await combosDb.updateCombo((inactive as any).id, { isActive: false });

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as any;

  assert.equal(response.status, 200);
  // The visible combo must be present (noAuth provider models may also appear — that is correct
  // behavior after the fix for Issue #2798, so we check membership rather than exact equality).
  const ids = body.data.map((item) => item.id);
  assert.ok(ids.includes(visible.name), "visible combo must appear");
  const visibleCombo = body.data.find((item) => item.id === visible.name);
  assert.ok(visibleCombo, "visible combo entry must exist");
  assert.equal(visibleCombo.context_length, 32000);
  assert.equal(
    body.data.some((item) => item.id === hidden.name),
    false
  );
  assert.equal(
    body.data.some((item) => item.id === inactive.name),
    false
  );
});

test("v1 models catalog keeps unknown combo targets visible without guessed metadata", async () => {
  await combosDb.createCombo({
    name: "unknown-router",
    strategy: "priority",
    models: ["openai/no-known-metadata"],
  });

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as any;
  const combo = body.data.find((item) => item.id === "unknown-router");

  assert.equal(response.status, 200);
  assert.ok(combo);
  assert.equal("context_length" in combo, false);
  assert.equal("max_input_tokens" in combo, false);
  assert.equal("max_output_tokens" in combo, false);
  assert.equal("input_modalities" in combo, false);
  assert.equal("output_modalities" in combo, false);
  assert.equal("capabilities" in combo, false);
});

test("v1 models catalog does not final-enrich combo names as real models", async () => {
  await combosDb.createCombo({
    name: "gpt-5.5",
    strategy: "priority",
    models: ["openai/no-known-metadata"],
  });

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as any;
  const combo = body.data.find((item) => item.id === "gpt-5.5");

  assert.equal(response.status, 200);
  assert.ok(combo);
  assert.equal(combo.owned_by, "combo");
  assert.equal("max_output_tokens" in combo, false);
  assert.equal("capabilities" in combo, false);
});

test("v1 models catalog uses provider-node prefixes for compatible provider custom models", async () => {
  await providersDb.createProviderNode({
    id: "openai-compatible-demo",
    type: "openai-compatible",
    name: "OpenAI Demo",
    prefix: "cm",
    baseUrl: "https://proxy.example.com",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
  });
  await seedConnection("openai-compatible-demo", {
    name: "compat-node",
    providerSpecificData: {
      baseUrl: "https://proxy.example.com",
      chatPath: "/v1/chat/completions",
      modelsPath: "/v1/models",
    },
  });
  await modelsDb.addCustomModel("openai-compatible-demo", "edge-model", "Edge Model");

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as any;
  const ids = new Set(body.data.map((item) => item.id));

  assert.equal(response.status, 200);
  assert.ok(ids.has("cm/edge-model"));
  assert.equal(ids.has("openai-compatible-demo/edge-model"), false);
});

test("v1 models catalog includes synced provider models from discovery cache", async () => {
  await providersDb.createProviderNode({
    id: "openai-compatible-synced",
    type: "openai-compatible",
    name: "Compatible Synced",
    prefix: "cs",
    baseUrl: "https://proxy.example.com",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
  });
  const connection = await seedConnection("openai-compatible-synced", {
    name: "compat-synced",
    providerSpecificData: {
      baseUrl: "https://proxy.example.com",
      chatPath: "/v1/chat/completions",
      modelsPath: "/v1/models",
    },
  });

  await modelsDb.replaceSyncedAvailableModelsForConnection(
    "openai-compatible-synced",
    (connection as any).id,
    [
      {
        id: "glm-5.1",
        name: "GLM 5.1",
        source: "imported",
        supportedEndpoints: ["chat"],
        inputTokenLimit: 262144,
      },
    ]
  );

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as any;
  const syncedModel = body.data.find((item) => item.id === "cs/glm-5.1");

  assert.equal(response.status, 200);
  assert.ok(syncedModel);
  assert.equal(syncedModel.context_length, 262144);
});

test("v1 models catalog falls back to getTokenLimit for models without registry defaultContextLength", async () => {
  await providersDb.createProviderNode({
    id: "openai-compatible-ctxfallback",
    type: "openai-compatible",
    name: "Compatible Ctx Fallback",
    prefix: "cf",
    baseUrl: "https://proxy.example.com",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
  });
  const connection = await seedConnection("openai-compatible-ctxfallback", {
    name: "compat-ctx-fallback",
    providerSpecificData: {
      baseUrl: "https://proxy.example.com",
      chatPath: "/v1/chat/completions",
      modelsPath: "/v1/models",
    },
  });

  await modelsDb.replaceSyncedAvailableModelsForConnection(
    "openai-compatible-ctxfallback",
    (connection as any).id,
    [
      {
        id: "test-model-no-context",
        name: "Test Model No Context",
        source: "imported",
        supportedEndpoints: ["chat"],
      },
    ]
  );

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as any;
  const model = body.data.find((item) => item.id === "cf/test-model-no-context");

  assert.equal(response.status, 200);
  assert.ok(model, "synced model should appear");
  assert.ok(
    typeof model.context_length === "number" && model.context_length > 0,
    `synced model without inputTokenLimit should get context_length via getTokenLimit fallback, got ${model.context_length}`
  );
});

test("v1 models catalog prefers manual combo context_length over auto-calculated", async () => {
  await seedConnection("gigachat", { name: "gigachat-manual-context" });

  const combo = await combosDb.createCombo({
    name: "manual-context-combo",
    strategy: "priority",
    models: ["gigachat/GigaChat-2-Max"],
  });
  await combosDb.updateCombo((combo as any).id, { context_length: 64000 });

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as any;
  const comboModel = body.data.find((item) => item.id === "manual-context-combo");

  assert.equal(response.status, 200);
  assert.ok(comboModel);
  assert.equal(comboModel.context_length, 64000, "manual context_length should override auto-calc");
});

// Regression test for Issue #2798: noAuth providers (opencode/oc) have no DB connection rows
// but their models must still appear in /v1/models.

test("v1 models catalog never emits a model owned_by a non-live provider (sole-source contract)", async () => {
  await providersDb.createProviderNode({
    id: "openai-compatible-solesource",
    type: "openai-compatible",
    name: "Sole Source",
    prefix: "ss",
    baseUrl: "https://proxy.example.com",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
  });
  const connection = await seedConnection("openai-compatible-solesource", {
    name: "compat-sole-source",
    providerSpecificData: {
      baseUrl: "https://proxy.example.com",
      chatPath: "/v1/chat/completions",
      modelsPath: "/v1/models",
    },
  });
  await modelsDb.replaceSyncedAvailableModelsForConnection(
    "openai-compatible-solesource",
    (connection as any).id,
    [
      {
        id: "live-model",
        name: "Live Model",
        source: "imported",
        supportedEndpoints: ["chat"],
        inputTokenLimit: 128000,
      },
    ]
  );
  await combosDb.createCombo({
    name: "sole-source-combo",
    strategy: "priority",
    models: ["openai-compatible-solesource/live-model"],
  });

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as any;

  assert.equal(response.status, 200);

  const liveProviders = new Set(
    (await providersDb.getProviderConnections()).map((c: any) => c.provider)
  );
  const allowedOwners = new Set<string>([...liveProviders, "ss", "combo"]);

  for (const model of body.data) {
    assert.ok(
      allowedOwners.has(model.owned_by),
      `model ${model.id} has owned_by="${model.owned_by}" which is neither a live provider connection nor "combo"`
    );
  }

  const ids = new Set(body.data.map((item: any) => item.id));
  assert.ok(ids.has("ss/live-model"), "live synced model must appear");
  assert.ok(ids.has("sole-source-combo"), "combo must appear");

  // No static named-provider model must ever leak into the catalog.
  const staticLeak = body.data.find(
    (m: any) =>
      typeof m.owned_by === "string" &&
      ["openai", "anthropic", "gemini", "openrouter", "reka", "deepgram"].includes(m.owned_by)
  );
  assert.equal(staticLeak, undefined, "no static named-provider model may be emitted");
});

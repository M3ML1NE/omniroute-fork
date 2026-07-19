import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-builder-options-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const pgModule = await import("../../src/lib/db/postgres.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const modelsDb = await import("../../src/lib/db/models.ts");
const builderOptions = await import("../../src/lib/combos/builderOptions.ts");

const RUN_PREFIX = `builder-opts-${process.pid}`;

function serialTest(name: string, fn: () => Promise<void>) {
  test(name, { concurrency: false }, fn);
}

const createdNodeIds: string[] = [];
const createdConnectionIds: string[] = [];

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
  createdNodeIds.length = 0;
  createdConnectionIds.length = 0;
});

test.after(async () => {
  await resetStorage();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function uniqueName(suffix: string): string {
  return `${RUN_PREFIX}-${suffix}-${Math.random().toString(16).slice(2, 8)}`;
}

async function createOpenAiCompatibleNode(suffix: string) {
  const node = await providersDb.createProviderNode({
    id: `openai-compatible-${uniqueName(suffix)}`,
    type: "openai-compatible",
    name: uniqueName(suffix),
    prefix: uniqueName(`${suffix}-prefix`),
    apiType: "openai",
    baseUrl: "https://example.invalid/v1",
  });
  createdNodeIds.push(node.id as string);
  return node;
}

test.after(async () => {
  for (const id of createdNodeIds) {
    await providersDb.deleteProviderNode(id).catch(() => {});
  }
  for (const id of createdConnectionIds) {
    await providersDb.deleteProviderConnection(id).catch(() => {});
  }
});

serialTest(
  "getComboBuilderOptions lists an openai-compatible node with zero connections",
  async () => {
    const node = await createOpenAiCompatibleNode("zero-conn");

    const options = await builderOptions.getComboBuilderOptions();
    const providerOption = options.providers.find((p) => p.providerId === node.id);

    assert.ok(providerOption, "connection-less compatible node must appear in providers");
    assert.equal(providerOption?.connectionCount, 0);
    assert.equal(providerOption?.activeConnectionCount, 0);
    assert.deepEqual(providerOption?.connections, []);
    assert.equal(providerOption?.acceptsArbitraryModel, true);
  }
);

serialTest(
  "getComboBuilderOptions does not duplicate a compatible node that has a connection",
  async () => {
    const node = await createOpenAiCompatibleNode("with-conn");
    const connection = await providersDb.createProviderConnection({
      provider: node.id,
      authType: "apikey",
      name: uniqueName("conn"),
      apiKey: "test-key",
      isActive: true,
    });
    createdConnectionIds.push(connection.id as string);

    const options = await builderOptions.getComboBuilderOptions();
    const matches = options.providers.filter((p) => p.providerId === node.id);

    assert.equal(matches.length, 1, "provider must appear exactly once");
    assert.equal(matches[0].connectionCount, 1);
  }
);

serialTest(
  "getComboBuilderOptions surfaces synced models for a connection-less compatible node",
  async () => {
    const node = await createOpenAiCompatibleNode("synced-models");
    await modelsDb.replaceSyncedAvailableModelsForConnection(node.id as string, "discovery", [
      { id: "gpt-test-model", name: "GPT Test Model" },
    ]);

    const options = await builderOptions.getComboBuilderOptions();
    const providerOption = options.providers.find((p) => p.providerId === node.id);

    assert.ok(providerOption, "connection-less compatible node must appear in providers");
    const modelIds = (providerOption?.models || []).map((m) => m.id);
    assert.ok(
      modelIds.includes("gpt-test-model"),
      `expected synced model in ${JSON.stringify(modelIds)}`
    );
  }
);

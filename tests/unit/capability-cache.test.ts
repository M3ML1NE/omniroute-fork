import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-capability-cache-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const pgModule = await import("../../src/lib/db/postgres.ts");
const discovery = await import("../../src/lib/providerModels/modelDiscovery.ts");
const capabilityCache = await import("../../src/lib/providerModels/capabilityCache.ts");
const modelCapabilities = await import("../../src/lib/modelCapabilities.ts");
const combo = await import("../../open-sse/services/combo.ts");

const PROVIDER = "gigachat-compatible-captest";
const CONNECTION = "conn-1";

function serialTest(name: string, fn: () => Promise<void>) {
  test(name, { concurrency: false }, fn);
}

async function resetStorage() {
  const schema = pgModule.getSchema();
  await pgModule.query(
    `DELETE FROM ${schema}.key_value WHERE namespace = 'syncedAvailableModels' AND key LIKE $1`,
    [`${PROVIDER}%`]
  );
  core.resetDbInstance();
  capabilityCache.__resetCapabilityCacheForTests();
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  await resetStorage();
});

const noopLog = {
  info: () => {},
  warn: () => {},
  debug: () => {},
};

function modelTarget(modelStr: string) {
  return {
    kind: "model" as const,
    stepId: modelStr,
    executionKey: modelStr,
    modelStr,
    provider: PROVIDER,
    providerId: PROVIDER,
    connectionId: CONNECTION,
    weight: 1,
    label: null,
  };
}

serialTest("discovered limits populate resolved capabilities", async () => {
  await discovery.persistDiscoveredModels(PROVIDER, CONNECTION, [
    {
      id: "GigaChat-2-Max",
      name: "GigaChat 2 Max",
      inputTokenLimit: 32000,
      outputTokenLimit: 4096,
    },
  ]);
  await capabilityCache.refreshCapabilityCache();

  const caps = modelCapabilities.getResolvedModelCapabilities({
    provider: PROVIDER,
    model: "GigaChat-2-Max",
  });
  // Discovery reports input/output token limits; `limit_input` drives
  // `maxInputTokens`, which is what the combo context-window filter reads.
  assert.equal(caps.maxInputTokens, 32000);
  assert.equal(caps.maxOutputTokens, 4096);
});

serialTest("unknown model stays fail-open (all-null limits)", async () => {
  await discovery.persistDiscoveredModels(PROVIDER, CONNECTION, [
    { id: "GigaChat-2-Max", name: "GigaChat 2 Max", inputTokenLimit: 32000 },
  ]);
  await capabilityCache.refreshCapabilityCache();

  const caps = modelCapabilities.getResolvedModelCapabilities({
    provider: PROVIDER,
    model: "does-not-exist",
  });
  assert.equal(caps.contextWindow, null);
  assert.equal(caps.maxInputTokens, null);
  assert.equal(caps.supportsTools, null);
  assert.equal(modelCapabilities.getModelContextLimit(PROVIDER, "does-not-exist"), null);
});

serialTest("case-insensitive model match resolves discovered limits", async () => {
  await discovery.persistDiscoveredModels(PROVIDER, CONNECTION, [
    { id: "GigaChat-2-Max", name: "GigaChat 2 Max", inputTokenLimit: 32000 },
  ]);
  await capabilityCache.refreshCapabilityCache();

  const caps = modelCapabilities.getResolvedModelCapabilities({
    provider: PROVIDER,
    model: "gigachat-2-max",
  });
  assert.equal(caps.maxInputTokens, 32000);
});

serialTest("combo filter rejects target whose discovered window is too small", async () => {
  await discovery.persistDiscoveredModels(PROVIDER, CONNECTION, [
    { id: "tiny-model", name: "Tiny", inputTokenLimit: 1000 },
    { id: "big-model", name: "Big", inputTokenLimit: 1000000 },
  ]);
  await capabilityCache.refreshCapabilityCache();

  const bigMessage = "word ".repeat(5000);
  const body = {
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: bigMessage },
    ],
    max_tokens: 256,
  };

  const targets = [modelTarget(`${PROVIDER}/tiny-model`), modelTarget(`${PROVIDER}/big-model`)];
  const kept = combo.filterTargetsByRequestCompatibility(targets, body, noopLog);

  assert.equal(kept.length, 1);
  assert.equal(kept[0].modelStr, `${PROVIDER}/big-model`);
});

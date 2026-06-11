import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-config-hot-reload-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.OMNIROUTE_CONFIG_HOT_RELOAD_MS = "100";

const core = await import("../../src/lib/db/core.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const { getDbInstance } = core;
const { applyRuntimeSettings, resetRuntimeSettingsStateForTests } =
  await import("../../src/lib/config/runtimeSettings.ts");
const { startRuntimeConfigHotReload, stopRuntimeConfigHotReloadForTests } =
  await import("../../src/lib/config/hotReload.ts");
const { getCustomAliases, setCustomAliases } =
  await import("../../open-sse/services/modelDeprecation.ts");
const {
  getBackgroundDegradationConfig,
  getDefaultDegradationMap,
  getDefaultDetectionPatterns,
  setBackgroundDegradationConfig,
} = await import("../../open-sse/services/backgroundTaskDetector.ts");
const { clearGeminiThoughtSignatures } = await import(
  "../../open-sse/services/geminiThoughtSignatureStore.ts"
);
const { getPayloadRulesConfig, resetPayloadRulesConfigForTests } =
  await import("../../open-sse/services/payloadRules.ts");
const { getCacheControlSettings, invalidateCacheControlSettingsCache } =
  await import("../../src/lib/cacheControlSettings.ts");

async function resetStorage() {
  stopRuntimeConfigHotReloadForTests();
  resetRuntimeSettingsStateForTests();
  resetPayloadRulesConfigForTests();
  clearGeminiThoughtSignatures();
  setCustomAliases({});
  setBackgroundDegradationConfig({
    enabled: false,
    degradationMap: getDefaultDegradationMap(),
    detectionPatterns: getDefaultDetectionPatterns(),
  });
  invalidateCacheControlSettingsCache();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.fail("Timed out waiting for hot-reload condition");
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  await resetStorage();
});

test("updateSettings applies runtime settings incrementally without restart", async () => {
  await applyRuntimeSettings(await settingsDb.getSettings(), {
    force: true,
    source: "test:startup",
  });

  await settingsDb.updateSettings({
    modelAliases: JSON.stringify({ "team-default": "openai/gpt-4o-mini" }),
    backgroundDegradation: {
      enabled: true,
      degradationMap: { "gpt-4o": "gpt-4o-mini" },
      detectionPatterns: ["summarize this"],
    },
    payloadRules: {
      override: [
        {
          models: [{ name: "gpt-*", protocol: "openai" }],
          params: { temperature: 0.1 },
        },
      ],
    },
    alwaysPreserveClientCache: "always",
  });

  assert.deepEqual(getCustomAliases(), { "team-default": "openai/gpt-4o-mini" });
  assert.equal(getBackgroundDegradationConfig().enabled, true);
  assert.equal(getBackgroundDegradationConfig().degradationMap["gpt-4o"], "gpt-4o-mini");
  assert.deepEqual(getBackgroundDegradationConfig().detectionPatterns, ["summarize this"]);
  assert.equal((await getPayloadRulesConfig()).override[0].params.temperature, 0.1);
  assert.equal(await getCacheControlSettings(), "always");

  await settingsDb.updateSettings({
    modelAliases: {},
    backgroundDegradation: null,
    payloadRules: null,
    alwaysPreserveClientCache: "auto",
  });

  assert.deepEqual(getCustomAliases(), {});
  assert.equal(getBackgroundDegradationConfig().enabled, false);
  assert.equal((await getPayloadRulesConfig()).override.length, 0);
  assert.equal(await getCacheControlSettings(), "auto");
});

test("hot-reload watcher picks up external sqlite changes via polling fallback", async () => {
  await applyRuntimeSettings(await settingsDb.getSettings(), {
    force: true,
    source: "test:startup",
  });
  startRuntimeConfigHotReload({ pollIntervalMs: 100 });

  const db = getDbInstance();
  await db
    .prepare(
      "INSERT INTO key_value (namespace, key, value) VALUES ('settings', 'alwaysPreserveClientCache', ?) " +
        "ON CONFLICT (namespace, key) DO UPDATE SET value = EXCLUDED.value"
    )
    .run(JSON.stringify("always"));

  await waitFor(async () => (await getCacheControlSettings()) === "always");
});

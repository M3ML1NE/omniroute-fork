import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-db-models-v2-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const pgModule = await import("../../src/lib/db/postgres.ts");
const modelsDb = await import("../../src/lib/db/models.ts");

const RUN_PREFIX = `db-models-v2-${process.pid}`;

function serialTest(name: string, fn: () => Promise<void>) {
  test(name, { concurrency: false }, fn);
}

async function resetStorage() {
  const schema = pgModule.getSchema();
  for (const namespace of [
    "modelCompatOverrides",
    "modelAliases",
    "mitmAlias",
    "customModels",
    "syncedAvailableModels",
  ]) {
    await pgModule.query(`DELETE FROM ${schema}.key_value WHERE namespace = $1 AND key LIKE $2`, [
      namespace,
      `${RUN_PREFIX}-%`,
    ]);
  }
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

// ── Model Compat Overrides ────────────────────────────────────────────────

serialTest("getModelCompatOverrides returns [] for a provider with no overrides", async () => {
  const list = await modelsDb.getModelCompatOverrides(`${RUN_PREFIX}-provider`);
  assert.deepEqual(list, []);
});

serialTest("mergeModelCompatOverride persists normalizeToolCallId", async () => {
  const providerId = `${RUN_PREFIX}-provider-a`;
  await modelsDb.mergeModelCompatOverride(providerId, "model-1", {
    normalizeToolCallId: true,
  });

  const list = await modelsDb.getModelCompatOverrides(providerId);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "model-1");
  assert.equal(list[0].normalizeToolCallId, true);
});

serialTest("mergeModelCompatOverride unsets normalizeToolCallId when patched to false", async () => {
  const providerId = `${RUN_PREFIX}-provider-b`;
  await modelsDb.mergeModelCompatOverride(providerId, "model-1", { normalizeToolCallId: true });
  await modelsDb.mergeModelCompatOverride(providerId, "model-1", { normalizeToolCallId: false });

  const list = await modelsDb.getModelCompatOverrides(providerId);
  // An entry with no meaningful flags set is pruned entirely.
  assert.equal(list.length, 0);
});

serialTest("mergeModelCompatOverride handles preserveOpenAIDeveloperRole null (unset) vs boolean", async () => {
  const providerId = `${RUN_PREFIX}-provider-c`;
  await modelsDb.mergeModelCompatOverride(providerId, "model-1", {
    preserveOpenAIDeveloperRole: false,
  });
  let list = await modelsDb.getModelCompatOverrides(providerId);
  assert.equal(list[0].preserveOpenAIDeveloperRole, false);

  await modelsDb.mergeModelCompatOverride(providerId, "model-1", {
    preserveOpenAIDeveloperRole: null,
  });
  list = await modelsDb.getModelCompatOverrides(providerId);
  assert.equal(list.length, 0);
});

serialTest("mergeModelCompatOverride sanitizes and persists upstreamHeaders", async () => {
  const providerId = `${RUN_PREFIX}-provider-d`;
  await modelsDb.mergeModelCompatOverride(providerId, "model-1", {
    upstreamHeaders: { "X-Custom-Header": "value" },
  });

  const list = await modelsDb.getModelCompatOverrides(providerId);
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].upstreamHeaders, { "X-Custom-Header": "value" });
});

serialTest("mergeModelCompatOverride persists isHidden and removeModelCompatOverride clears the entry", async () => {
  const providerId = `${RUN_PREFIX}-provider-e`;
  await modelsDb.mergeModelCompatOverride(providerId, "model-1", { isHidden: true });
  let list = await modelsDb.getModelCompatOverrides(providerId);
  assert.equal(list[0].isHidden, true);

  await modelsDb.removeModelCompatOverride(providerId, "model-1");
  list = await modelsDb.getModelCompatOverrides(providerId);
  assert.equal(list.length, 0);
});

serialTest("removeModelCompatOverride is a no-op when the model has no override", async () => {
  const providerId = `${RUN_PREFIX}-provider-f`;
  await assert.doesNotReject(modelsDb.removeModelCompatOverride(providerId, "nonexistent-model"));
});

// ── Model Aliases ──────────────────────────────────────────────────────────

serialTest("setModelAlias / getModelAliases / deleteModelAlias round-trip", async () => {
  const alias = `${RUN_PREFIX}-my-alias`;
  await modelsDb.setModelAlias(alias, { provider: "openai", model: "gpt-4o" });

  const aliases = await modelsDb.getModelAliases();
  assert.deepEqual(aliases[alias], { provider: "openai", model: "gpt-4o" });

  await modelsDb.deleteModelAlias(alias);
  const afterDelete = await modelsDb.getModelAliases();
  assert.equal(afterDelete[alias], undefined);
});

// ── MITM Alias (generic key_value namespace helper, unrelated to the removed
// src/mitm/ proxy subsystem — this fork never had one) ─────────────────────

serialTest("setMitmAliasAll / getMitmAlias round-trip for a single tool", async () => {
  const toolName = `${RUN_PREFIX}-tool`;
  await modelsDb.setMitmAliasAll(toolName, { "gpt-4": "gpt-4o" });

  const result = await modelsDb.getMitmAlias(toolName);
  assert.deepEqual(result, { "gpt-4": "gpt-4o" });
});

serialTest("getMitmAlias without a toolName returns all tools' mappings", async () => {
  const toolA = `${RUN_PREFIX}-tool-a`;
  const toolB = `${RUN_PREFIX}-tool-b`;
  await modelsDb.setMitmAliasAll(toolA, { x: "y" });
  await modelsDb.setMitmAliasAll(toolB, { a: "b" });

  const all = await modelsDb.getMitmAlias();
  assert.deepEqual(all[toolA], { x: "y" });
  assert.deepEqual(all[toolB], { a: "b" });
});

serialTest("getMitmAlias returns {} for an unknown tool name", async () => {
  const result = await modelsDb.getMitmAlias(`${RUN_PREFIX}-unknown-tool`);
  assert.deepEqual(result, {});
});

// ── Custom Models ────────────────────────────────────────────────────────

serialTest("addCustomModel creates a model and getCustomModels returns it", async () => {
  const providerId = `${RUN_PREFIX}-cm-provider-a`;
  const created = await modelsDb.addCustomModel(providerId, "my-model", "My Model");

  assert.equal(created.id, "my-model");
  assert.equal(created.name, "My Model");
  assert.equal(created.source, "manual");

  const models = await modelsDb.getCustomModels(providerId);
  assert.equal(models.length, 1);
  assert.equal(models[0].id, "my-model");
});

serialTest("addCustomModel returns the existing entry instead of duplicating when the id already exists", async () => {
  const providerId = `${RUN_PREFIX}-cm-provider-b`;
  await modelsDb.addCustomModel(providerId, "dup-model", "First Name");
  const second = await modelsDb.addCustomModel(providerId, "dup-model", "Second Name");

  assert.equal(second.name, "First Name");
  const models = await modelsDb.getCustomModels(providerId);
  assert.equal(models.length, 1);
});

serialTest("getCustomModels without a providerId returns the full namespace map", async () => {
  const providerA = `${RUN_PREFIX}-cm-provider-c`;
  const providerB = `${RUN_PREFIX}-cm-provider-d`;
  await modelsDb.addCustomModel(providerA, "model-a");
  await modelsDb.addCustomModel(providerB, "model-b");

  const all = await modelsDb.getCustomModels();
  assert.ok(Array.isArray(all[providerA]));
  assert.ok(Array.isArray(all[providerB]));
});

serialTest("getAllCustomModels returns the same shape as getCustomModels() with no args", async () => {
  const providerId = `${RUN_PREFIX}-cm-provider-e`;
  await modelsDb.addCustomModel(providerId, "model-x");

  const all = await modelsDb.getAllCustomModels();
  assert.ok(Array.isArray(all[providerId]));
});

serialTest("removeCustomModel removes a model and cleans up its compat override", async () => {
  const providerId = `${RUN_PREFIX}-cm-provider-f`;
  await modelsDb.addCustomModel(providerId, "removable-model");
  await modelsDb.mergeModelCompatOverride(providerId, "removable-model", {
    normalizeToolCallId: true,
  });

  const removed = await modelsDb.removeCustomModel(providerId, "removable-model");
  assert.equal(removed, true);

  const models = await modelsDb.getCustomModels(providerId);
  assert.equal(models.length, 0);
  const overrides = await modelsDb.getModelCompatOverrides(providerId);
  assert.equal(overrides.length, 0);
});

serialTest("removeCustomModel returns false for a provider/model that does not exist", async () => {
  const removed = await modelsDb.removeCustomModel(`${RUN_PREFIX}-cm-none`, "nonexistent");
  assert.equal(removed, false);
});

serialTest("replaceCustomModels skips the destructive clear when given an empty list without allowEmpty", async () => {
  const providerId = `${RUN_PREFIX}-cm-provider-g`;
  await modelsDb.addCustomModel(providerId, "preserved-model");

  const result = await modelsDb.replaceCustomModels(providerId, []);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "preserved-model");
});

serialTest("replaceCustomModels clears all models when allowEmpty is explicitly set", async () => {
  const providerId = `${RUN_PREFIX}-cm-provider-h`;
  await modelsDb.addCustomModel(providerId, "cleared-model");

  const result = await modelsDb.replaceCustomModels(providerId, [], { allowEmpty: true });
  assert.equal(result.length, 0);
  const models = await modelsDb.getCustomModels(providerId);
  assert.equal(models.length, 0);
});

serialTest("replaceCustomModels preserves prior compat flags for models that still exist after replace", async () => {
  const providerId = `${RUN_PREFIX}-cm-provider-i`;
  await modelsDb.addCustomModel(providerId, "kept-model", "Old Name");
  // Simulate a prior sync having already tagged this model with a compat flag
  // baked directly into the customModels row (as replaceCustomModels reads it).
  await modelsDb.replaceCustomModels(providerId, [
    { id: "kept-model", name: "New Name", inputTokenLimit: 8000 },
  ]);

  const models = await modelsDb.getCustomModels(providerId);
  const kept = models.find((m: { id: string }) => m.id === "kept-model");
  assert.ok(kept);
  assert.equal(kept.name, "New Name");
  assert.equal(kept.inputTokenLimit, 8000);
});

// ── Hidden-model checks ──────────────────────────────────────────────────

serialTest("getModelIsHidden is false by default and true after a compat-override isHidden flag", async () => {
  const providerId = `${RUN_PREFIX}-hidden-provider`;
  assert.equal(await modelsDb.getModelIsHidden(providerId, "model-1"), false);

  await modelsDb.mergeModelCompatOverride(providerId, "model-1", { isHidden: true });
  assert.equal(await modelsDb.getModelIsHidden(providerId, "model-1"), true);
});

serialTest("buildModelHiddenChecker returns a sync predicate consistent with getModelIsHidden", async () => {
  const providerId = `${RUN_PREFIX}-hidden-checker-provider`;
  await modelsDb.mergeModelCompatOverride(providerId, "hidden-model", { isHidden: true });

  const isHidden = await modelsDb.buildModelHiddenChecker(providerId);
  assert.equal(isHidden("hidden-model"), true);
  assert.equal(isHidden("visible-model"), false);
});

// ── Per-model / per-protocol flags ────────────────────────────────────────

serialTest("getModelNormalizeToolCallId reads the compat-override flag when no custom model row exists", async () => {
  const providerId = `${RUN_PREFIX}-norm-provider`;
  assert.equal(await modelsDb.getModelNormalizeToolCallId(providerId, "model-1"), false);

  await modelsDb.mergeModelCompatOverride(providerId, "model-1", { normalizeToolCallId: true });
  assert.equal(await modelsDb.getModelNormalizeToolCallId(providerId, "model-1"), true);
});

serialTest("getModelPreserveOpenAIDeveloperRole returns undefined when unset, boolean when set", async () => {
  const providerId = `${RUN_PREFIX}-preserve-provider`;
  assert.equal(
    await modelsDb.getModelPreserveOpenAIDeveloperRole(providerId, "model-1"),
    undefined
  );

  await modelsDb.mergeModelCompatOverride(providerId, "model-1", {
    preserveOpenAIDeveloperRole: false,
  });
  assert.equal(
    await modelsDb.getModelPreserveOpenAIDeveloperRole(providerId, "model-1"),
    false
  );
});

serialTest("getModelUpstreamExtraHeaders returns {} for a model with no overrides, and the merged headers when set", async () => {
  const providerId = `${RUN_PREFIX}-headers-provider`;
  const empty = await modelsDb.getModelUpstreamExtraHeaders(providerId, "model-1");
  assert.deepEqual(empty, {});

  await modelsDb.mergeModelCompatOverride(providerId, "model-1", {
    upstreamHeaders: { "X-Api-Version": "2024-01" },
  });
  const withHeaders = await modelsDb.getModelUpstreamExtraHeaders(providerId, "model-1");
  assert.deepEqual(withHeaders, { "X-Api-Version": "2024-01" });
});

// ── Synced Available Models ───────────────────────────────────────────────

serialTest("replaceSyncedAvailableModelsForConnection / getSyncedAvailableModelsForConnection round-trip", async () => {
  const providerId = `${RUN_PREFIX}-sync-provider-a`;
  const connectionId = `${RUN_PREFIX}-conn-a`;
  await modelsDb.replaceSyncedAvailableModelsForConnection(providerId, connectionId, [
    { id: "model-1", name: "Model One" },
  ]);

  const models = await modelsDb.getSyncedAvailableModelsForConnection(providerId, connectionId);
  assert.equal(models.length, 1);
  assert.equal(models[0].id, "model-1");
  assert.equal(models[0].source, "imported");
});

serialTest("getSyncedAvailableModelsForConnection returns [] for a connection with no synced models", async () => {
  const models = await modelsDb.getSyncedAvailableModelsForConnection(
    `${RUN_PREFIX}-sync-none`,
    `${RUN_PREFIX}-conn-none`
  );
  assert.deepEqual(models, []);
});

serialTest("getSyncedAvailableModels unions and dedups models across connections for the same provider", async () => {
  const providerId = `${RUN_PREFIX}-sync-provider-b`;
  await modelsDb.replaceSyncedAvailableModelsForConnection(providerId, "conn-1", [
    { id: "shared-model", name: "Shared" },
    { id: "conn1-only", name: "Conn1 Only" },
  ]);
  await modelsDb.replaceSyncedAvailableModelsForConnection(providerId, "conn-2", [
    { id: "shared-model", name: "Shared (dup)" },
    { id: "conn2-only", name: "Conn2 Only" },
  ]);

  const union = await modelsDb.getSyncedAvailableModels(providerId);
  const ids = union.map((m) => m.id).sort();
  assert.deepEqual(ids, ["conn1-only", "conn2-only", "shared-model"]);
});

serialTest("getSyncedAvailableModelsByConnection returns a per-connection breakdown", async () => {
  const providerId = `${RUN_PREFIX}-sync-provider-c`;
  await modelsDb.replaceSyncedAvailableModelsForConnection(providerId, "conn-x", [
    { id: "model-x", name: "X" },
  ]);
  await modelsDb.replaceSyncedAvailableModelsForConnection(providerId, "conn-y", [
    { id: "model-y", name: "Y" },
  ]);

  const byConnection = await modelsDb.getSyncedAvailableModelsByConnection(providerId);
  assert.equal(byConnection["conn-x"]?.[0]?.id, "model-x");
  assert.equal(byConnection["conn-y"]?.[0]?.id, "model-y");
});

serialTest("getAllSyncedAvailableModels groups models by providerId across all providers", async () => {
  const providerA = `${RUN_PREFIX}-sync-provider-d`;
  const providerB = `${RUN_PREFIX}-sync-provider-e`;
  await modelsDb.replaceSyncedAvailableModelsForConnection(providerA, "conn-1", [
    { id: "a-model", name: "A" },
  ]);
  await modelsDb.replaceSyncedAvailableModelsForConnection(providerB, "conn-1", [
    { id: "b-model", name: "B" },
  ]);

  const all = await modelsDb.getAllSyncedAvailableModels();
  assert.equal(all[providerA]?.[0]?.id, "a-model");
  assert.equal(all[providerB]?.[0]?.id, "b-model");
});

serialTest("replaceSyncedAvailableModelsForConnection with an empty list deletes the connection's row", async () => {
  const providerId = `${RUN_PREFIX}-sync-provider-f`;
  const connectionId = `${RUN_PREFIX}-conn-clear`;
  await modelsDb.replaceSyncedAvailableModelsForConnection(providerId, connectionId, [
    { id: "temp-model", name: "Temp" },
  ]);
  await modelsDb.replaceSyncedAvailableModelsForConnection(providerId, connectionId, []);

  const models = await modelsDb.getSyncedAvailableModelsForConnection(providerId, connectionId);
  assert.deepEqual(models, []);
});

serialTest("deleteSyncedAvailableModelsForConnection removes only that connection's models", async () => {
  const providerId = `${RUN_PREFIX}-sync-provider-g`;
  await modelsDb.replaceSyncedAvailableModelsForConnection(providerId, "conn-keep", [
    { id: "keep-model", name: "Keep" },
  ]);
  await modelsDb.replaceSyncedAvailableModelsForConnection(providerId, "conn-remove", [
    { id: "remove-model", name: "Remove" },
  ]);

  await modelsDb.deleteSyncedAvailableModelsForConnection(providerId, "conn-remove");

  const remaining = await modelsDb.getSyncedAvailableModels(providerId);
  const ids = remaining.map((m) => m.id);
  assert.ok(ids.includes("keep-model"));
  assert.ok(!ids.includes("remove-model"));
});

serialTest("deleteSyncedAvailableModelsForProvider removes every connection's models for that provider", async () => {
  const providerId = `${RUN_PREFIX}-sync-provider-h`;
  await modelsDb.replaceSyncedAvailableModelsForConnection(providerId, "conn-1", [
    { id: "model-1", name: "1" },
  ]);
  await modelsDb.replaceSyncedAvailableModelsForConnection(providerId, "conn-2", [
    { id: "model-2", name: "2" },
  ]);

  const deletedCount = await modelsDb.deleteSyncedAvailableModelsForProvider(providerId);
  assert.equal(deletedCount, 2);

  const remaining = await modelsDb.getSyncedAvailableModels(providerId);
  assert.deepEqual(remaining, []);
});

serialTest("pruneStaleSyncedAvailableModelsForProvider keeps only allowed connectionIds", async () => {
  const providerId = `${RUN_PREFIX}-sync-provider-i`;
  await modelsDb.replaceSyncedAvailableModelsForConnection(providerId, "conn-keep", [
    { id: "keep-model", name: "Keep" },
  ]);
  await modelsDb.replaceSyncedAvailableModelsForConnection(providerId, "conn-stale", [
    { id: "stale-model", name: "Stale" },
  ]);

  await modelsDb.pruneStaleSyncedAvailableModelsForProvider(providerId, ["conn-keep"]);

  const remaining = await modelsDb.getSyncedAvailableModels(providerId);
  const ids = remaining.map((m) => m.id);
  assert.ok(ids.includes("keep-model"));
  assert.ok(!ids.includes("stale-model"));
});

serialTest("pruneStaleSyncedAvailableModelsForProvider with an empty allow-list deletes everything for the provider", async () => {
  const providerId = `${RUN_PREFIX}-sync-provider-j`;
  await modelsDb.replaceSyncedAvailableModelsForConnection(providerId, "conn-1", [
    { id: "model-1", name: "1" },
  ]);

  await modelsDb.pruneStaleSyncedAvailableModelsForProvider(providerId, []);

  const remaining = await modelsDb.getSyncedAvailableModels(providerId);
  assert.deepEqual(remaining, []);
});

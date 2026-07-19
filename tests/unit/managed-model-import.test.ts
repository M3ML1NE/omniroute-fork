import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-managed-model-import-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const pgModule = await import("../../src/lib/db/postgres.ts");
const modelsDb = await import("../../src/lib/db/models.ts");
const { importManagedModels } = await import("../../src/lib/providerModels/managedModelImport.ts");

const RUN_PREFIX = `managed-import-${process.pid}`;

function serialTest(name: string, fn: () => Promise<void>) {
  test(name, { concurrency: false }, fn);
}

async function resetStorage() {
  const schema = pgModule.getSchema();
  await pgModule.query(
    `DELETE FROM ${schema}.key_value WHERE namespace = 'customModels' AND key LIKE $1`,
    [`${RUN_PREFIX}-%`]
  );
  await pgModule.query(
    `DELETE FROM ${schema}.key_value WHERE namespace = 'syncedAvailableModels' AND key LIKE $1`,
    [`${RUN_PREFIX}-%:%`]
  );
  await pgModule.query(
    `DELETE FROM ${schema}.key_value WHERE namespace = 'modelCompatOverrides' AND key LIKE $1`,
    [`${RUN_PREFIX}-%`]
  );
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

function uniqueProviderId(suffix: string): string {
  return `${RUN_PREFIX}-${suffix}-${Math.random().toString(16).slice(2, 8)}`;
}

serialTest("importManagedModels in sync mode discovers new models and stores them in the connection cache", async () => {
  const providerId = uniqueProviderId("sync-new");
  const connectionId = "conn-1";

  const result = await importManagedModels({
    providerId,
    connectionId,
    fetchedModels: [{ id: "model-a", name: "Model A" }],
    mode: "sync",
  });

  assert.equal(result.discoveredModels.length, 1);
  assert.equal(result.discoveredModels[0].id, "model-a");
  assert.equal(result.syncedAvailableModels.length, 1);
  assert.equal(result.importedChanges.added, 1);
  assert.equal(result.importedModels.length, 1);
  assert.equal(result.importedModels[0].id, "model-a");

  const stored = await modelsDb.getSyncedAvailableModelsForConnection(providerId, connectionId);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, "model-a");
});

serialTest("importManagedModels removes previously-imported custom models that are now discovered upstream", async () => {
  const providerId = uniqueProviderId("dedup");
  const connectionId = "conn-1";

  // Seed a "manual" custom model (should survive) and an "imported" one from
  // a prior sync (should be removed once model-a is rediscovered).
  await modelsDb.replaceCustomModels(
    providerId,
    [
      { id: "manual-model", name: "Manual Model", source: "manual" },
      { id: "model-a", name: "Model A (stale import)", source: "imported" },
    ],
    { allowEmpty: true }
  );

  const result = await importManagedModels({
    providerId,
    connectionId,
    fetchedModels: [{ id: "model-a", name: "Model A" }],
    mode: "sync",
  });

  const persistedIds = result.persistedModels.map((m: any) => m.id);
  assert.ok(persistedIds.includes("manual-model"));
  assert.ok(!persistedIds.includes("model-a"));
});

serialTest("importManagedModels preserves compat overrides (normalizeToolCallId) from a removed custom model", async () => {
  const providerId = uniqueProviderId("compat-preserve");
  const connectionId = "conn-1";

  await modelsDb.replaceCustomModels(
    providerId,
    [{ id: "model-a", name: "Model A", source: "imported" }],
    { allowEmpty: true }
  );
  await modelsDb.updateCustomModel(providerId, "model-a", { normalizeToolCallId: true });

  const seeded = await modelsDb.getCustomModels(providerId);
  assert.equal((seeded as any[])[0]?.normalizeToolCallId, true);

  await importManagedModels({
    providerId,
    connectionId,
    fetchedModels: [{ id: "model-a", name: "Model A" }],
    mode: "sync",
  });

  const overrides = await modelsDb.getModelCompatOverrides(providerId);
  const entry = overrides.find((o) => o.id === "model-a");
  assert.equal(entry?.normalizeToolCallId, true);
});

serialTest("importManagedModels in merge mode does not replace the synced-available-models cache when nothing was discovered", async () => {
  const providerId = uniqueProviderId("merge-empty");
  const connectionId = "conn-1";

  await modelsDb.replaceSyncedAvailableModelsForConnection(providerId, connectionId, [
    { id: "existing-model", name: "Existing Model" },
  ]);

  const result = await importManagedModels({
    providerId,
    connectionId,
    fetchedModels: [],
    mode: "merge",
  });

  assert.equal(result.discoveredModels.length, 0);
  assert.equal(result.syncedAvailableModels.length, 1);
  assert.equal(result.syncedAvailableModels[0].id, "existing-model");
});

serialTest("importManagedModels prunes synced-available-models for connections no longer active on this provider", async () => {
  const providerId = uniqueProviderId("prune");
  const staleConnectionId = "stale-conn";
  const activeConnectionId = "active-conn";

  await modelsDb.replaceSyncedAvailableModelsForConnection(providerId, staleConnectionId, [
    { id: "stale-model", name: "Stale Model" },
  ]);

  await importManagedModels({
    providerId,
    connectionId: activeConnectionId,
    fetchedModels: [{ id: "fresh-model", name: "Fresh Model" }],
    mode: "sync",
  });

  const staleModels = await modelsDb.getSyncedAvailableModelsForConnection(
    providerId,
    staleConnectionId
  );
  assert.equal(staleModels.length, 0);
});

serialTest("importManagedModels tracks unchanged vs updated for a re-imported model with the same shape", async () => {
  const providerId = uniqueProviderId("unchanged");
  const connectionId = "conn-1";

  const first = await importManagedModels({
    providerId,
    connectionId,
    fetchedModels: [{ id: "model-a", name: "Model A" }],
    mode: "sync",
  });
  assert.equal(first.importedChanges.added, 1);

  const second = await importManagedModels({
    providerId,
    connectionId,
    fetchedModels: [{ id: "model-a", name: "Model A" }],
    mode: "sync",
    previousSyncedAvailableModels: first.syncedAvailableModels,
  });
  assert.equal(second.importedChanges.added, 0);
  assert.equal(second.importedChanges.updated, 0);
  assert.equal(second.importedChanges.unchanged, 1);
});

serialTest("importManagedModels reports 'updated' when a re-imported model's fields change", async () => {
  const providerId = uniqueProviderId("updated");
  const connectionId = "conn-1";

  const first = await importManagedModels({
    providerId,
    connectionId,
    fetchedModels: [{ id: "model-a", name: "Model A" }],
    mode: "sync",
  });

  const second = await importManagedModels({
    providerId,
    connectionId,
    fetchedModels: [{ id: "model-a", name: "Model A Renamed" }],
    mode: "sync",
    previousSyncedAvailableModels: first.syncedAvailableModels,
  });
  assert.equal(second.importedChanges.updated, 1);
  assert.equal(second.importedChanges.added, 0);
});

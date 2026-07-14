import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-provider-limits-pure-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const pgModule = await import("../../src/lib/db/postgres.ts");
const providerLimits = await import("../../src/lib/usage/providerLimits.ts");

const ORIGINAL_SYNC_INTERVAL = process.env.PROVIDER_LIMITS_SYNC_INTERVAL_MINUTES;

function serialTest(name: string, fn: () => Promise<void>) {
  test(name, { concurrency: false }, fn);
}

async function resetStorage() {
  const schema = pgModule.getSchema();
  await pgModule.query(
    `DELETE FROM ${schema}.key_value WHERE namespace = 'settings' AND key = 'provider_limits_auto_sync_last_run'`
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
  if (ORIGINAL_SYNC_INTERVAL === undefined) delete process.env.PROVIDER_LIMITS_SYNC_INTERVAL_MINUTES;
  else process.env.PROVIDER_LIMITS_SYNC_INTERVAL_MINUTES = ORIGINAL_SYNC_INTERVAL;
});

test("getProviderLimitsSyncIntervalMinutes defaults to 70 when the env var is unset", () => {
  delete process.env.PROVIDER_LIMITS_SYNC_INTERVAL_MINUTES;
  assert.equal(providerLimits.getProviderLimitsSyncIntervalMinutes(), 70);
});

test("getProviderLimitsSyncIntervalMinutes uses a valid positive integer from the env var", () => {
  process.env.PROVIDER_LIMITS_SYNC_INTERVAL_MINUTES = "45";
  assert.equal(providerLimits.getProviderLimitsSyncIntervalMinutes(), 45);
});

test("getProviderLimitsSyncIntervalMinutes falls back to the default for a non-positive or invalid value", () => {
  process.env.PROVIDER_LIMITS_SYNC_INTERVAL_MINUTES = "0";
  assert.equal(providerLimits.getProviderLimitsSyncIntervalMinutes(), 70);
  process.env.PROVIDER_LIMITS_SYNC_INTERVAL_MINUTES = "-5";
  assert.equal(providerLimits.getProviderLimitsSyncIntervalMinutes(), 70);
  process.env.PROVIDER_LIMITS_SYNC_INTERVAL_MINUTES = "not-a-number";
  assert.equal(providerLimits.getProviderLimitsSyncIntervalMinutes(), 70);
});

test("getProviderLimitsSyncIntervalMs converts the minutes value to milliseconds", () => {
  process.env.PROVIDER_LIMITS_SYNC_INTERVAL_MINUTES = "10";
  assert.equal(providerLimits.getProviderLimitsSyncIntervalMs(), 10 * 60 * 1000);
});

serialTest("getLastProviderLimitsAutoSyncTime returns null when never set", async () => {
  const result = await providerLimits.getLastProviderLimitsAutoSyncTime();
  assert.equal(result, null);
});

serialTest("getLastProviderLimitsAutoSyncTime returns the persisted timestamp after a settings write", async () => {
  const { updateSettings } = await import("../../src/lib/db/settings.ts");
  const timestamp = new Date().toISOString();
  await updateSettings({ provider_limits_auto_sync_last_run: timestamp });

  const result = await providerLimits.getLastProviderLimitsAutoSyncTime();
  assert.equal(result, timestamp);
});

serialTest("getCachedProviderLimitsMap returns an object (empty map when nothing is cached)", async () => {
  const map = await providerLimits.getCachedProviderLimitsMap();
  assert.equal(typeof map, "object");
  assert.ok(map !== null);
});

serialTest("getCachedProviderLimitsMap reflects an entry written via setProviderLimitsCache", async () => {
  const { setProviderLimitsCache, deleteProviderLimitsCache } = await import(
    "../../src/lib/db/providerLimits.ts"
  );
  const connectionId = `provider-limits-pure-${process.pid}-conn`;
  try {
    await setProviderLimitsCache(connectionId, {
      quotas: { requestsRemaining: 100 },
      plan: "free",
      message: null,
      fetchedAt: new Date().toISOString(),
      source: "manual",
    });

    const map = await providerLimits.getCachedProviderLimitsMap();
    assert.ok(map[connectionId]);
    assert.deepEqual(map[connectionId].quotas, { requestsRemaining: 100 });
  } finally {
    await deleteProviderLimitsCache(connectionId);
  }
});

serialTest("fetchLiveProviderLimits throws a 404-status error for an unknown connection id", async () => {
  await assert.rejects(
    providerLimits.fetchLiveProviderLimits("00000000-0000-0000-0000-000000000000"),
    (err: any) => {
      assert.equal(err.status, 404);
      return true;
    }
  );
});

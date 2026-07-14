import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-provider-limits-conn-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const pgModule = await import("../../src/lib/db/postgres.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const providerLimits = await import("../../src/lib/usage/providerLimits.ts");

const RUN_PREFIX = `provider-limits-conn-${process.pid}`;

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

// This fork's USAGE_SUPPORTED_PROVIDERS is intentionally empty (mTLS-only
// GigaChat fork — see src/shared/constants/providers.ts), so every
// connection is "unsupported" for usage/quota purposes regardless of
// provider or authType. That makes isSupportedUsageConnection's guard
// clause exercisable deterministically without any network mocking.

serialTest("fetchLiveProviderLimits throws a 400-status error for a connection whose provider has no usage support", async () => {
  const created = await providersDb.createProviderConnection({
    provider: "openai-compatible",
    authType: "apikey",
    name: uniqueName("unsupported"),
    apiKey: "sk-test",
  });
  assert.ok(created);

  await assert.rejects(
    providerLimits.fetchLiveProviderLimits((created as any).id),
    (err: any) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /Usage not available/);
      return true;
    }
  );
});

serialTest("fetchAndPersistProviderLimits propagates the same 400 error for an unsupported connection", async () => {
  const created = await providersDb.createProviderConnection({
    provider: "openai-compatible",
    authType: "oauth",
    name: uniqueName("unsupported-oauth"),
    accessToken: "at",
    refreshToken: "rt",
  });
  assert.ok(created);

  await assert.rejects(
    providerLimits.fetchAndPersistProviderLimits((created as any).id, "manual"),
    (err: any) => {
      assert.equal(err.status, 400);
      return true;
    }
  );
});

serialTest("syncAllProviderLimits filters out every connection (no usage-supported providers in this fork) and returns an empty result", async () => {
  await providersDb.createProviderConnection({
    provider: "openai-compatible",
    authType: "apikey",
    name: uniqueName("a"),
    apiKey: "sk-a",
    isActive: true,
  });
  await providersDb.createProviderConnection({
    provider: "openai-compatible",
    authType: "oauth",
    name: uniqueName("b"),
    accessToken: "at",
    isActive: true,
  });

  const result = await providerLimits.syncAllProviderLimits({ source: "manual" });
  assert.equal(result.total, 0);
  assert.equal(result.succeeded, 0);
  assert.equal(result.failed, 0);
  assert.deepEqual(result.caches, {});
  assert.deepEqual(result.errors, {});
});

serialTest("syncAllProviderLimits with source='scheduled' still persists the auto-sync timestamp even with zero eligible connections", async () => {
  const before = await providerLimits.getLastProviderLimitsAutoSyncTime();

  await providerLimits.syncAllProviderLimits({ source: "scheduled" });

  const after = await providerLimits.getLastProviderLimitsAutoSyncTime();
  assert.ok(after);
  assert.notEqual(after, before);
});

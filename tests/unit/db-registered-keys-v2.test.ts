import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-registered-keys-v2-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const pgModule = await import("../../src/lib/db/postgres.ts");
const registeredKeysDb = await import("../../src/lib/db/registeredKeys.ts");

const RUN_PREFIX = `reg-keys-v2-${process.pid}`;
const PROVIDER = `${RUN_PREFIX}-provider`;
const ACCOUNT = `${RUN_PREFIX}-account`;

function serialTest(name: string, fn: () => Promise<void>) {
  test(name, { concurrency: false }, fn);
}

async function resetStorage() {
  const schema = pgModule.getSchema();
  await pgModule.query(`DELETE FROM ${schema}.registered_keys WHERE name LIKE $1`, [
    `${RUN_PREFIX}-%`,
  ]);
  await pgModule.query(`DELETE FROM ${schema}.provider_key_limits WHERE provider LIKE $1`, [
    `${RUN_PREFIX}-%`,
  ]);
  await pgModule.query(`DELETE FROM ${schema}.account_key_limits WHERE account_id LIKE $1`, [
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

serialTest("checkQuota allows issuance with no limits configured", async () => {
  const result = await registeredKeysDb.checkQuota(PROVIDER, ACCOUNT);
  assert.equal(result.allowed, true);
});

serialTest("issueRegisteredKey creates a key with a raw secret and hashed storage", async () => {
  const result = await registeredKeysDb.issueRegisteredKey({
    name: `${RUN_PREFIX}-key1`,
    provider: PROVIDER,
    accountId: ACCOUNT,
  });

  assert.ok(!("idempotencyConflict" in result));
  const created = result as Exclude<typeof result, { idempotencyConflict: true }>;
  assert.ok(created.rawKey.startsWith("ork_"));
  assert.equal(created.name, `${RUN_PREFIX}-key1`);
  assert.equal(created.provider, PROVIDER);
  assert.equal(created.accountId, ACCOUNT);
  assert.equal(created.isActive, true);
});

serialTest("issueRegisteredKey with the same idempotencyKey returns the existing key instead of creating a duplicate", async () => {
  const idempotencyKey = `${RUN_PREFIX}-idem-1`;
  const first = await registeredKeysDb.issueRegisteredKey({
    name: `${RUN_PREFIX}-key-idem`,
    provider: PROVIDER,
    idempotencyKey,
  });
  assert.ok(!("idempotencyConflict" in first));

  const second = await registeredKeysDb.issueRegisteredKey({
    name: `${RUN_PREFIX}-key-idem-again`,
    provider: PROVIDER,
    idempotencyKey,
  });

  assert.ok("idempotencyConflict" in second);
  if ("idempotencyConflict" in second) {
    assert.equal(second.existing.name, `${RUN_PREFIX}-key-idem`);
  }

  const all = await registeredKeysDb.listRegisteredKeys({ provider: PROVIDER });
  assert.equal(all.filter((k) => k.idempotencyKey === idempotencyKey).length, 1);
});

serialTest("getRegisteredKey returns null for a nonexistent id", async () => {
  assert.equal(await registeredKeysDb.getRegisteredKey("00000000-0000-0000-0000-000000000000"), null);
});

serialTest("listRegisteredKeys filters by provider and accountId", async () => {
  await registeredKeysDb.issueRegisteredKey({
    name: `${RUN_PREFIX}-list-1`,
    provider: PROVIDER,
    accountId: ACCOUNT,
  });
  await registeredKeysDb.issueRegisteredKey({
    name: `${RUN_PREFIX}-list-2`,
    provider: `${RUN_PREFIX}-other-provider`,
  });

  const byProvider = await registeredKeysDb.listRegisteredKeys({ provider: PROVIDER });
  assert.equal(byProvider.length, 1);
  assert.equal(byProvider[0].name, `${RUN_PREFIX}-list-1`);
});

serialTest("revokeRegisteredKey deactivates a key and reports success", async () => {
  const result = await registeredKeysDb.issueRegisteredKey({
    name: `${RUN_PREFIX}-revoke`,
    provider: PROVIDER,
  });
  assert.ok(!("idempotencyConflict" in result));
  const created = result as { id: string };

  assert.equal(await registeredKeysDb.revokeRegisteredKey(created.id), true);
  const after = await registeredKeysDb.getRegisteredKey(created.id);
  assert.equal(after?.isActive, false);
  assert.ok(after?.revokedAt);
});

serialTest("revokeRegisteredKey returns false for an already-revoked or nonexistent key", async () => {
  assert.equal(
    await registeredKeysDb.revokeRegisteredKey("00000000-0000-0000-0000-000000000000"),
    false
  );
});

serialTest("validateRegisteredKey resolves an active key by its raw secret", async () => {
  const result = await registeredKeysDb.issueRegisteredKey({
    name: `${RUN_PREFIX}-validate`,
    provider: PROVIDER,
  });
  assert.ok(!("idempotencyConflict" in result));
  const created = result as { rawKey: string; id: string };

  const validated = await registeredKeysDb.validateRegisteredKey(created.rawKey);
  assert.equal(validated?.id, created.id);
});

serialTest("validateRegisteredKey returns null for an unknown raw key", async () => {
  assert.equal(await registeredKeysDb.validateRegisteredKey("ork_does-not-exist"), null);
});

serialTest("validateRegisteredKey returns null for a revoked key", async () => {
  const result = await registeredKeysDb.issueRegisteredKey({
    name: `${RUN_PREFIX}-revoked-validate`,
    provider: PROVIDER,
  });
  assert.ok(!("idempotencyConflict" in result));
  const created = result as { rawKey: string; id: string };
  await registeredKeysDb.revokeRegisteredKey(created.id);

  assert.equal(await registeredKeysDb.validateRegisteredKey(created.rawKey), null);
});

serialTest("validateRegisteredKey enforces the daily budget once exhausted", async () => {
  const result = await registeredKeysDb.issueRegisteredKey({
    name: `${RUN_PREFIX}-budget`,
    provider: PROVIDER,
    dailyBudget: 1,
  });
  assert.ok(!("idempotencyConflict" in result));
  const created = result as { rawKey: string; id: string };

  // First validation succeeds (0 used < budget of 1).
  const first = await registeredKeysDb.validateRegisteredKey(created.rawKey);
  assert.ok(first);

  await registeredKeysDb.incrementRegisteredKeyUsage(created.id);

  // Second validation fails (1 used >= budget of 1).
  const second = await registeredKeysDb.validateRegisteredKey(created.rawKey);
  assert.equal(second, null);
});

serialTest("incrementRegisteredKeyUsage bumps both daily and hourly counters", async () => {
  const result = await registeredKeysDb.issueRegisteredKey({
    name: `${RUN_PREFIX}-usage`,
    provider: PROVIDER,
  });
  assert.ok(!("idempotencyConflict" in result));
  const created = result as { id: string };

  await registeredKeysDb.incrementRegisteredKeyUsage(created.id);
  await registeredKeysDb.incrementRegisteredKeyUsage(created.id);

  const after = await registeredKeysDb.getRegisteredKey(created.id);
  assert.equal(after?.dailyUsed, 2);
  assert.equal(after?.hourlyUsed, 2);
});

serialTest("setProviderKeyLimit / getProviderKeyLimit round-trip", async () => {
  await registeredKeysDb.setProviderKeyLimit(PROVIDER, {
    maxActiveKeys: 5,
    dailyIssueLimit: 10,
    hourlyIssueLimit: 2,
  });

  const limit = await registeredKeysDb.getProviderKeyLimit(PROVIDER);
  assert.equal(limit?.maxActiveKeys, 5);
  assert.equal(limit?.dailyIssueLimit, 10);
  assert.equal(limit?.hourlyIssueLimit, 2);
});

serialTest("getProviderKeyLimit returns null when no limit is configured", async () => {
  assert.equal(await registeredKeysDb.getProviderKeyLimit(`${RUN_PREFIX}-unconfigured`), null);
});

serialTest("checkQuota blocks issuance once the provider's hourly issue limit is reached", async () => {
  await registeredKeysDb.setProviderKeyLimit(PROVIDER, { hourlyIssueLimit: 1 });
  await registeredKeysDb.issueRegisteredKey({ name: `${RUN_PREFIX}-quota-1`, provider: PROVIDER });

  const result = await registeredKeysDb.checkQuota(PROVIDER);
  assert.equal(result.allowed, false);
  assert.equal(result.errorCode, "PROVIDER_QUOTA_EXCEEDED");
});

serialTest("checkQuota blocks issuance once the provider's max active keys is reached", async () => {
  await registeredKeysDb.setProviderKeyLimit(PROVIDER, { maxActiveKeys: 1 });
  await registeredKeysDb.issueRegisteredKey({
    name: `${RUN_PREFIX}-active-key-1`,
    provider: PROVIDER,
  });

  const result = await registeredKeysDb.checkQuota(PROVIDER);
  assert.equal(result.allowed, false);
  assert.equal(result.errorCode, "MAX_ACTIVE_KEYS_EXCEEDED");
  assert.equal(result.providerActiveKeys, 1);
});

serialTest("setAccountKeyLimit / getAccountKeyLimit round-trip", async () => {
  await registeredKeysDb.setAccountKeyLimit(ACCOUNT, {
    maxActiveKeys: 3,
    dailyIssueLimit: 20,
  });

  const limit = await registeredKeysDb.getAccountKeyLimit(ACCOUNT);
  assert.equal(limit?.maxActiveKeys, 3);
  assert.equal(limit?.dailyIssueLimit, 20);
});

serialTest("checkQuota blocks issuance once the account's daily issue limit is reached", async () => {
  await registeredKeysDb.setAccountKeyLimit(ACCOUNT, { dailyIssueLimit: 1 });
  await registeredKeysDb.issueRegisteredKey({
    name: `${RUN_PREFIX}-acct-quota-1`,
    accountId: ACCOUNT,
  });

  const result = await registeredKeysDb.checkQuota("", ACCOUNT);
  assert.equal(result.allowed, false);
  assert.equal(result.errorCode, "ACCOUNT_QUOTA_EXCEEDED");
});

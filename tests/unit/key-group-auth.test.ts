import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-key-group-auth-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "test-key-group-auth-secret";

const core = await import("../../src/lib/db/core.ts");
const pgModule = await import("../../src/lib/db/postgres.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const groupsDb = await import("../../src/lib/db/apiKeyGroups.ts");
const keyGroupAuth = await import("../../open-sse/services/keyGroupAuth.ts");

const RUN_PREFIX = `key-group-auth-${process.pid}`;

function serialTest(name: string, fn: () => Promise<void>) {
  test(name, { concurrency: false }, fn);
}

async function resetStorage() {
  const schema = pgModule.getSchema();
  await pgModule.query(
    `DELETE FROM ${schema}.key_group_members WHERE group_id IN (SELECT id FROM ${schema}.key_groups WHERE name LIKE $1)`,
    [`${RUN_PREFIX}-%`]
  );
  await pgModule.query(
    `DELETE FROM ${schema}.group_model_permissions WHERE group_id IN (SELECT id FROM ${schema}.key_groups WHERE name LIKE $1)`,
    [`${RUN_PREFIX}-%`]
  );
  await pgModule.query(`DELETE FROM ${schema}.key_groups WHERE name LIKE $1`, [`${RUN_PREFIX}-%`]);
  await pgModule.query(`DELETE FROM ${schema}.api_keys WHERE name LIKE $1`, [`${RUN_PREFIX}-%`]);
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  await resetStorage();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

serialTest(
  "authorizeKeyModelAccess resolves real groups array and denies when a deny rule matches",
  async () => {
    const group = await groupsDb.createKeyGroup(`${RUN_PREFIX}-deny-group`);
    await groupsDb.addGroupPermission(group.id, "*", "allow");
    await groupsDb.addGroupPermission(group.id, "gpt-4o", "deny");
    const apiKey = await apiKeysDb.createApiKey(`${RUN_PREFIX}-key-1`, "machine-1");
    await groupsDb.addKeyToGroup(apiKey.id, group.id);

    const result = await keyGroupAuth.authorizeKeyModelAccess(apiKey.id, "gpt-4o");

    assert.equal(result.authorized, false);
    assert.ok(Array.isArray(result.groups));
    assert.equal(result.groups.length, 1);
    assert.equal(result.groups[0].id, group.id);
    assert.equal(result.groups[0].name, `${RUN_PREFIX}-deny-group`);
    assert.match(result.reason ?? "", /denied by group permission \(pattern: gpt-4o\)/);
  }
);

serialTest("authorizeKeyModelAccess allows access when key is not in any group", async () => {
  const apiKey = await apiKeysDb.createApiKey(`${RUN_PREFIX}-key-2`, "machine-2");

  const result = await keyGroupAuth.authorizeKeyModelAccess(apiKey.id, "gpt-4o");

  assert.equal(result.authorized, true);
  assert.deepEqual(result.groups, []);
});

serialTest(
  "getKeyGroupSummary resolves real groups array with restricted true when key belongs to a group",
  async () => {
    const group = await groupsDb.createKeyGroup(`${RUN_PREFIX}-summary-group`);
    const apiKey = await apiKeysDb.createApiKey(`${RUN_PREFIX}-key-3`, "machine-3");
    await groupsDb.addKeyToGroup(apiKey.id, group.id);

    const summary = await keyGroupAuth.getKeyGroupSummary(apiKey.id);

    assert.ok(Array.isArray(summary.groups));
    assert.equal(summary.groups.length, 1);
    assert.equal(summary.groups[0].id, group.id);
    assert.equal(summary.restricted, true);
  }
);

serialTest(
  "getKeyGroupSummary returns restricted false and an empty groups array when key has no groups",
  async () => {
    const apiKey = await apiKeysDb.createApiKey(`${RUN_PREFIX}-key-4`, "machine-4");

    const summary = await keyGroupAuth.getKeyGroupSummary(apiKey.id);

    assert.deepEqual(summary.groups, []);
    assert.equal(summary.restricted, false);
  }
);

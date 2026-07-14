import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-api-key-groups-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "test-api-key-groups-secret";

const core = await import("../../src/lib/db/core.ts");
const pgModule = await import("../../src/lib/db/postgres.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const groupsDb = await import("../../src/lib/db/apiKeyGroups.ts");

const RUN_PREFIX = `api-key-groups-${process.pid}`;

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

serialTest("createKeyGroup persists a group with defaults and getKeyGroup reads it back", async () => {
  const created = await groupsDb.createKeyGroup(`${RUN_PREFIX}-team-a`);
  assert.ok(created.id);
  assert.equal(created.name, `${RUN_PREFIX}-team-a`);
  assert.equal(created.description, "");
  assert.equal(created.isActive, true);

  const fetched = await groupsDb.getKeyGroup(created.id);
  assert.equal(fetched?.id, created.id);
});

serialTest("createKeyGroup accepts an explicit description", async () => {
  const created = await groupsDb.createKeyGroup(`${RUN_PREFIX}-team-b`, "engineering team");
  assert.equal(created.description, "engineering team");
});

serialTest("getKeyGroup returns undefined for a nonexistent id", async () => {
  assert.equal(await groupsDb.getKeyGroup("00000000-0000-0000-0000-000000000000"), undefined);
});

serialTest("getAllKeyGroups returns groups ordered by name", async () => {
  await groupsDb.createKeyGroup(`${RUN_PREFIX}-zzz`);
  await groupsDb.createKeyGroup(`${RUN_PREFIX}-aaa`);

  const all = await groupsDb.getAllKeyGroups();
  const ours = all.filter((g) => g.name.startsWith(RUN_PREFIX));
  assert.equal(ours[0].name, `${RUN_PREFIX}-aaa`);
  assert.equal(ours[1].name, `${RUN_PREFIX}-zzz`);
});

serialTest("updateKeyGroup patches only the provided fields", async () => {
  const created = await groupsDb.createKeyGroup(`${RUN_PREFIX}-update`, "original");
  const updated = await groupsDb.updateKeyGroup(created.id, { description: "changed" });
  assert.equal(updated?.name, `${RUN_PREFIX}-update`);
  assert.equal(updated?.description, "changed");
});

serialTest("updateKeyGroup can toggle isActive", async () => {
  const created = await groupsDb.createKeyGroup(`${RUN_PREFIX}-active`);
  const updated = await groupsDb.updateKeyGroup(created.id, { isActive: false });
  assert.equal(updated?.isActive, false);
});

serialTest("updateKeyGroup returns undefined for a nonexistent group", async () => {
  const result = await groupsDb.updateKeyGroup("00000000-0000-0000-0000-000000000000", {
    name: "x",
  });
  assert.equal(result, undefined);
});

serialTest("updateKeyGroup with no fields returns the group unchanged", async () => {
  const created = await groupsDb.createKeyGroup(`${RUN_PREFIX}-noop`, "desc");
  const updated = await groupsDb.updateKeyGroup(created.id, {});
  assert.equal(updated?.description, "desc");
});

serialTest("deleteKeyGroup removes the group and reports success", async () => {
  const created = await groupsDb.createKeyGroup(`${RUN_PREFIX}-delete`);
  assert.equal(await groupsDb.deleteKeyGroup(created.id), true);
  assert.equal(await groupsDb.getKeyGroup(created.id), undefined);
});

serialTest("deleteKeyGroup returns false for a nonexistent group", async () => {
  assert.equal(await groupsDb.deleteKeyGroup("00000000-0000-0000-0000-000000000000"), false);
});

serialTest("addGroupPermission / getGroupPermissions round-trip", async () => {
  const group = await groupsDb.createKeyGroup(`${RUN_PREFIX}-perms`);
  await groupsDb.addGroupPermission(group.id, "gpt-4*", "allow", "openai");

  const perms = await groupsDb.getGroupPermissions(group.id);
  assert.equal(perms.length, 1);
  assert.equal(perms[0].modelPattern, "gpt-4*");
  assert.equal(perms[0].accessType, "allow");
  assert.equal(perms[0].provider, "openai");
});

serialTest("removeGroupPermission removes a single permission", async () => {
  const group = await groupsDb.createKeyGroup(`${RUN_PREFIX}-remove-perm`);
  const perm = await groupsDb.addGroupPermission(group.id, "*", "deny");
  assert.equal(await groupsDb.removeGroupPermission(perm.id), true);
  assert.equal((await groupsDb.getGroupPermissions(group.id)).length, 0);
});

serialTest("clearGroupPermissions removes all permissions for a group", async () => {
  const group = await groupsDb.createKeyGroup(`${RUN_PREFIX}-clear-perms`);
  await groupsDb.addGroupPermission(group.id, "gpt-4*", "allow");
  await groupsDb.addGroupPermission(group.id, "claude-*", "deny");

  await groupsDb.clearGroupPermissions(group.id);
  assert.equal((await groupsDb.getGroupPermissions(group.id)).length, 0);
});

serialTest("addKeyToGroup / getGroupMembers / getKeyGroupsForApiKey round-trip", async () => {
  const group = await groupsDb.createKeyGroup(`${RUN_PREFIX}-members`);
  const apiKey = await apiKeysDb.createApiKey(`${RUN_PREFIX}-key-1`, "machine-1");

  assert.equal(await groupsDb.addKeyToGroup(apiKey.id, group.id), true);

  const members = await groupsDb.getGroupMembers(group.id);
  assert.equal(members.length, 1);
  assert.equal(members[0].keyId, apiKey.id);

  const groupsForKey = await groupsDb.getKeyGroupsForApiKey(apiKey.id);
  assert.equal(groupsForKey.length, 1);
  assert.equal(groupsForKey[0].id, group.id);
});

serialTest("getKeyGroupsForApiKey excludes inactive groups", async () => {
  const group = await groupsDb.createKeyGroup(`${RUN_PREFIX}-inactive`);
  const apiKey = await apiKeysDb.createApiKey(`${RUN_PREFIX}-key-2`, "machine-2");
  await groupsDb.addKeyToGroup(apiKey.id, group.id);
  await groupsDb.updateKeyGroup(group.id, { isActive: false });

  const groupsForKey = await groupsDb.getKeyGroupsForApiKey(apiKey.id);
  assert.equal(groupsForKey.length, 0);
});

serialTest("removeKeyFromGroup removes the membership", async () => {
  const group = await groupsDb.createKeyGroup(`${RUN_PREFIX}-remove-member`);
  const apiKey = await apiKeysDb.createApiKey(`${RUN_PREFIX}-key-3`, "machine-3");
  await groupsDb.addKeyToGroup(apiKey.id, group.id);

  assert.equal(await groupsDb.removeKeyFromGroup(apiKey.id, group.id), true);
  assert.equal((await groupsDb.getGroupMembers(group.id)).length, 0);
});

serialTest("removeKeyFromGroup returns false when the membership does not exist", async () => {
  const group = await groupsDb.createKeyGroup(`${RUN_PREFIX}-no-member`);
  const apiKey = await apiKeysDb.createApiKey(`${RUN_PREFIX}-key-4`, "machine-4");
  assert.equal(await groupsDb.removeKeyFromGroup(apiKey.id, group.id), false);
});

serialTest("getKeyGroupWithPermissions merges permissions and member count", async () => {
  const group = await groupsDb.createKeyGroup(`${RUN_PREFIX}-with-perms`);
  await groupsDb.addGroupPermission(group.id, "*", "allow");
  const apiKey = await apiKeysDb.createApiKey(`${RUN_PREFIX}-key-5`, "machine-5");
  await groupsDb.addKeyToGroup(apiKey.id, group.id);

  const full = await groupsDb.getKeyGroupWithPermissions(group.id);
  assert.ok(full);
  assert.equal(full!.permissions.length, 1);
  assert.equal(full!.memberCount, 1);
});

serialTest("getKeyGroupWithPermissions returns undefined for a nonexistent group", async () => {
  const result = await groupsDb.getKeyGroupWithPermissions("00000000-0000-0000-0000-000000000000");
  assert.equal(result, undefined);
});

serialTest("checkKeyModelAccess allows access when the key has no groups", async () => {
  const apiKey = await apiKeysDb.createApiKey(`${RUN_PREFIX}-key-6`, "machine-6");
  const result = await groupsDb.checkKeyModelAccess(apiKey.id, "gpt-4o");
  assert.equal(result.allowed, true);
  assert.equal(result.matchedRules.length, 0);
});

serialTest("checkKeyModelAccess allows access when an allow rule matches", async () => {
  const group = await groupsDb.createKeyGroup(`${RUN_PREFIX}-allow-group`);
  await groupsDb.addGroupPermission(group.id, "gpt-4*", "allow");
  const apiKey = await apiKeysDb.createApiKey(`${RUN_PREFIX}-key-7`, "machine-7");
  await groupsDb.addKeyToGroup(apiKey.id, group.id);

  const result = await groupsDb.checkKeyModelAccess(apiKey.id, "gpt-4o");
  assert.equal(result.allowed, true);
});

serialTest("checkKeyModelAccess denies access when a deny rule matches, even with an allow rule present", async () => {
  const group = await groupsDb.createKeyGroup(`${RUN_PREFIX}-deny-group`);
  await groupsDb.addGroupPermission(group.id, "*", "allow");
  await groupsDb.addGroupPermission(group.id, "gpt-4o", "deny");
  const apiKey = await apiKeysDb.createApiKey(`${RUN_PREFIX}-key-8`, "machine-8");
  await groupsDb.addKeyToGroup(apiKey.id, group.id);

  const result = await groupsDb.checkKeyModelAccess(apiKey.id, "gpt-4o");
  assert.equal(result.allowed, false);
  assert.equal(result.deniedBy?.modelPattern, "gpt-4o");
});

serialTest("checkKeyModelAccess denies access when the key belongs to a group but no rule matches the model", async () => {
  const group = await groupsDb.createKeyGroup(`${RUN_PREFIX}-restrictive-group`);
  await groupsDb.addGroupPermission(group.id, "claude-*", "allow");
  const apiKey = await apiKeysDb.createApiKey(`${RUN_PREFIX}-key-9`, "machine-9");
  await groupsDb.addKeyToGroup(apiKey.id, group.id);

  const result = await groupsDb.checkKeyModelAccess(apiKey.id, "gpt-4o");
  assert.equal(result.allowed, false);
  assert.equal(result.deniedBy, null);
});

serialTest("checkKeyModelAccess respects the optional provider filter on rules", async () => {
  const group = await groupsDb.createKeyGroup(`${RUN_PREFIX}-provider-group`);
  await groupsDb.addGroupPermission(group.id, "gpt-4o", "allow", "openai");
  const apiKey = await apiKeysDb.createApiKey(`${RUN_PREFIX}-key-10`, "machine-10");
  await groupsDb.addKeyToGroup(apiKey.id, group.id);

  const matchingProvider = await groupsDb.checkKeyModelAccess(apiKey.id, "gpt-4o", "openai");
  assert.equal(matchingProvider.allowed, true);

  const nonMatchingProvider = await groupsDb.checkKeyModelAccess(apiKey.id, "gpt-4o", "azure");
  assert.equal(nonMatchingProvider.allowed, false);
});

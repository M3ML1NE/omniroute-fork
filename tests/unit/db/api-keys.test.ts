/**
 * Unit coverage for the api_keys DB layer — focused on the `scopes` column
 * and the audit-event emission contract for privileged scope changes.
 *
 * Migrated from SQLite/sync to async Postgres (Wave 4 / T19).
 * Reset strategy: TRUNCATE api_keys + audit_log before each test (Postgres).
 */

// Set env BEFORE any module imports so the pool picks up the right URL.
process.env.DATABASE_URL ||= "postgres://omniroute:omniroute@localhost:5432/omniroute_test";
process.env.API_KEY_SECRET ||= "test-api-key-secret";

import test from "node:test";
import assert from "node:assert/strict";

const { getPool } = await import("../../../src/lib/db/postgres.ts");
const apiKeysDb = await import("../../../src/lib/db/apiKeys.ts");
const compliance = await import("../../../src/lib/compliance/index.ts");
const { hasManageScope } = await import("../../../src/shared/constants/managementScopes.ts");

const MACHINE_ID = "machine1234567890";

/** logAuditEvent is fire-and-forget in production; give it a tick to commit. */
function flushAuditLog(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 100));
}

async function resetStorage() {
  // Clear in-memory caches (prepared-statement cache + key caches).
  apiKeysDb.resetApiKeyState();
  // Truncate the tables this suite touches so each test starts clean.
  await getPool().query("TRUNCATE api_keys, audit_log RESTART IDENTITY CASCADE");
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  apiKeysDb.resetApiKeyState();
  await getPool().query("TRUNCATE api_keys, audit_log RESTART IDENTITY CASCADE");
});

// ─────────────────────────────────────────────────────────────────────────────
// createApiKey + scopes round-trip
// ─────────────────────────────────────────────────────────────────────────────

test("createApiKey persists scopes to the api_keys row", async () => {
  const created = await apiKeysDb.createApiKey("with-manage", MACHINE_ID, ["manage"]);
  assert.ok(created.id);
  assert.ok(created.key);
  assert.deepEqual(created.scopes, ["manage"]);

  // Verify the row hit the DB by reading raw column.
  const { getDbInstance } = await import("../../../src/lib/db/core.ts");
  const db = getDbInstance();
  const row = await db.prepare("SELECT scopes FROM api_keys WHERE id = ?").get<{ scopes: string | null }>(created.id);
  assert.equal(row?.scopes, JSON.stringify(["manage"]));
});

test("createApiKey with default scopes writes an empty JSON array", async () => {
  const created = await apiKeysDb.createApiKey("no-scope", MACHINE_ID);
  const { getDbInstance } = await import("../../../src/lib/db/core.ts");
  const db = getDbInstance();
  const row = await db.prepare("SELECT scopes FROM api_keys WHERE id = ?").get<{ scopes: string | null }>(created.id);
  assert.equal(row?.scopes, "[]");
});

test("getApiKeyMetadata returns the scopes for a key created with manage", async () => {
  const created = await apiKeysDb.createApiKey("metadata-readback", MACHINE_ID, ["manage"]);
  const meta = await apiKeysDb.getApiKeyMetadata(created.key);
  assert.ok(meta);
  assert.deepEqual(meta!.scopes, ["manage"]);
  assert.equal(hasManageScope(meta!.scopes), true);
});

test("getApiKeyMetadata returns an empty scopes array for a key created without scopes", async () => {
  const created = await apiKeysDb.createApiKey("no-manage", MACHINE_ID);
  const meta = await apiKeysDb.getApiKeyMetadata(created.key);
  assert.ok(meta);
  assert.deepEqual(meta!.scopes, []);
  assert.equal(hasManageScope(meta!.scopes), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Legacy NULL scopes (pre-migration-032 row simulation)
// ─────────────────────────────────────────────────────────────────────────────

test("legacy rows with NULL scopes parse to an empty array and never hold manage", async () => {
  const created = await apiKeysDb.createApiKey("legacy-null", MACHINE_ID);
  // Simulate a pre-migration row by force-NULL on the scopes column.
  const { getDbInstance } = await import("../../../src/lib/db/core.ts");
  const db = getDbInstance();
  await db.prepare("UPDATE api_keys SET scopes = NULL WHERE id = ?").run(created.id);
  apiKeysDb.clearApiKeyCaches();

  const meta = await apiKeysDb.getApiKeyMetadata(created.key);
  assert.ok(meta);
  assert.deepEqual(meta!.scopes, []);
  assert.equal(hasManageScope(meta!.scopes), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// updateApiKeyPermissions — audit events for scope changes
// ─────────────────────────────────────────────────────────────────────────────

test("updateApiKeyPermissions granting manage emits apiKey.scopes.grant", async () => {
  const created = await apiKeysDb.createApiKey("for-grant", MACHINE_ID);

  const before = await compliance.getAuditLog({ limit: 100 });
  const beforeGrant = before.filter(
    (e) => e.action === "apiKey.scopes.grant" && e.target === created.id
  );
  assert.equal(beforeGrant.length, 0);

  const ok = await apiKeysDb.updateApiKeyPermissions(created.id, { scopes: ["manage"] });
  assert.equal(ok, true);
  await flushAuditLog();

  const after = await compliance.getAuditLog({ limit: 100 });
  const grants = after.filter((e) => e.action === "apiKey.scopes.grant" && e.target === created.id);
  assert.equal(grants.length, 1, "expected exactly one grant audit event");

  // Confirm the round-trip — manage should now be on the key.
  const meta = await apiKeysDb.getApiKeyMetadata(created.key);
  assert.ok(meta);
  assert.equal(hasManageScope(meta!.scopes), true);
});

test("updateApiKeyPermissions revoking manage emits apiKey.scopes.revoke", async () => {
  const created = await apiKeysDb.createApiKey("for-revoke", MACHINE_ID, ["manage"]);

  const ok = await apiKeysDb.updateApiKeyPermissions(created.id, { scopes: [] });
  assert.equal(ok, true);
  await flushAuditLog();

  const after = await compliance.getAuditLog({ limit: 100 });
  const revokes = after.filter(
    (e) => e.action === "apiKey.scopes.revoke" && e.target === created.id
  );
  assert.equal(revokes.length, 1, "expected exactly one revoke audit event");

  const meta = await apiKeysDb.getApiKeyMetadata(created.key);
  assert.ok(meta);
  assert.equal(hasManageScope(meta!.scopes), false);
});

test("updateApiKeyPermissions setting same manage scope does not emit duplicate audit events", async () => {
  const created = await apiKeysDb.createApiKey("idempotent-manage", MACHINE_ID, ["manage"]);

  const ok = await apiKeysDb.updateApiKeyPermissions(created.id, { scopes: ["manage"] });
  assert.equal(ok, true);
  await flushAuditLog();

  const after = await compliance.getAuditLog({ limit: 100 });
  const scopeEvents = after.filter(
    (e) =>
      (e.action === "apiKey.scopes.grant" ||
        e.action === "apiKey.scopes.revoke" ||
        e.action === "apiKey.scopes.update") &&
      e.target === created.id
  );
  assert.equal(
    scopeEvents.length,
    0,
    "no-op scope update should not emit grant/revoke/update events"
  );
});

test("updateApiKeyPermissions changing non-manage scopes emits apiKey.scopes.update", async () => {
  const created = await apiKeysDb.createApiKey("non-manage-update", MACHINE_ID, []);

  const ok = await apiKeysDb.updateApiKeyPermissions(created.id, { scopes: ["read:logs"] });
  assert.equal(ok, true);
  await flushAuditLog();

  const after = await compliance.getAuditLog({ limit: 100 });
  const updates = after.filter(
    (e) => e.action === "apiKey.scopes.update" && e.target === created.id
  );
  assert.equal(updates.length, 1, "expected exactly one non-manage scope update event");
});

// ─────────────────────────────────────────────────────────────────────────────
// Regression — scopes and ban state are orthogonal (T-008)
//
// The Permissions modal previously had two chips bound to `isBanned` (one
// labelled "Management API Access" with manage-scope copy). A user toggling
// it expected manage-scope grant; instead it flipped the ban flag. These
// tests guard against the inverse cross-wire ever returning: updating scopes
// must not touch isBanned, and toggling isBanned must not touch scopes.
// ─────────────────────────────────────────────────────────────────────────────

test("updating scopes to manage leaves isBanned untouched", async () => {
  const created = await apiKeysDb.createApiKey("banned-then-manage", MACHINE_ID, []);
  const banOk = await apiKeysDb.updateApiKeyPermissions(created.id, { isBanned: true });
  assert.equal(banOk, true);

  const ok = await apiKeysDb.updateApiKeyPermissions(created.id, { scopes: ["manage"] });
  assert.equal(ok, true);

  const meta = await apiKeysDb.getApiKeyMetadata(created.key);
  assert.ok(meta);
  assert.deepEqual(meta!.scopes, ["manage"]);
  assert.equal(meta!.isBanned, true, "ban flag must survive a scopes-only update");
});

test("toggling isBanned does not touch scopes", async () => {
  const created = await apiKeysDb.createApiKey("manage-then-ban", MACHINE_ID, ["manage"]);

  const banOk = await apiKeysDb.updateApiKeyPermissions(created.id, { isBanned: true });
  assert.equal(banOk, true);

  const meta = await apiKeysDb.getApiKeyMetadata(created.key);
  assert.ok(meta);
  assert.deepEqual(meta!.scopes, ["manage"], "scopes must survive a ban-only update");
  assert.equal(meta!.isBanned, true);

  const unbanOk = await apiKeysDb.updateApiKeyPermissions(created.id, { isBanned: false });
  assert.equal(unbanOk, true);

  const meta2 = await apiKeysDb.getApiKeyMetadata(created.key);
  assert.ok(meta2);
  assert.deepEqual(meta2!.scopes, ["manage"], "scopes must survive an unban update");
  assert.equal(meta2!.isBanned, false);
});

test("updateApiKeyPermissions without scopes field does not emit any scope audit event", async () => {
  const created = await apiKeysDb.createApiKey("no-scope-change", MACHINE_ID);

  const ok = await apiKeysDb.updateApiKeyPermissions(created.id, { name: "renamed" });
  assert.equal(ok, true);
  await flushAuditLog();

  const after = await compliance.getAuditLog({ limit: 100 });
  const scopeEvents = after.filter(
    (e) =>
      (e.action === "apiKey.scopes.grant" ||
        e.action === "apiKey.scopes.revoke" ||
        e.action === "apiKey.scopes.update") &&
      e.target === created.id
  );
  assert.equal(scopeEvents.length, 0);
});

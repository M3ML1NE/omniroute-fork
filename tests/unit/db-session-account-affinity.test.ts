import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-session-affinity-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const pgModule = await import("../../src/lib/db/postgres.ts");
const affinityDb = await import("../../src/lib/db/sessionAccountAffinity.ts");

const RUN_PREFIX = `session-affinity-${process.pid}`;

function serialTest(name: string, fn: () => Promise<void>) {
  test(name, { concurrency: false }, fn);
}

async function resetStorage() {
  const schema = pgModule.getSchema();
  await pgModule.query(
    `DELETE FROM ${schema}.key_value WHERE namespace = 'session_account_affinity'`
  );
  core.resetDbInstance();
}

test.beforeEach(async () => {
  await resetStorage();
  affinityDb.stopSessionAccountAffinityCleanupForTests();
});

test.after(async () => {
  await resetStorage();
  affinityDb.stopSessionAccountAffinityCleanupForTests();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function uniqueSessionKey(suffix: string): string {
  return `${RUN_PREFIX}-${suffix}-${Math.random().toString(16).slice(2, 8)}`;
}

// ── getSessionAccountAffinity guard clauses ─────────────────────────────────

serialTest("getSessionAccountAffinity returns null for an empty sessionKey/provider or non-positive ttlMs", async () => {
  assert.equal(await affinityDb.getSessionAccountAffinity("", "openai", 60000), null);
  assert.equal(await affinityDb.getSessionAccountAffinity("sess", "", 60000), null);
  assert.equal(await affinityDb.getSessionAccountAffinity("sess", "openai", 0), null);
  assert.equal(await affinityDb.getSessionAccountAffinity("sess", "openai", -1), null);
});

serialTest("getSessionAccountAffinity returns null when nothing has been stored for the key", async () => {
  const sessionKey = uniqueSessionKey("missing");
  const result = await affinityDb.getSessionAccountAffinity(sessionKey, "openai", 60000);
  assert.equal(result, null);
});

// ── upsertSessionAccountAffinity / getSessionAccountAffinity round-trip ─────

serialTest("upsertSessionAccountAffinity then getSessionAccountAffinity round-trips the connectionId", async () => {
  const sessionKey = uniqueSessionKey("roundtrip");
  const now = Date.now();
  await affinityDb.upsertSessionAccountAffinity(sessionKey, "openai", "conn-1", now, 60000);

  const result = await affinityDb.getSessionAccountAffinity(sessionKey, "openai", 60000, now);
  assert.ok(result);
  assert.equal(result!.connectionId, "conn-1");
  assert.equal(result!.createdAt, new Date(now).toISOString());
  assert.equal(result!.expiresAt, new Date(now + 60000).toISOString());
});

serialTest("upsertSessionAccountAffinity is a no-op for empty sessionKey/provider/connectionId or non-positive ttlMs", async () => {
  const sessionKey = uniqueSessionKey("noop");
  await affinityDb.upsertSessionAccountAffinity("", "openai", "conn-1", Date.now(), 60000);
  await affinityDb.upsertSessionAccountAffinity(sessionKey, "", "conn-1", Date.now(), 60000);
  await affinityDb.upsertSessionAccountAffinity(sessionKey, "openai", "", Date.now(), 60000);
  await affinityDb.upsertSessionAccountAffinity(sessionKey, "openai", "conn-1", Date.now(), 0);

  const result = await affinityDb.getSessionAccountAffinity(sessionKey, "openai", 60000);
  assert.equal(result, null);
});

serialTest("getSessionAccountAffinity returns null and deletes the row once expiresAt has passed", async () => {
  const sessionKey = uniqueSessionKey("expired");
  const past = Date.now() - 120000;
  await affinityDb.upsertSessionAccountAffinity(sessionKey, "openai", "conn-1", past, 60000);

  // The record's expiresAt (past + 60s) is already behind "now".
  const result = await affinityDb.getSessionAccountAffinity(sessionKey, "openai", 60000, Date.now());
  assert.equal(result, null);

  // Confirm it was actually deleted, not just filtered — a fresh read at
  // the original write time should also now miss.
  const secondRead = await affinityDb.getSessionAccountAffinity(sessionKey, "openai", 60000, past + 1000);
  assert.equal(secondRead, null);
});

serialTest("upsertSessionAccountAffinity preserves the original createdAt across repeated calls (same session)", async () => {
  const sessionKey = uniqueSessionKey("preserve-created");
  const firstWrite = Date.now();
  await affinityDb.upsertSessionAccountAffinity(sessionKey, "openai", "conn-1", firstWrite, 60000);

  const secondWrite = firstWrite + 1000;
  await affinityDb.upsertSessionAccountAffinity(sessionKey, "openai", "conn-2", secondWrite, 60000);

  const result = await affinityDb.getSessionAccountAffinity(sessionKey, "openai", 60000, secondWrite);
  assert.ok(result);
  assert.equal(result!.connectionId, "conn-2");
  assert.equal(result!.createdAt, new Date(firstWrite).toISOString());
  assert.equal(result!.lastUsedAt, new Date(secondWrite).toISOString());
});

serialTest("different providers for the same sessionKey do not collide (separate affinity keys)", async () => {
  const sessionKey = uniqueSessionKey("multi-provider");
  await affinityDb.upsertSessionAccountAffinity(sessionKey, "openai", "conn-openai", Date.now(), 60000);
  await affinityDb.upsertSessionAccountAffinity(sessionKey, "anthropic", "conn-anthropic", Date.now(), 60000);

  const openaiResult = await affinityDb.getSessionAccountAffinity(sessionKey, "openai", 60000);
  const anthropicResult = await affinityDb.getSessionAccountAffinity(sessionKey, "anthropic", 60000);
  assert.equal(openaiResult!.connectionId, "conn-openai");
  assert.equal(anthropicResult!.connectionId, "conn-anthropic");
});

// ── touchSessionAccountAffinity ─────────────────────────────────────────────

serialTest("touchSessionAccountAffinity extends expiresAt for an existing affinity", async () => {
  const sessionKey = uniqueSessionKey("touch");
  const now = Date.now();
  await affinityDb.upsertSessionAccountAffinity(sessionKey, "openai", "conn-1", now, 60000);

  const later = now + 30000;
  await affinityDb.touchSessionAccountAffinity(sessionKey, "openai", later, 60000);

  const result = await affinityDb.getSessionAccountAffinity(sessionKey, "openai", 60000, later);
  assert.ok(result);
  assert.equal(result!.expiresAt, new Date(later + 60000).toISOString());
  assert.equal(result!.connectionId, "conn-1");
});

serialTest("touchSessionAccountAffinity is a no-op when there is no existing affinity to extend", async () => {
  const sessionKey = uniqueSessionKey("touch-missing");
  await affinityDb.touchSessionAccountAffinity(sessionKey, "openai", Date.now(), 60000);

  const result = await affinityDb.getSessionAccountAffinity(sessionKey, "openai", 60000);
  assert.equal(result, null);
});

serialTest("touchSessionAccountAffinity is a no-op for a non-positive ttlMs", async () => {
  const sessionKey = uniqueSessionKey("touch-zero-ttl");
  const now = Date.now();
  await affinityDb.upsertSessionAccountAffinity(sessionKey, "openai", "conn-1", now, 60000);

  await assert.doesNotReject(
    affinityDb.touchSessionAccountAffinity(sessionKey, "openai", now + 1000, 0)
  );
});

// ── deleteSessionAccountAffinity ─────────────────────────────────────────────

serialTest("deleteSessionAccountAffinity removes the stored affinity", async () => {
  const sessionKey = uniqueSessionKey("delete");
  await affinityDb.upsertSessionAccountAffinity(sessionKey, "openai", "conn-1", Date.now(), 60000);

  await affinityDb.deleteSessionAccountAffinity(sessionKey, "openai");

  const result = await affinityDb.getSessionAccountAffinity(sessionKey, "openai", 60000);
  assert.equal(result, null);
});

serialTest("deleteSessionAccountAffinity does not throw for a missing sessionKey/provider pair", async () => {
  await assert.doesNotReject(
    affinityDb.deleteSessionAccountAffinity(uniqueSessionKey("delete-missing"), "openai")
  );
});

serialTest("deleteSessionAccountAffinity is a no-op for empty sessionKey/provider", async () => {
  await assert.doesNotReject(affinityDb.deleteSessionAccountAffinity("", "openai"));
  await assert.doesNotReject(affinityDb.deleteSessionAccountAffinity("sess", ""));
});

// ── cleanupStaleSessionAccountAffinities ────────────────────────────────────

serialTest("cleanupStaleSessionAccountAffinities deletes expired rows and returns the count deleted", async () => {
  const staleKey = uniqueSessionKey("stale");
  const freshKey = uniqueSessionKey("fresh");
  const past = Date.now() - 120000;
  const now = Date.now();

  // Write the stale row with a ttl that already elapsed relative to "now"
  // passed to cleanup below (past + 1000ms ttl << now).
  await affinityDb.upsertSessionAccountAffinity(staleKey, "openai", "conn-stale", past, 1000);
  await affinityDb.upsertSessionAccountAffinity(freshKey, "openai", "conn-fresh", now, 3600000);

  const deleted = await affinityDb.cleanupStaleSessionAccountAffinities(30 * 60 * 1000, now);
  assert.ok(deleted >= 1);

  // Fresh one should still be retrievable through a raw DB check (bypassing
  // getSessionAccountAffinity's own expiry-delete side effect).
  const db = core.getDbInstance();
  const freshRow = await db
    .prepare("SELECT value FROM key_value WHERE namespace = 'session_account_affinity' AND key LIKE ?")
    .all(`openai:%`);
  const stillHasFresh = freshRow.some((row: any) => {
    try {
      return JSON.parse(row.value).connectionId === "conn-fresh";
    } catch {
      return false;
    }
  });
  assert.ok(stillHasFresh);
});

serialTest("cleanupStaleSessionAccountAffinities returns 0 when there is nothing to clean", async () => {
  const deleted = await affinityDb.cleanupStaleSessionAccountAffinities();
  assert.equal(deleted, 0);
});

// ── start/stop cleanup timer lifecycle ──────────────────────────────────────

serialTest("startSessionAccountAffinityCleanup / stopSessionAccountAffinityCleanupForTests do not throw and are idempotent", async () => {
  assert.doesNotThrow(() => affinityDb.startSessionAccountAffinityCleanup());
  assert.doesNotThrow(() => affinityDb.startSessionAccountAffinityCleanup());
  assert.doesNotThrow(() => affinityDb.stopSessionAccountAffinityCleanupForTests());
  assert.doesNotThrow(() => affinityDb.stopSessionAccountAffinityCleanupForTests());
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-db-providers-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const pgModule = await import("../../src/lib/db/postgres.ts");
const providersDb = await import("../../src/lib/db/providers.ts");

const RUN_PREFIX = `db-providers-${process.pid}`;

function serialTest(name: string, fn: () => Promise<void>) {
  test(name, { concurrency: false }, fn);
}

async function resetStorage() {
  const schema = pgModule.getSchema();
  await pgModule.query(`DELETE FROM ${schema}.provider_connections WHERE name LIKE $1`, [
    `${RUN_PREFIX}-%`,
  ]);
  await pgModule.query(`DELETE FROM ${schema}.provider_nodes WHERE name LIKE $1`, [
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

// ── createProviderConnection / getProviderConnectionById ──────────────────

serialTest("createProviderConnection persists an apikey connection and assigns an incrementing priority", async () => {
  // Uses a unique provider name (not the shared "openai") because the
  // auto-increment priority query is scoped by provider across the whole
  // table — a shared provider name would collide with other test files
  // running concurrently against the same Postgres database.
  const provider = `test-provider-${uniqueName("priority")}`;
  const first = await providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name: uniqueName("first"),
    apiKey: "sk-first",
  });
  const second = await providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name: uniqueName("second"),
    apiKey: "sk-second",
  });
  assert.ok(first);
  assert.ok(second);
  assert.equal((second as any).priority, (first as any).priority + 1);
});

serialTest("createProviderConnection upserts an existing apikey connection by provider+name", async () => {
  const name = uniqueName("upsert");
  const created = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name,
    apiKey: "sk-v1",
  });
  assert.ok(created);
  const upserted = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name,
    apiKey: "sk-v2",
  });
  assert.ok(upserted);
  assert.equal((upserted as any).id, (created as any).id);

  const stored = await providersDb.getProviderConnectionById((created as any).id);
  assert.equal((stored as any).apiKey, "sk-v2");
});

serialTest("createProviderConnection upserts an existing oauth connection by provider+email", async () => {
  const email = `${uniqueName("oauth")}@example.com`;
  const created = await providersDb.createProviderConnection({
    provider: "anthropic",
    authType: "oauth",
    email,
    accessToken: "token-v1",
  });
  assert.ok(created);
  const upserted = await providersDb.createProviderConnection({
    provider: "anthropic",
    authType: "oauth",
    email,
    accessToken: "token-v2",
  });
  assert.equal((upserted as any).id, (created as any).id);

  const stored = await providersDb.getProviderConnectionById((created as any).id);
  assert.equal((stored as any).accessToken, "token-v2");
});

serialTest("getProviderConnectionById returns null for a missing id", async () => {
  const stored = await providersDb.getProviderConnectionById("does-not-exist");
  assert.equal(stored, null);
});

serialTest("createProviderConnection stores and sanitizes quotaWindowThresholds", async () => {
  const created = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: uniqueName("qwt"),
    apiKey: "sk-test",
    quotaWindowThresholds: { "5h": 80, invalid: 150, negative: -5, "weekly": 50 },
  });
  assert.ok(created);
  assert.deepEqual((created as any).quotaWindowThresholds, { "5h": 80, weekly: 50 });

  const stored = await providersDb.getProviderConnectionById((created as any).id);
  assert.deepEqual((stored as any).quotaWindowThresholds, { "5h": 80, weekly: 50 });
});

serialTest("createProviderConnection stores quotaWindowThresholds as null when all entries are invalid", async () => {
  const created = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: uniqueName("qwt-empty"),
    apiKey: "sk-test",
    quotaWindowThresholds: { bad: 999 },
  });
  assert.ok(created);
  assert.equal((created as any).quotaWindowThresholds, null);
});

// ── updateProviderConnection ───────────────────────────────────────────────

serialTest("updateProviderConnection merges new fields and bumps updatedAt", async () => {
  const created = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: uniqueName("update"),
    apiKey: "sk-v1",
  });
  assert.ok(created);
  const originalUpdatedAt = (created as any).updatedAt;

  await new Promise((resolve) => setTimeout(resolve, 5));
  const updated = await providersDb.updateProviderConnection((created as any).id, {
    apiKey: "sk-v2",
    lastError: "boom",
  });
  assert.ok(updated);
  assert.equal((updated as any).apiKey, "sk-v2");
  assert.equal((updated as any).lastError, "boom");
  assert.notEqual((updated as any).updatedAt, originalUpdatedAt);
});

serialTest("updateProviderConnection returns null for a missing id", async () => {
  const result = await providersDb.updateProviderConnection("does-not-exist", { apiKey: "x" });
  assert.equal(result, null);
});

serialTest("updateProviderConnection reorders connections when priority changes", async () => {
  const provider = `test-provider-${uniqueName("reorder")}`;
  const a = await providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name: uniqueName("a"),
    apiKey: "sk-a",
  });
  const b = await providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name: uniqueName("b"),
    apiKey: "sk-b",
  });
  assert.ok(a);
  assert.ok(b);

  await providersDb.updateProviderConnection((b as any).id, { priority: 1 });

  const connections = await providersDb.getProviderConnections({ provider });
  assert.equal(connections.length, 2);
  const priorities = connections.map((c: any) => c.priority).sort((x: number, y: number) => x - y);
  assert.deepEqual(priorities, [1, 2]);
});

// ── deleteProviderConnection / deleteProviderConnections ──────────────────

serialTest("deleteProviderConnection removes the row and returns true", async () => {
  const created = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: uniqueName("delete"),
    apiKey: "sk-test",
  });
  assert.ok(created);
  const deleted = await providersDb.deleteProviderConnection((created as any).id);
  assert.equal(deleted, true);

  const stored = await providersDb.getProviderConnectionById((created as any).id);
  assert.equal(stored, null);
});

serialTest("deleteProviderConnection returns false for a missing id", async () => {
  const deleted = await providersDb.deleteProviderConnection("does-not-exist");
  assert.equal(deleted, false);
});

serialTest("deleteProviderConnections bulk-deletes and returns the deleted count", async () => {
  const a = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: uniqueName("bulk-a"),
    apiKey: "sk-a",
  });
  const b = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: uniqueName("bulk-b"),
    apiKey: "sk-b",
  });
  assert.ok(a);
  assert.ok(b);

  const deletedCount = await providersDb.deleteProviderConnections([
    (a as any).id,
    (b as any).id,
  ]);
  assert.equal(deletedCount, 2);
  assert.equal(await providersDb.getProviderConnectionById((a as any).id), null);
  assert.equal(await providersDb.getProviderConnectionById((b as any).id), null);
});

serialTest("deleteProviderConnections returns 0 for an empty id list without querying the db", async () => {
  const deletedCount = await providersDb.deleteProviderConnections([]);
  assert.equal(deletedCount, 0);
});

serialTest("deleteProviderConnectionsByProvider removes all connections for that provider", async () => {
  const provider = `test-provider-${uniqueName("byprov")}`;
  await providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name: uniqueName("p1"),
    apiKey: "sk-1",
  });
  await providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name: uniqueName("p2"),
    apiKey: "sk-2",
  });

  const changes = await providersDb.deleteProviderConnectionsByProvider(provider);
  assert.equal(changes, 2);

  const remaining = await providersDb.getProviderConnections({ provider });
  assert.equal(remaining.length, 0);
});

// ── getProviderConnections filters ─────────────────────────────────────────

serialTest("getProviderConnections filters by provider and isActive", async () => {
  const provider = `test-provider-${uniqueName("filter")}`;
  const active = await providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name: uniqueName("active"),
    apiKey: "sk-active",
    isActive: true,
  });
  const inactive = await providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name: uniqueName("inactive"),
    apiKey: "sk-inactive",
    isActive: false,
  });
  assert.ok(active);
  assert.ok(inactive);

  const activeOnly = await providersDb.getProviderConnections({ provider, isActive: true });
  assert.equal(activeOnly.length, 1);
  assert.equal((activeOnly[0] as any).id, (active as any).id);

  const inactiveOnly = await providersDb.getProviderConnections({ provider, isActive: false });
  assert.equal(inactiveOnly.length, 1);
  assert.equal((inactiveOnly[0] as any).id, (inactive as any).id);
});

// ── getDistinctGroups ───────────────────────────────────────────────────────

serialTest("getDistinctGroups returns unique, non-null group names", async () => {
  const groupName = uniqueName("group");
  await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: uniqueName("g1"),
    apiKey: "sk-g1",
    group: groupName,
  });
  await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: uniqueName("g2"),
    apiKey: "sk-g2",
    group: groupName,
  });

  const groups = await providersDb.getDistinctGroups();
  assert.ok(groups.includes(groupName));
});

// ── Provider Nodes CRUD ──────────────────────────────────────────────────

serialTest("createProviderNode / getProviderNodeById round-trips mtls config", async () => {
  const node = await providersDb.createProviderNode({
    type: "openai-compatible",
    name: uniqueName("node"),
    baseUrl: "https://example.com/v1",
    mtls: { certPath: "/tmp/cert.pem", keyPath: "/tmp/key.pem" },
  });
  assert.ok(node);
  assert.deepEqual((node as any).mtls, { certPath: "/tmp/cert.pem", keyPath: "/tmp/key.pem" });

  const stored = await providersDb.getProviderNodeById((node as any).id);
  assert.ok(stored);
  assert.deepEqual((stored as any).mtls, { certPath: "/tmp/cert.pem", keyPath: "/tmp/key.pem" });
  assert.equal("mtlsJson" in (stored as any), false);
});

serialTest("getProviderNodeById returns null for a missing id", async () => {
  const stored = await providersDb.getProviderNodeById("does-not-exist");
  assert.equal(stored, null);
});

serialTest("updateProviderNode merges fields and persists the updated mtls config", async () => {
  const node = await providersDb.createProviderNode({
    type: "openai-compatible",
    name: uniqueName("node-update"),
    baseUrl: "https://example.com/v1",
  });
  assert.ok(node);

  const updated = await providersDb.updateProviderNode((node as any).id, {
    baseUrl: "https://updated.example.com/v1",
    mtls: { certPath: "/tmp/new-cert.pem" },
  });
  assert.ok(updated);
  assert.equal((updated as any).baseUrl, "https://updated.example.com/v1");
  assert.deepEqual((updated as any).mtls, { certPath: "/tmp/new-cert.pem" });
});

serialTest("updateProviderNode returns null for a missing id", async () => {
  const result = await providersDb.updateProviderNode("does-not-exist", { name: "x" });
  assert.equal(result, null);
});

serialTest("deleteProviderNode removes the row and returns the deleted record", async () => {
  const node = await providersDb.createProviderNode({
    type: "openai-compatible",
    name: uniqueName("node-delete"),
    baseUrl: "https://example.com/v1",
  });
  assert.ok(node);

  const deleted = await providersDb.deleteProviderNode((node as any).id);
  assert.ok(deleted);
  assert.equal((deleted as any).id, (node as any).id);

  const stored = await providersDb.getProviderNodeById((node as any).id);
  assert.equal(stored, null);
});

serialTest("deleteProviderNode returns null for a missing id", async () => {
  const result = await providersDb.deleteProviderNode("does-not-exist");
  assert.equal(result, null);
});

serialTest("getProviderNodes filters by type", async () => {
  const typeName = `test-type-${uniqueName("filter")}`;
  await providersDb.createProviderNode({
    type: typeName,
    name: uniqueName("node-a"),
    baseUrl: "https://a.example.com/v1",
  });
  await providersDb.createProviderNode({
    type: "some-other-type",
    name: uniqueName("node-b"),
    baseUrl: "https://b.example.com/v1",
  });

  const nodes = await providersDb.getProviderNodes({ type: typeName });
  assert.equal(nodes.length, 1);
  assert.equal((nodes[0] as any).type, typeName);
});

// ── Rate-limit persistence (T05) ────────────────────────────────────────────

serialTest("setConnectionRateLimitUntil / isConnectionRateLimited round-trip a future timestamp", async () => {
  const created = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: uniqueName("ratelimit"),
    apiKey: "sk-test",
  });
  assert.ok(created);
  const connectionId = (created as any).id;

  assert.equal(await providersDb.isConnectionRateLimited(connectionId), false);

  const future = Date.now() + 60_000;
  await providersDb.setConnectionRateLimitUntil(connectionId, future);
  assert.equal(await providersDb.isConnectionRateLimited(connectionId), true);

  await providersDb.setConnectionRateLimitUntil(connectionId, null);
  assert.equal(await providersDb.isConnectionRateLimited(connectionId), false);
});

serialTest("isConnectionRateLimited returns false once the timestamp is in the past", async () => {
  const created = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: uniqueName("ratelimit-past"),
    apiKey: "sk-test",
  });
  assert.ok(created);
  const connectionId = (created as any).id;

  await providersDb.setConnectionRateLimitUntil(connectionId, Date.now() - 60_000);
  assert.equal(await providersDb.isConnectionRateLimited(connectionId), false);
});

serialTest("isConnectionRateLimited returns false for a missing connection", async () => {
  assert.equal(await providersDb.isConnectionRateLimited("does-not-exist"), false);
});

serialTest("getRateLimitedConnections returns only currently rate-limited connections for a provider", async () => {
  const provider = `test-provider-${uniqueName("rl-list")}`;
  const limited = await providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name: uniqueName("limited"),
    apiKey: "sk-limited",
  });
  const notLimited = await providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name: uniqueName("not-limited"),
    apiKey: "sk-not-limited",
  });
  assert.ok(limited);
  assert.ok(notLimited);

  const future = Date.now() + 60_000;
  await providersDb.setConnectionRateLimitUntil((limited as any).id, future);

  const results = await providersDb.getRateLimitedConnections(provider);
  assert.equal(results.length, 1);
  assert.equal(results[0].id, (limited as any).id);
  assert.equal(results[0].rateLimitedUntil, future);
});

serialTest("clearProviderConnectionCooldowns resets rate limit and error state and returns the changed count", async () => {
  const created = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: uniqueName("clear-cooldown"),
    apiKey: "sk-test",
  });
  assert.ok(created);
  const connectionId = (created as any).id;

  await providersDb.setConnectionRateLimitUntil(connectionId, Date.now() + 60_000);
  await providersDb.updateProviderConnection(connectionId, {
    testStatus: "error",
    lastError: "some failure",
    errorCode: "429",
  });

  const changes = await providersDb.clearProviderConnectionCooldowns();
  assert.ok(changes >= 1);

  // cleanNulls strips null fields from the returned object entirely (except
  // the explicitly-preserved maxConcurrent/quotaWindowThresholds), so a
  // cleared field reads back as undefined rather than null.
  const stored = await providersDb.getProviderConnectionById(connectionId);
  assert.equal((stored as any).rateLimitedUntil, undefined);
  assert.equal((stored as any).testStatus, "active");
  assert.equal((stored as any).lastError, undefined);
  assert.equal((stored as any).errorCode, undefined);
});

// ── T13: Stale quota display helpers (pure functions) ──────────────────────

test("getEffectiveQuotaUsage returns the original value when resetAt is null/undefined", () => {
  assert.equal(providersDb.getEffectiveQuotaUsage(42, null), 42);
  assert.equal(providersDb.getEffectiveQuotaUsage(42, undefined), 42);
});

test("getEffectiveQuotaUsage returns 0 once the reset window has passed", () => {
  const past = Date.now() - 60_000;
  assert.equal(providersDb.getEffectiveQuotaUsage(42, past), 0);
});

test("getEffectiveQuotaUsage returns the original value while the window is still open", () => {
  const future = Date.now() + 60_000;
  assert.equal(providersDb.getEffectiveQuotaUsage(42, future), 42);
});

test("getEffectiveQuotaUsage returns the original value when resetAt is unparseable", () => {
  assert.equal(providersDb.getEffectiveQuotaUsage(42, "not-a-date"), 42);
});

test("formatResetCountdown returns null for null/past/unparseable resetAt", () => {
  assert.equal(providersDb.formatResetCountdown(null), null);
  assert.equal(providersDb.formatResetCountdown(Date.now() - 1000), null);
  assert.equal(providersDb.formatResetCountdown("not-a-date"), null);
});

test("formatResetCountdown formats hours/minutes for a multi-hour window", () => {
  const future = Date.now() + 2 * 3600 * 1000 + 35 * 60 * 1000;
  const formatted = providersDb.formatResetCountdown(future);
  assert.equal(formatted, "2h 35m");
});

test("formatResetCountdown formats minutes/seconds for a sub-hour window", () => {
  const future = Date.now() + 4 * 60 * 1000 + 30 * 1000;
  const formatted = providersDb.formatResetCountdown(future);
  assert.equal(formatted, "4m 30s");
});

test("formatResetCountdown formats seconds only for a sub-minute window", () => {
  const future = Date.now() + 45 * 1000;
  const formatted = providersDb.formatResetCountdown(future);
  assert.match(formatted as string, /^\d+s$/);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-mark-5xx-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const pgModule = await import("../../src/lib/db/postgres.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const auth = await import("../../src/sse/services/auth.ts");

const RUN_PREFIX = `mark-5xx-${process.pid}`;

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

test.after(async () => {
  await resetStorage();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

async function seedConnection(provider: string): Promise<string> {
  const created = await providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name: `${RUN_PREFIX}-${Math.random().toString(16).slice(2, 8)}`,
    apiKey: "sk-test",
  });
  return (created as { id: string }).id;
}

async function readState(
  id: string
): Promise<{ testStatus: string | null; rateLimitedUntil: unknown }> {
  const schema = pgModule.getSchema();
  const rows = (await pgModule.query(
    `SELECT test_status, rate_limited_until FROM ${schema}.provider_connections WHERE id = $1`,
    [id]
  )) as unknown as { rows: { test_status: string | null; rate_limited_until: unknown }[] };
  const row = rows.rows[0];
  return { testStatus: row?.test_status ?? null, rateLimitedUntil: row?.rate_limited_until ?? null };
}

serialTest("502 on a compatible provider does NOT persist testStatus / rateLimitedUntil", async () => {
  const id = await seedConnection("openai-compatible-mark5xx");

  await auth.markAccountUnavailable(id, 502, "Bad Gateway", "openai-compatible-mark5xx", "gpt-4");

  const state = await readState(id);
  assert.notEqual(state.testStatus, "unavailable", "502 must not set testStatus=unavailable");
  assert.equal(state.rateLimitedUntil, null, "502 must not set rateLimitedUntil");
});

serialTest("429 on a connection-scoped provider DOES persist testStatus + rateLimitedUntil", async () => {
  // "openai" is not a per-model-quota provider, so 429 takes the connection-scoped
  // cooldown path (the behavior that must stay unchanged by this fix).
  const id = await seedConnection("openai");

  await auth.markAccountUnavailable(id, 429, "Rate limit exceeded", "openai", "gpt-4");

  const state = await readState(id);
  assert.equal(state.testStatus, "unavailable", "429 must set testStatus=unavailable");
  assert.ok(state.rateLimitedUntil, "429 must set a rateLimitedUntil timestamp");
});

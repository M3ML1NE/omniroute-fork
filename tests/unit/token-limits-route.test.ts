import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Regression test for the missing-`await` bug in
// src/app/api/usage/token-limits/route.ts::GET — `listTokenLimits()` and
// `getWindowUsage()` are async (Promise-returning) after the Postgres
// migration, but the route called them synchronously. That produced
// `TypeError: listTokenLimits(...).map is not a function` on every request
// (confirmed live at GET /api/usage/token-limits?apiKeyId=...).

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-token-limits-route-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const pgModule = await import("../../src/lib/db/postgres.ts");
const tokenLimitsDb = await import("../../src/lib/db/tokenLimits.ts");
const route = await import("../../src/app/api/usage/token-limits/route.ts");

const RUN_PREFIX = `token-limits-route-${process.pid}`;
const API_KEY = `${RUN_PREFIX}-key`;

function serialTest(name: string, fn: () => Promise<void>) {
  test(name, { concurrency: false }, fn);
}

async function resetStorage() {
  const schema = pgModule.getSchema();
  await pgModule.query(
    `DELETE FROM ${schema}.api_key_token_counters WHERE limit_id IN (SELECT id FROM ${schema}.api_key_token_limits WHERE api_key_id = $1)`,
    [API_KEY]
  );
  await pgModule.query(
    `DELETE FROM ${schema}.api_key_token_limit_reset_logs WHERE limit_id IN (SELECT id FROM ${schema}.api_key_token_limits WHERE api_key_id = $1)`,
    [API_KEY]
  );
  await pgModule.query(`DELETE FROM ${schema}.api_key_token_limits WHERE api_key_id = $1`, [
    API_KEY,
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

function makeRequest(apiKeyId: string): Request {
  return new Request(
    `http://localhost/api/usage/token-limits?apiKeyId=${encodeURIComponent(apiKeyId)}`,
    { method: "GET" }
  );
}

serialTest(
  "GET /api/usage/token-limits returns a resolved array of limit objects, not a thrown TypeError",
  async () => {
    await tokenLimitsDb.upsertTokenLimit({
      apiKeyId: API_KEY,
      scopeType: "global",
      tokenLimit: 100000,
    });
    await tokenLimitsDb.upsertTokenLimit({
      apiKeyId: API_KEY,
      scopeType: "model",
      scopeValue: "gpt-4o",
      tokenLimit: 5000,
    });

    const res = await route.GET(makeRequest(API_KEY));
    assert.equal(res.status, 200);

    const body = (await res.json()) as {
      apiKeyId: string;
      limits: Array<Record<string, unknown>>;
    };
    assert.equal(body.apiKeyId, API_KEY);
    assert.equal(Array.isArray(body.limits), true, "limits must be a resolved array, not a Promise");
    assert.equal(body.limits.length, 2);

    for (const limit of body.limits) {
      assert.equal(typeof limit.tokensUsed, "number");
      assert.equal(typeof limit.windowStart, "string");
      assert.equal(typeof limit.periodStartAt, "number");
      assert.equal(typeof limit.nextResetAt, "number");
      assert.equal(typeof limit.remaining, "number");
      assert.ok(limit.remaining as number >= 0);
    }
  }
);

serialTest(
  "GET /api/usage/token-limits reflects recorded usage in tokensUsed and remaining",
  async () => {
    const created = await tokenLimitsDb.upsertTokenLimit({
      apiKeyId: API_KEY,
      scopeType: "global",
      tokenLimit: 1000,
      resetInterval: "daily",
    });
    const { windowStart } = tokenLimitsDb.resetWindowIfElapsed(created);
    await tokenLimitsDb.incrementWindowTokens(created.id, windowStart, 300);

    const res = await route.GET(makeRequest(API_KEY));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { limits: Array<Record<string, unknown>> };
    assert.equal(body.limits.length, 1);
    assert.equal(body.limits[0].tokensUsed, 300);
    assert.equal(body.limits[0].remaining, 700);
  }
);

serialTest("GET /api/usage/token-limits requires apiKeyId", async () => {
  const res = await route.GET(new Request("http://localhost/api/usage/token-limits"));
  assert.equal(res.status, 400);
});

serialTest(
  "GET /api/usage/token-limits returns an empty array for an api key with no limits",
  async () => {
    const res = await route.GET(makeRequest(`${API_KEY}-none`));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { limits: unknown[] };
    assert.deepEqual(body.limits, []);
  }
);

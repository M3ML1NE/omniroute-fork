import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-memory-route-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const pgModule = await import("../../src/lib/db/postgres.ts");
const store = await import("../../src/lib/memory/store.ts");
const memoryRoute = await import("../../src/app/api/memory/route.ts");
const { MemoryType } = await import("../../src/lib/memory/types.ts");

const RUN_PREFIX = `memory-route-${process.pid}`;
const API_KEY_A = `${RUN_PREFIX}-key-a`;
const SESSION_A = `${RUN_PREFIX}-session-a`;

function serialTest(name: string, fn: () => Promise<void>) {
  test(name, { concurrency: false }, fn);
}

async function resetStorage() {
  const schema = pgModule.getSchema();
  await pgModule.query(`DELETE FROM ${schema}.memories WHERE api_key_id = $1`, [API_KEY_A]);
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function seedMemories() {
  await store.createMemory({
    apiKeyId: API_KEY_A,
    sessionId: SESSION_A,
    type: MemoryType.FACTUAL,
    key: "typescript:guide",
    content: "TypeScript setup guide",
    metadata: {},
    expiresAt: null,
  });
  await store.createMemory({
    apiKeyId: API_KEY_A,
    sessionId: SESSION_A,
    type: MemoryType.EPISODIC,
    key: "deploy:runbook",
    content: "Production deployment runbook",
    metadata: {},
    expiresAt: null,
  });
  await store.createMemory({
    apiKeyId: API_KEY_A,
    sessionId: SESSION_A,
    type: MemoryType.SEMANTIC,
    key: "typescript:tooling",
    content: "Lint and editor integration",
    metadata: {},
    expiresAt: null,
  });
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

serialTest("GET /api/memory filters by q and returns matching stats", async () => {
  await seedMemories();

  const response = await memoryRoute.GET(
    new Request(`http://localhost/api/memory?apiKeyId=${API_KEY_A}&q=typescript&limit=20&page=1`)
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    data: Array<{ key: string }>;
    total: number;
    stats: { total: number; byType: Record<string, number> };
  };

  assert.deepEqual(body.data.map((memory) => memory.key).sort(), [
    "typescript:guide",
    "typescript:tooling",
  ]);
  assert.equal(body.total, 2);
  assert.equal(body.stats.total, 2);
  assert.deepEqual(body.stats.byType, { factual: 1, semantic: 1 });
});

serialTest("GET /api/memory continues to honor limit+offset requests", async () => {
  await seedMemories();

  const response = await memoryRoute.GET(
    new Request(`http://localhost/api/memory?apiKeyId=${API_KEY_A}&limit=1&offset=1`)
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as any;

  assert.equal(body.data.length, 1);
  assert.equal(body.total, 3);
  assert.equal(body.page, 2);
});

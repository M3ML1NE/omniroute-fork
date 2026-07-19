import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-memory-store-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const pgModule = await import("../../src/lib/db/postgres.ts");
const store = await import("../../src/lib/memory/store.ts");
const { MemoryType } = await import("../../src/lib/memory/types.ts");

const RUN_PREFIX = `memory-store-${process.pid}`;
const API_KEY_A = `${RUN_PREFIX}-key-a`;
const API_KEY_B = `${RUN_PREFIX}-key-b`;
const SESSION_A = `${RUN_PREFIX}-session-a`;
const SESSION_B = `${RUN_PREFIX}-session-b`;
function serialTest(name: string, fn: () => Promise<void>) {
  test(name, { concurrency: false }, fn);
}

const TEST_MEMORY_IDS = [
  "broken-metadata",
  "mem-1",
  "mem-2",
  "mem-3",
  "page-1",
  "page-2",
  "page-3",
  "search-1",
  "search-2",
  "search-3",
  "pg-1",
  "pg-2",
  "pg-3",
  "tok-1",
  "tok-2",
] as const;

async function resetStorage() {
  const schema = pgModule.getSchema();
  await pgModule.query(
    `DELETE FROM ${schema}.memories WHERE api_key_id LIKE $1 OR id = ANY($2::text[])`,
    [`${RUN_PREFIX}-%`, [...TEST_MEMORY_IDS]]
  );
  core.resetDbInstance();

  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      if (fs.existsSync(TEST_DATA_DIR)) {
        fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
      }
      break;
    } catch (error: any) {
      if ((error?.code === "EBUSY" || error?.code === "EPERM") && attempt < 9) {
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      } else {
        throw error;
      }
    }
  }

  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function insertMemoryRow({
  id,
  apiKeyId = API_KEY_A,
  sessionId = SESSION_A,
  type = "factual",
  key = "memory:key",
  content = "stored content",
  metadata = "{}",
  createdAt = new Date().toISOString(),
  updatedAt = createdAt,
  expiresAt = null,
}) {
  const db = core.getDbInstance();
  await db
    .prepare(
      `INSERT INTO memories (
        id, api_key_id, session_id, type, key, content, metadata, created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, apiKeyId, sessionId, type, key, content, metadata, createdAt, updatedAt, expiresAt);
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

serialTest("memory store CRUD round-trip persists to the memories table and invalidates cache on update/delete", async () => {
  const expiresAt = new Date("2026-04-06T00:00:00.000Z");
  const created = await store.createMemory({
    apiKeyId: API_KEY_A,
    sessionId: SESSION_A,
    type: MemoryType.FACTUAL,
    key: "preference:theme",
    content: "User prefers a compact dashboard",
    metadata: { source: "test" },
    expiresAt,
  });

  const fetched = await store.getMemory(created.id);
  assert.equal(fetched?.apiKeyId, API_KEY_A);
  assert.equal(fetched?.key, "preference:theme");
  assert.deepEqual(fetched?.metadata, { source: "test" });
  assert.equal(fetched?.expiresAt?.toISOString(), expiresAt.toISOString());

  const updated = await store.updateMemory(created.id, {
    type: MemoryType.EPISODIC,
    key: "decision:layout",
    content: "Switched to the analytics-first layout",
    metadata: { source: "update" },
    expiresAt: null,
  });
  assert.equal(updated, true);

  const refreshed = await store.getMemory(created.id);
  assert.equal(refreshed?.type, MemoryType.EPISODIC);
  assert.equal(refreshed?.content, "Switched to the analytics-first layout");
  assert.deepEqual(refreshed?.metadata, { source: "update" });
  assert.equal(refreshed?.expiresAt, null);

  assert.equal(await store.deleteMemory(created.id), true);
  assert.equal(await store.getMemory(created.id), null);
  assert.equal(await store.deleteMemory(created.id), false);
});

serialTest("getMemory returns null for invalid identifiers and tolerates malformed metadata rows", async () => {
  assert.equal(await store.getMemory(""), null);
  assert.equal(await store.getMemory("missing-id"), null);

  await insertMemoryRow({
    id: "broken-metadata",
    metadata: "{not-json",
    content: "Corrupt metadata should not break reads",
  });

  const fetched = await store.getMemory("broken-metadata");
  assert.equal(fetched?.content, "Corrupt metadata should not break reads");
  assert.deepEqual(fetched?.metadata, {});
});

serialTest("updateMemory returns false for missing ids and listMemories handles an empty store", async () => {
  assert.equal(await store.updateMemory("missing-id", { content: "noop" }), false);
  const result = await store.listMemories({ apiKeyId: "missing-key" });
  assert.deepEqual(result.data, []);
  assert.equal(result.total, 0);
});

serialTest("listMemories filters by api key, type and session while preserving newest-first ordering", async () => {
  await insertMemoryRow({
    id: "mem-1",
    apiKeyId: API_KEY_A,
    sessionId: SESSION_A,
    type: "factual",
    key: "pref:1",
    content: "Older factual memory",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
  });
  await insertMemoryRow({
    id: "mem-2",
    apiKeyId: API_KEY_A,
    sessionId: SESSION_A,
    type: "episodic",
    key: "decision:1",
    content: "Newest episodic memory",
    createdAt: "2026-04-03T00:00:00.000Z",
    updatedAt: "2026-04-03T00:00:00.000Z",
  });
  await insertMemoryRow({
    id: "mem-3",
    apiKeyId: API_KEY_B,
    sessionId: SESSION_B,
    type: "semantic",
    key: "semantic:1",
    content: "Different api key",
    createdAt: "2026-04-02T00:00:00.000Z",
    updatedAt: "2026-04-02T00:00:00.000Z",
  });

  const allForKeyA = await store.listMemories({ apiKeyId: API_KEY_A });
  const onlySessionA = await store.listMemories({ apiKeyId: API_KEY_A, sessionId: SESSION_A });
  const onlyEpisodic = await store.listMemories({ apiKeyId: API_KEY_A, type: MemoryType.EPISODIC });

  assert.deepEqual(
    allForKeyA.data.map((memory) => memory.id),
    ["mem-2", "mem-1"]
  );
  assert.equal(allForKeyA.total, 2);
  assert.deepEqual(
    onlySessionA.data.map((memory) => memory.id),
    ["mem-2", "mem-1"]
  );
  assert.equal(onlySessionA.total, 2);
  assert.deepEqual(
    onlyEpisodic.data.map((memory) => memory.id),
    ["mem-2"]
  );
  assert.equal(onlyEpisodic.total, 1);
});

serialTest("listMemories supports limit and offset pagination even when only offset is provided", async () => {
  await insertMemoryRow({
    id: "page-1",
    key: "pagination:1",
    content: "oldest",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
  });
  await insertMemoryRow({
    id: "page-2",
    key: "pagination:2",
    content: "middle",
    createdAt: "2026-04-02T00:00:00.000Z",
    updatedAt: "2026-04-02T00:00:00.000Z",
  });
  await insertMemoryRow({
    id: "page-3",
    key: "pagination:3",
    content: "newest",
    createdAt: "2026-04-03T00:00:00.000Z",
    updatedAt: "2026-04-03T00:00:00.000Z",
  });

  const paged = await store.listMemories({ apiKeyId: API_KEY_A, limit: 1, offset: 1 });
  const offsetOnly = await store.listMemories({ apiKeyId: API_KEY_A, offset: 1 });

  assert.deepEqual(
    paged.data.map((memory) => memory.id),
    ["page-2"]
  );
  assert.equal(paged.total, 3);
  assert.deepEqual(
    offsetOnly.data.map((memory) => memory.id),
    ["page-2", "page-1"]
  );
  assert.equal(offsetOnly.total, 3);
});

serialTest("listMemories applies query filtering before pagination and type stats", async () => {
  await insertMemoryRow({
    id: "search-1",
    key: "typescript:guide",
    content: "TypeScript project setup",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
  });
  await insertMemoryRow({
    id: "search-2",
    type: "episodic",
    key: "deployment:note",
    content: "Production deployment checklist",
    createdAt: "2026-04-02T00:00:00.000Z",
    updatedAt: "2026-04-02T00:00:00.000Z",
  });
  await insertMemoryRow({
    id: "search-3",
    type: "semantic",
    key: "tooling:typescript",
    content: "Editor plugins and linting",
    createdAt: "2026-04-03T00:00:00.000Z",
    updatedAt: "2026-04-03T00:00:00.000Z",
  });

  const filtered = await store.listMemories({
    apiKeyId: API_KEY_A,
    query: "typescript",
    limit: 10,
  });

  assert.deepEqual(
    filtered.data.map((memory) => memory.id),
    ["search-3", "search-1"]
  );
  assert.equal(filtered.total, 2);
  assert.deepEqual(filtered.byType, { factual: 1, semantic: 1 });
});

serialTest("listMemories supports page-based pagination (page 1)", async () => {
  await insertMemoryRow({
    id: "pg-1",
    key: "page:test:1",
    content: "first",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
  });
  await insertMemoryRow({
    id: "pg-2",
    key: "page:test:2",
    content: "second",
    createdAt: "2026-04-02T00:00:00.000Z",
    updatedAt: "2026-04-02T00:00:00.000Z",
  });
  await insertMemoryRow({
    id: "pg-3",
    key: "page:test:3",
    content: "third",
    createdAt: "2026-04-03T00:00:00.000Z",
    updatedAt: "2026-04-03T00:00:00.000Z",
  });

  const page1 = await store.listMemories({ apiKeyId: API_KEY_A, page: 1, limit: 2 });
  assert.deepEqual(
    page1.data.map((m) => m.id),
    ["pg-3", "pg-2"]
  );
  assert.equal(page1.total, 3);
});

serialTest("listMemories supports page-based pagination (page 2 returns remainder)", async () => {
  await insertMemoryRow({
    id: "pg-1",
    key: "page:test:1",
    content: "first",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
  });
  await insertMemoryRow({
    id: "pg-2",
    key: "page:test:2",
    content: "second",
    createdAt: "2026-04-02T00:00:00.000Z",
    updatedAt: "2026-04-02T00:00:00.000Z",
  });
  await insertMemoryRow({
    id: "pg-3",
    key: "page:test:3",
    content: "third",
    createdAt: "2026-04-03T00:00:00.000Z",
    updatedAt: "2026-04-03T00:00:00.000Z",
  });

  const page2 = await store.listMemories({ apiKeyId: API_KEY_A, page: 2, limit: 2 });
  assert.deepEqual(
    page2.data.map((m) => m.id),
    ["pg-1"]
  );
  assert.equal(page2.total, 3);
});

serialTest("listMemories returns empty data for a page beyond the result set", async () => {
  await insertMemoryRow({
    id: "pg-1",
    key: "page:test:1",
    content: "only entry",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
  });

  const beyondPage = await store.listMemories({ apiKeyId: API_KEY_A, page: 99, limit: 10 });
  assert.deepEqual(beyondPage.data, []);
  assert.equal(beyondPage.total, 1);
});

serialTest("listMemories page parameter defaults to page 1 when omitted with limit", async () => {
  await insertMemoryRow({
    id: "pg-1",
    key: "page:test:1",
    content: "first",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
  });
  await insertMemoryRow({
    id: "pg-2",
    key: "page:test:2",
    content: "second",
    createdAt: "2026-04-02T00:00:00.000Z",
    updatedAt: "2026-04-02T00:00:00.000Z",
  });

  const defaultPage = await store.listMemories({ apiKeyId: API_KEY_A, limit: 1 });
  assert.deepEqual(
    defaultPage.data.map((m) => m.id),
    ["pg-2"]
  );
  assert.equal(defaultPage.total, 2);
});

serialTest("getMemoryTokensUsed sums estimated tokens, optionally scoped to an api key", async () => {
  // Token estimate is floor((LENGTH(content) + 3) / 4) per row (SQLite integer math).
  await insertMemoryRow({ id: "tok-1", apiKeyId: API_KEY_A, content: "aaaa" }); // (4+3)/4 = 1
  await insertMemoryRow({ id: "tok-2", apiKeyId: API_KEY_B, content: "aaaaaaaa" }); // (8+3)/4 = 2

  assert.equal(await store.getMemoryTokensUsed(API_KEY_A), 1);
  assert.equal(await store.getMemoryTokensUsed(API_KEY_B), 2);
  assert.equal(await store.getMemoryTokensUsed(`${RUN_PREFIX}-missing-key`), 0);
});

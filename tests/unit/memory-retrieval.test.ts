import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-memory-retrieval-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const pgModule = await import("../../src/lib/db/postgres.ts");
const retrieval = await import("../../src/lib/memory/retrieval.ts");

const RUN_PREFIX = `memory-retrieval-${process.pid}`;
const API_KEY_A = `${RUN_PREFIX}-key-a`;
const API_KEY_B = `${RUN_PREFIX}-key-b`;
const SESSION_A = `${RUN_PREFIX}-session-a`;
const SESSION_B = `${RUN_PREFIX}-session-b`;

function serialTest(name: string, fn: () => Promise<void>) {
  test(name, { concurrency: false }, fn);
}

async function resetStorage() {
  const schema = pgModule.getSchema();
  await pgModule.query(`DELETE FROM ${schema}.memories WHERE api_key_id LIKE $1`, [
    `${RUN_PREFIX}-%`,
  ]);
  core.resetDbInstance();
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
  expiresAt = null as string | null,
}: {
  id: string;
  apiKeyId?: string;
  sessionId?: string;
  type?: string;
  key?: string;
  content?: string;
  metadata?: string;
  createdAt?: string;
  updatedAt?: string;
  expiresAt?: string | null;
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
  await resetStorage();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("estimateTokens roughly divides length by 4 and handles falsy input", () => {
  assert.equal(retrieval.estimateTokens("abcd"), 1);
  assert.equal(retrieval.estimateTokens("abcdefgh"), 2);
  assert.equal(retrieval.estimateTokens(""), 0);
  assert.equal(retrieval.estimateTokens(undefined as unknown as string), 0);
  assert.equal(retrieval.estimateTokens(null as unknown as string), 0);
});

serialTest("retrieveMemories returns [] when disabled or maxTokens <= 0", async () => {
  await insertMemoryRow({ id: `${RUN_PREFIX}-disabled-1` });

  const disabled = await retrieval.retrieveMemories(API_KEY_A, { enabled: false });
  assert.deepEqual(disabled, []);

  const zeroBudget = await retrieval.retrieveMemories(API_KEY_A, { maxTokens: 0 });
  assert.deepEqual(zeroBudget, []);
});

serialTest("retrieveMemories returns only memories for the requested apiKeyId", async () => {
  await insertMemoryRow({ id: `${RUN_PREFIX}-a1`, apiKeyId: API_KEY_A, content: "memory for key a" });
  await insertMemoryRow({ id: `${RUN_PREFIX}-b1`, apiKeyId: API_KEY_B, content: "memory for key b" });

  const results = await retrieval.retrieveMemories(API_KEY_A, {});
  assert.equal(results.length, 1);
  assert.equal(results[0].content, "memory for key a");
});

serialTest("retrieveMemories excludes expired memories", async () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  const future = new Date(Date.now() + 60_000).toISOString();
  await insertMemoryRow({
    id: `${RUN_PREFIX}-expired`,
    content: "expired memory",
    expiresAt: past,
  });
  await insertMemoryRow({
    id: `${RUN_PREFIX}-active`,
    content: "active memory",
    expiresAt: future,
  });

  const results = await retrieval.retrieveMemories(API_KEY_A, {});
  const contents = results.map((m) => m.content);
  assert.ok(contents.includes("active memory"));
  assert.ok(!contents.includes("expired memory"));
});

serialTest("retrieveMemories filters by sessionId when scope is 'session'", async () => {
  await insertMemoryRow({
    id: `${RUN_PREFIX}-sess-a`,
    sessionId: SESSION_A,
    content: "session a memory",
  });
  await insertMemoryRow({
    id: `${RUN_PREFIX}-sess-b`,
    sessionId: SESSION_B,
    content: "session b memory",
  });

  const results = await retrieval.retrieveMemories(API_KEY_A, {
    scope: "session",
    sessionId: SESSION_A,
  });
  const contents = results.map((m) => m.content);
  assert.ok(contents.includes("session a memory"));
  assert.ok(!contents.includes("session b memory"));
});

serialTest("retrieveMemories excludes memories older than retentionDays", async () => {
  const veryOld = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const recent = new Date().toISOString();
  await insertMemoryRow({
    id: `${RUN_PREFIX}-old`,
    content: "very old memory",
    createdAt: veryOld,
  });
  await insertMemoryRow({
    id: `${RUN_PREFIX}-recent`,
    content: "recent memory",
    createdAt: recent,
  });

  const results = await retrieval.retrieveMemories(API_KEY_A, { retentionDays: 30 });
  const contents = results.map((m) => m.content);
  assert.ok(contents.includes("recent memory"));
  assert.ok(!contents.includes("very old memory"));
});

serialTest("retrieveMemories with a query ranks by keyword relevance and drops zero-score entries", async () => {
  await insertMemoryRow({
    id: `${RUN_PREFIX}-relevant`,
    content: "the user prefers dark mode dark mode dark mode",
    key: "preference:theme",
  });
  await insertMemoryRow({
    id: `${RUN_PREFIX}-irrelevant`,
    content: "unrelated content about cooking recipes",
    key: "hobby:cooking",
  });

  const results = await retrieval.retrieveMemories(API_KEY_A, {
    query: "dark mode",
    retrievalStrategy: "exact",
  });

  const contents = results.map((m) => m.content);
  assert.ok(contents.some((c) => c.includes("dark mode")));
  assert.ok(!contents.some((c) => c.includes("cooking")));
});

serialTest("retrieveMemories enforces the token budget and always includes at least one memory", async () => {
  // A single memory whose content alone exceeds a tiny maxTokens budget must
  // still be returned (first-memory-always-included escape hatch).
  const longContent = "word ".repeat(50);
  await insertMemoryRow({ id: `${RUN_PREFIX}-big`, content: longContent });

  const results = await retrieval.retrieveMemories(API_KEY_A, { maxTokens: 1 });
  assert.equal(results.length, 1);
  assert.equal(results[0].content, longContent);
});

serialTest("retrieveMemories stops adding memories once the token budget is exhausted", async () => {
  const chunk = "x".repeat(400); // ~100 tokens each
  await insertMemoryRow({
    id: `${RUN_PREFIX}-budget-1`,
    content: chunk,
    createdAt: new Date(Date.now() - 3000).toISOString(),
  });
  await insertMemoryRow({
    id: `${RUN_PREFIX}-budget-2`,
    content: chunk,
    createdAt: new Date(Date.now() - 2000).toISOString(),
  });
  await insertMemoryRow({
    id: `${RUN_PREFIX}-budget-3`,
    content: chunk,
    createdAt: new Date(Date.now() - 1000).toISOString(),
  });

  const results = await retrieval.retrieveMemories(API_KEY_A, { maxTokens: 150 });
  // Only the most-recent memory (highest createdAt, no query so no scoring)
  // fits within a 150-token budget when each memory costs ~100 tokens.
  assert.equal(results.length, 1);
});

serialTest("retrieveMemories returns memories newest-first when there is no query", async () => {
  await insertMemoryRow({
    id: `${RUN_PREFIX}-older`,
    content: "older",
    createdAt: new Date(Date.now() - 5000).toISOString(),
  });
  await insertMemoryRow({
    id: `${RUN_PREFIX}-newer`,
    content: "newer",
    createdAt: new Date(Date.now() - 1000).toISOString(),
  });

  const results = await retrieval.retrieveMemories(API_KEY_A, {});
  assert.equal(results[0].content, "newer");
  assert.equal(results[1].content, "older");
});

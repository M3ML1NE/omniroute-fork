import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-db-files-"));
process.env.DATA_DIR = TEST_DATA_DIR;
delete process.env.OMNIROUTE_MINIMAL_DB;

const core = await import("../../src/lib/db/core.ts");
const pgModule = await import("../../src/lib/db/postgres.ts");
const filesDb = await import("../../src/lib/db/files.ts");

const RUN_PREFIX = `db-files-${process.pid}`;

function serialTest(name: string, fn: () => Promise<void>) {
  test(name, { concurrency: false }, fn);
}

async function resetStorage() {
  const schema = pgModule.getSchema();
  await pgModule.query(`DELETE FROM ${schema}.files WHERE filename LIKE $1`, [`${RUN_PREFIX}-%`]);
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

function uniqueFilename(suffix: string): string {
  return `${RUN_PREFIX}-${suffix}-${Math.random().toString(16).slice(2, 8)}.txt`;
}

serialTest("createFile persists a file with content and returns the stored record", async () => {
  const content = Buffer.from("hello world");
  const record = await filesDb.createFile({
    bytes: content.length,
    filename: uniqueFilename("basic"),
    purpose: "assistants",
    content,
    mimeType: "text/plain",
    apiKeyId: "key-1",
  });

  assert.ok(record.id.startsWith("file-"));
  assert.equal(record.bytes, content.length);
  assert.equal(record.purpose, "assistants");
  assert.equal(record.deletedAt, null);
  assert.ok(typeof record.createdAt === "number" && record.createdAt > 0);
});

serialTest("createFile defaults expiresAt to +30 days for purpose='batch' when not explicitly set", async () => {
  const before = Math.floor(Date.now() / 1000);
  const record = await filesDb.createFile({
    bytes: 10,
    filename: uniqueFilename("batch"),
    purpose: "batch",
    content: Buffer.from("x"),
  });

  assert.ok(record.expiresAt);
  const expectedMin = before + 2592000 - 5;
  const expectedMax = before + 2592000 + 5;
  assert.ok((record.expiresAt as number) >= expectedMin && (record.expiresAt as number) <= expectedMax);
});

serialTest("createFile does not apply the batch expiry default for other purposes", async () => {
  const record = await filesDb.createFile({
    bytes: 10,
    filename: uniqueFilename("non-batch"),
    purpose: "assistants",
    content: Buffer.from("x"),
  });
  assert.equal(record.expiresAt, null);
});

serialTest("createFile respects an explicit expiresAt override even for purpose='batch'", async () => {
  const explicitExpiresAt = Math.floor(Date.now() / 1000) + 60;
  const record = await filesDb.createFile({
    bytes: 10,
    filename: uniqueFilename("explicit-expiry"),
    purpose: "batch",
    content: Buffer.from("x"),
    expiresAt: explicitExpiresAt,
  });
  assert.equal(record.expiresAt, explicitExpiresAt);
});

serialTest("getFile returns the metadata for an existing file and null for a missing id", async () => {
  const created = await filesDb.createFile({
    bytes: 5,
    filename: uniqueFilename("get"),
    purpose: "assistants",
    content: Buffer.from("hello"),
  });

  const fetched = await filesDb.getFile(created.id);
  assert.ok(fetched);
  assert.equal(fetched.id, created.id);
  assert.equal(fetched.filename, created.filename);

  const missing = await filesDb.getFile("file-does-not-exist");
  assert.equal(missing, null);
});

serialTest("getFileContent returns the exact stored buffer and null when there's no content", async () => {
  const content = Buffer.from("binary content here");
  const created = await filesDb.createFile({
    bytes: content.length,
    filename: uniqueFilename("content"),
    purpose: "assistants",
    content,
  });

  const fetched = await filesDb.getFileContent(created.id);
  assert.ok(fetched);
  assert.equal(fetched.toString(), content.toString());

  const missing = await filesDb.getFileContent("file-does-not-exist");
  assert.equal(missing, null);
});

serialTest("getFile/getFileContent return null for a soft-deleted file", async () => {
  const created = await filesDb.createFile({
    bytes: 5,
    filename: uniqueFilename("deleted"),
    purpose: "assistants",
    content: Buffer.from("hello"),
  });

  await filesDb.deleteFile(created.id);

  assert.equal(await filesDb.getFile(created.id), null);
  assert.equal(await filesDb.getFileContent(created.id), null);
});

serialTest("deleteFile returns true for an existing file and false for a missing id", async () => {
  const created = await filesDb.createFile({
    bytes: 5,
    filename: uniqueFilename("delete-true"),
    purpose: "assistants",
    content: Buffer.from("x"),
  });

  assert.equal(await filesDb.deleteFile(created.id), true);
  assert.equal(await filesDb.deleteFile("file-does-not-exist"), false);
});

serialTest("listFiles filters by apiKeyId and purpose", async () => {
  const apiKeyId = `${RUN_PREFIX}-key-a`;
  await filesDb.createFile({
    bytes: 1,
    filename: uniqueFilename("list-a"),
    purpose: "assistants",
    content: Buffer.from("a"),
    apiKeyId,
  });
  await filesDb.createFile({
    bytes: 1,
    filename: uniqueFilename("list-b"),
    purpose: "batch",
    content: Buffer.from("b"),
    apiKeyId,
  });
  await filesDb.createFile({
    bytes: 1,
    filename: uniqueFilename("list-c"),
    purpose: "assistants",
    content: Buffer.from("c"),
    apiKeyId: `${RUN_PREFIX}-key-b`,
  });

  const forKeyA = await filesDb.listFiles({ apiKeyId });
  assert.equal(forKeyA.length, 2);

  const forKeyAAssistants = await filesDb.listFiles({ apiKeyId, purpose: "assistants" });
  assert.equal(forKeyAAssistants.length, 1);
  assert.equal(forKeyAAssistants[0].purpose, "assistants");
});

serialTest("listFiles orders results descending by default and ascending when requested", async () => {
  const apiKeyId = `${RUN_PREFIX}-key-order`;
  const first = await filesDb.createFile({
    bytes: 1,
    filename: uniqueFilename("order-1"),
    purpose: "assistants",
    content: Buffer.from("1"),
    apiKeyId,
  });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const second = await filesDb.createFile({
    bytes: 1,
    filename: uniqueFilename("order-2"),
    purpose: "assistants",
    content: Buffer.from("2"),
    apiKeyId,
  });

  const desc = await filesDb.listFiles({ apiKeyId, order: "desc" });
  assert.equal(desc[0].id, second.id);

  const asc = await filesDb.listFiles({ apiKeyId, order: "asc" });
  assert.equal(asc[0].id, first.id);
});

serialTest("listFiles paginates using the 'after' cursor", async () => {
  const apiKeyId = `${RUN_PREFIX}-key-page`;
  const first = await filesDb.createFile({
    bytes: 1,
    filename: uniqueFilename("page-1"),
    purpose: "assistants",
    content: Buffer.from("1"),
    apiKeyId,
  });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const second = await filesDb.createFile({
    bytes: 1,
    filename: uniqueFilename("page-2"),
    purpose: "assistants",
    content: Buffer.from("2"),
    apiKeyId,
  });

  const page = await filesDb.listFiles({ apiKeyId, order: "desc", after: second.id });
  assert.equal(page.length, 1);
  assert.equal(page[0].id, first.id);
});

serialTest("countFiles counts only non-deleted files matching the filters", async () => {
  const apiKeyId = `${RUN_PREFIX}-key-count`;
  const created = await filesDb.createFile({
    bytes: 1,
    filename: uniqueFilename("count-1"),
    purpose: "assistants",
    content: Buffer.from("1"),
    apiKeyId,
  });
  await filesDb.createFile({
    bytes: 1,
    filename: uniqueFilename("count-2"),
    purpose: "assistants",
    content: Buffer.from("2"),
    apiKeyId,
  });

  assert.equal(await filesDb.countFiles({ apiKeyId }), 2);

  await filesDb.deleteFile(created.id);
  assert.equal(await filesDb.countFiles({ apiKeyId }), 1);
});

serialTest("countFiles returns 0 for a filter combination that matches nothing", async () => {
  assert.equal(
    await filesDb.countFiles({ apiKeyId: `${RUN_PREFIX}-nonexistent-key` }),
    0
  );
});

serialTest("formatFileResponse produces the OpenAI-shaped file object", async () => {
  const created = await filesDb.createFile({
    bytes: 42,
    filename: uniqueFilename("format"),
    purpose: "assistants",
    content: Buffer.from("x"),
  });

  const formatted = filesDb.formatFileResponse(created);
  assert.equal(formatted.object, "file");
  assert.equal(formatted.id, created.id);
  assert.equal(formatted.bytes, 42);
  assert.equal(formatted.purpose, "assistants");
  assert.equal(formatted.expires_at, null);
});

serialTest("formatFileResponse defaults an invalid createdAt to 0 rather than NaN", async () => {
  const formatted = filesDb.formatFileResponse({
    id: "file-x",
    bytes: 1,
    createdAt: NaN,
    filename: "x.txt",
    purpose: "assistants",
  });
  assert.equal(formatted.created_at, 0);
});

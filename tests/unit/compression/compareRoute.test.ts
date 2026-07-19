// Ported from upstream OmniRoute (tag v3.8.48) for the GigaChat fork.
// Adapted to the fork's management-auth model: the compare route is guarded by
// requireManagementAuth, so authenticated calls use makeManagementSessionRequest.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { makeManagementSessionRequest } from "../../helpers/managementSession.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-compression-compare-"));
const originalDataDir = process.env.DATA_DIR;
const originalJwtSecret = process.env.JWT_SECRET;

process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../../src/lib/db/core.ts");
const settingsDb = await import("../../../src/lib/db/settings.ts");
const route = await import("../../../src/app/api/compression/compare/route.ts");

async function resetAuthRequiredStorage(): Promise<void> {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  await settingsDb.updateSettings({
    requireLogin: true,
    setupComplete: true,
    password: "test-password-hash",
  });
}

test.beforeEach(async () => {
  process.env.DATA_DIR = TEST_DATA_DIR;
  await resetAuthRequiredStorage();
});

test.after(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalJwtSecret;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("compression compare requires management auth", async () => {
  const res = await route.POST(
    new Request("http://localhost/api/compression/compare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    })
  );
  assert.equal(res.status, 401);
});

test("ranks a high-savings engine above a no-op for repetitive tool output", async () => {
  const text = [
    "$ npm install",
    "npm warn deprecated glob@7.2.3: no longer supported",
    "npm warn deprecated glob@7.2.3: no longer supported",
    "npm warn deprecated glob@7.2.3: no longer supported",
    "added 1234 packages",
  ].join("\n");
  const req = await makeManagementSessionRequest("http://localhost/api/compression/compare", {
    method: "POST",
    body: { messages: [{ role: "user", content: text }], engineIds: ["rtk", "lite"] },
  });
  const res = await route.POST(req);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    rows: Array<{ engine: string; meanSavingsPercent: number; meanRetention: number }>;
  };
  assert.ok(Array.isArray(body.rows) && body.rows.length === 2);
  assert.equal(body.rows[0].engine, "rtk");
  assert.ok(body.rows[0].meanSavingsPercent >= body.rows[1].meanSavingsPercent);
  assert.ok(typeof body.rows[0].meanRetention === "number");
});

test("400 on empty messages", async () => {
  const req = await makeManagementSessionRequest("http://localhost/api/compression/compare", {
    method: "POST",
    body: { messages: [] },
  });
  const res = await route.POST(req);
  assert.equal(res.status, 400);
});

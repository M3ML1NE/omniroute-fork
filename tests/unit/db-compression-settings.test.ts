import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-compression-settings-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const pgModule = await import("../../src/lib/db/postgres.ts");
const compressionDb = await import("../../src/lib/db/compression.ts");

function serialTest(name: string, fn: () => Promise<void>) {
  test(name, { concurrency: false }, fn);
}

async function resetStorage() {
  const schema = pgModule.getSchema();
  await pgModule.query(`DELETE FROM ${schema}.key_value WHERE namespace = 'compression'`);
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

// ── updateCompressionSettings ───────────────────────────────────────────────

serialTest("updateCompressionSettings persists a scalar field and returns the merged config", async () => {
  const updated = await compressionDb.updateCompressionSettings({ enabled: true });
  assert.equal(updated.enabled, true);

  const reFetched = await compressionDb.getCompressionSettings();
  assert.equal(reFetched.enabled, true);
});

serialTest("updateCompressionSettings persists defaultMode only when it's a recognized mode", async () => {
  const updated = await compressionDb.updateCompressionSettings({ defaultMode: "aggressive" as any });
  assert.equal(updated.defaultMode, "aggressive");
});

serialTest("updateCompressionSettings clamps autoTriggerTokens to a non-negative integer", async () => {
  const updated = await compressionDb.updateCompressionSettings({ autoTriggerTokens: -5.7 as any });
  assert.equal(updated.autoTriggerTokens, 0);
});

serialTest("updateCompressionSettings clamps cacheMinutes to at least 1", async () => {
  const updated = await compressionDb.updateCompressionSettings({ cacheMinutes: 0 as any });
  assert.equal(updated.cacheMinutes, 1);
});

serialTest("updateCompressionSettings persists comboOverrides, filtering out invalid mode values", async () => {
  const updated = await compressionDb.updateCompressionSettings({
    comboOverrides: { "combo-1": "aggressive", "combo-2": "not-a-real-mode" } as any,
  });
  assert.deepEqual(updated.comboOverrides, { "combo-1": "aggressive" });
});

serialTest("updateCompressionSettings trims compressionComboId and stores null for a blank value", async () => {
  const withValue = await compressionDb.updateCompressionSettings({
    compressionComboId: "  combo-abc  ",
  });
  assert.equal(withValue.compressionComboId, "combo-abc");

  const blanked = await compressionDb.updateCompressionSettings({ compressionComboId: "   " });
  assert.equal(blanked.compressionComboId, null);
});

serialTest("updateCompressionSettings ignores undefined fields (does not overwrite persisted values)", async () => {
  await compressionDb.updateCompressionSettings({ enabled: true });
  const updated = await compressionDb.updateCompressionSettings({ enabled: undefined, cacheMinutes: 10 });
  assert.equal(updated.enabled, true);
  assert.equal(updated.cacheMinutes, 10);
});

serialTest("updateCompressionSettings invalidates the TTL cache so the next read reflects the write", async () => {
  const first = await compressionDb.getCompressionSettings();
  assert.equal(first.enabled, false);

  await compressionDb.updateCompressionSettings({ enabled: true });

  const second = await compressionDb.getCompressionSettings();
  assert.equal(second.enabled, true);
});

// ── getCompressionSettings edge-case normalization ──────────────────────────

serialTest("getCompressionSettings ignores an unparseable autoTriggerTokens value and falls back to 0", async () => {
  await compressionDb.updateCompressionSettings({ autoTriggerTokens: NaN as any });
  const config = await compressionDb.getCompressionSettings();
  assert.equal(config.autoTriggerTokens, 0);
});

serialTest("getCompressionSettings treats preserveSystemPrompt !== false as true (default-on semantics)", async () => {
  const config = await compressionDb.getCompressionSettings();
  assert.equal(config.preserveSystemPrompt, true);
});

// ── Default config getters (pure) ───────────────────────────────────────────

test("getDefaultAggressiveConfig returns a fresh object each call (not a shared mutable reference)", () => {
  const a = compressionDb.getDefaultAggressiveConfig();
  const b = compressionDb.getDefaultAggressiveConfig();
  assert.deepEqual(a, b);
  assert.notEqual(a, b);
  assert.notEqual(a.thresholds, b.thresholds);
});

test("getDefaultUltraConfig returns a fresh object each call", () => {
  const a = compressionDb.getDefaultUltraConfig();
  const b = compressionDb.getDefaultUltraConfig();
  assert.deepEqual(a, b);
  assert.notEqual(a, b);
});

test("getDefaultRtkConfig returns a fresh object each call", () => {
  const a = compressionDb.getDefaultRtkConfig();
  const b = compressionDb.getDefaultRtkConfig();
  assert.deepEqual(a, b);
  assert.notEqual(a, b);
});

// ── MCP accessibility config ─────────────────────────────────────────────────

serialTest("getMcpAccessibilityConfig returns documented defaults when unset", async () => {
  const config = await compressionDb.getMcpAccessibilityConfig();
  assert.equal(config.enabled, true);
  assert.equal(typeof config.maxTextChars, "number");
  assert.ok(config.maxTextChars > 0);
});

serialTest("setMcpAccessibilityConfig persists a partial override merged over defaults", async () => {
  await compressionDb.setMcpAccessibilityConfig({ enabled: false, maxTextChars: 5000 });

  const config = await compressionDb.getMcpAccessibilityConfig();
  assert.equal(config.enabled, false);
  assert.equal(config.maxTextChars, 5000);
});

serialTest("setMcpAccessibilityConfig clamps non-positive maxTextChars back to the default", async () => {
  await compressionDb.setMcpAccessibilityConfig({ maxTextChars: -10 });

  const config = await compressionDb.getMcpAccessibilityConfig();
  assert.notEqual(config.maxTextChars, -10);
  assert.ok(config.maxTextChars > 0);
});

serialTest("setMcpAccessibilityConfig floors a fractional collapseKeepHead value", async () => {
  await compressionDb.setMcpAccessibilityConfig({ collapseKeepHead: 3.9 });

  const config = await compressionDb.getMcpAccessibilityConfig();
  assert.equal(config.collapseKeepHead, 3);
});

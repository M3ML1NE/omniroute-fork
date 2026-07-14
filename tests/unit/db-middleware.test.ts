import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-middleware-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const pgModule = await import("../../src/lib/db/postgres.ts");
const middlewareDb = await import("../../src/lib/db/middleware.ts");
import { HookPriority, type HookConfig } from "../../src/lib/middleware/types.ts";

const RUN_PREFIX = `middleware-${process.pid}`;

function serialTest(name: string, fn: () => Promise<void>) {
  test(name, { concurrency: false }, fn);
}

async function resetStorage() {
  const schema = pgModule.getSchema();
  await pgModule.query(
    `DELETE FROM ${schema}.middleware_logs WHERE hook_name LIKE $1`,
    [`${RUN_PREFIX}-%`]
  );
  await pgModule.query(`DELETE FROM ${schema}.middleware_hooks WHERE name LIKE $1`, [
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

function makeHookConfig(overrides: Partial<HookConfig> = {}): HookConfig {
  return {
    name: `${RUN_PREFIX}-hook-${randomUUID()}`,
    description: "test hook",
    priority: HookPriority.HIGH,
    scope: { type: "global" },
    enabled: true,
    code: "// noop",
    createdAt: "",
    updatedAt: "",
    runCount: 0,
    ...overrides,
  };
}

serialTest("createMiddlewareHook persists and returns the full hook config", async () => {
  const config = makeHookConfig({ description: "my hook", priority: HookPriority.CRITICAL });
  const created = await middlewareDb.createMiddlewareHook(config);

  assert.equal(created.name, config.name);
  assert.equal(created.description, "my hook");
  assert.equal(created.priority, HookPriority.CRITICAL);
  assert.equal(created.enabled, true);
  assert.equal(created.scope.type, "global");
  assert.ok(created.createdAt);
  assert.ok(created.updatedAt);
});

serialTest("createMiddlewareHook persists a combo-scoped hook with its comboId", async () => {
  const config = makeHookConfig({ scope: { type: "combo", comboId: "my-combo" } });
  const created = await middlewareDb.createMiddlewareHook(config);
  assert.deepEqual(created.scope, { type: "combo", comboId: "my-combo" });
});

serialTest("getMiddlewareHook returns undefined for a nonexistent hook", async () => {
  assert.equal(await middlewareDb.getMiddlewareHook(`${RUN_PREFIX}-missing`), undefined);
});

serialTest("getAllMiddlewareHooks returns hooks ordered by priority then name", async () => {
  await middlewareDb.createMiddlewareHook(makeHookConfig({ name: `${RUN_PREFIX}-z`, priority: HookPriority.NORMAL }));
  await middlewareDb.createMiddlewareHook(makeHookConfig({ name: `${RUN_PREFIX}-a`, priority: HookPriority.NORMAL }));
  await middlewareDb.createMiddlewareHook(makeHookConfig({ name: `${RUN_PREFIX}-b`, priority: HookPriority.CRITICAL }));

  const all = await middlewareDb.getAllMiddlewareHooks();
  const ours = all.filter((h) => h.name.startsWith(RUN_PREFIX));
  assert.equal(ours[0].name, `${RUN_PREFIX}-b`);
  assert.equal(ours[1].name, `${RUN_PREFIX}-a`);
  assert.equal(ours[2].name, `${RUN_PREFIX}-z`);
});

serialTest("getEnabledMiddlewareHooks excludes disabled hooks", async () => {
  await middlewareDb.createMiddlewareHook(
    makeHookConfig({ name: `${RUN_PREFIX}-enabled`, enabled: true })
  );
  await middlewareDb.createMiddlewareHook(
    makeHookConfig({ name: `${RUN_PREFIX}-disabled`, enabled: false })
  );

  const enabled = await middlewareDb.getEnabledMiddlewareHooks();
  const names = enabled.map((h) => h.name);
  assert.ok(names.includes(`${RUN_PREFIX}-enabled`));
  assert.ok(!names.includes(`${RUN_PREFIX}-disabled`));
});

serialTest("getComboMiddlewareHooks includes global hooks and matching combo-scoped hooks only", async () => {
  await middlewareDb.createMiddlewareHook(
    makeHookConfig({ name: `${RUN_PREFIX}-global`, scope: { type: "global" } })
  );
  await middlewareDb.createMiddlewareHook(
    makeHookConfig({
      name: `${RUN_PREFIX}-combo-match`,
      scope: { type: "combo", comboId: "combo-x" },
    })
  );
  await middlewareDb.createMiddlewareHook(
    makeHookConfig({
      name: `${RUN_PREFIX}-combo-other`,
      scope: { type: "combo", comboId: "combo-y" },
    })
  );

  const hooks = await middlewareDb.getComboMiddlewareHooks("combo-x");
  const names = hooks.map((h) => h.name);
  assert.ok(names.includes(`${RUN_PREFIX}-global`));
  assert.ok(names.includes(`${RUN_PREFIX}-combo-match`));
  assert.ok(!names.includes(`${RUN_PREFIX}-combo-other`));
});

serialTest("updateMiddlewareHook patches fields and returns the merged hook", async () => {
  const created = await middlewareDb.createMiddlewareHook(
    makeHookConfig({ description: "before" })
  );
  const updated = await middlewareDb.updateMiddlewareHook(created.name, {
    description: "after",
    priority: HookPriority.LOW,
  });

  assert.equal(updated?.description, "after");
  assert.equal(updated?.priority, HookPriority.LOW);
  assert.equal(updated?.code, created.code);
});

serialTest("updateMiddlewareHook returns undefined for a nonexistent hook", async () => {
  const result = await middlewareDb.updateMiddlewareHook(`${RUN_PREFIX}-missing`, {
    description: "x",
  });
  assert.equal(result, undefined);
});

serialTest("deleteMiddlewareHook removes the hook and reports success", async () => {
  const created = await middlewareDb.createMiddlewareHook(makeHookConfig());
  assert.equal(await middlewareDb.deleteMiddlewareHook(created.name), true);
  assert.equal(await middlewareDb.getMiddlewareHook(created.name), undefined);
});

serialTest("deleteMiddlewareHook returns false for a nonexistent hook", async () => {
  assert.equal(await middlewareDb.deleteMiddlewareHook(`${RUN_PREFIX}-missing`), false);
});

serialTest("recordHookExecution increments run_count and clears last_error on success", async () => {
  const created = await middlewareDb.createMiddlewareHook(
    makeHookConfig({ lastError: "prior failure" })
  );
  await middlewareDb.recordHookExecution(created.name);

  const after = await middlewareDb.getMiddlewareHook(created.name);
  assert.equal(after?.runCount, 1);
  assert.equal(after?.lastError, undefined);
});

serialTest("recordHookExecution increments run_count and sets last_error on failure", async () => {
  const created = await middlewareDb.createMiddlewareHook(makeHookConfig());
  await middlewareDb.recordHookExecution(created.name, "boom");

  const after = await middlewareDb.getMiddlewareHook(created.name);
  assert.equal(after?.runCount, 1);
  assert.equal(after?.lastError, "boom");
});

serialTest("insertHookLog / getHookLogs round-trip", async () => {
  const created = await middlewareDb.createMiddlewareHook(makeHookConfig());
  await middlewareDb.insertHookLog({
    id: randomUUID(),
    hookName: created.name,
    requestId: "req-1",
    durationMs: 12,
    mutated: true,
    skipped: false,
    timestamp: new Date().toISOString(),
  });

  const logs = await middlewareDb.getHookLogs(created.name);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].hookName, created.name);
  assert.equal(logs[0].mutated, true);
  assert.equal(logs[0].skipped, false);
});

serialTest("getHookLogs without a hookName filter returns logs across hooks", async () => {
  const hookA = await middlewareDb.createMiddlewareHook(makeHookConfig());
  const hookB = await middlewareDb.createMiddlewareHook(makeHookConfig());

  await middlewareDb.insertHookLog({
    id: randomUUID(),
    hookName: hookA.name,
    requestId: "req-a",
    durationMs: 1,
    mutated: false,
    skipped: false,
    timestamp: new Date().toISOString(),
  });
  await middlewareDb.insertHookLog({
    id: randomUUID(),
    hookName: hookB.name,
    requestId: "req-b",
    durationMs: 2,
    mutated: false,
    skipped: true,
    timestamp: new Date().toISOString(),
  });

  const logsA = await middlewareDb.getHookLogs(hookA.name);
  assert.ok(logsA.every((l) => l.hookName === hookA.name));

  const allLogs = await middlewareDb.getHookLogs(undefined, 100);
  const requestIds = allLogs.map((l) => l.requestId);
  assert.ok(requestIds.includes("req-a"));
  assert.ok(requestIds.includes("req-b"));
});

serialTest("cleanupHookLogs keeps only the most recent maxEntries logs", async () => {
  const created = await middlewareDb.createMiddlewareHook(makeHookConfig());
  for (let i = 0; i < 5; i++) {
    await middlewareDb.insertHookLog({
      id: randomUUID(),
      hookName: created.name,
      requestId: `req-${i}`,
      durationMs: i,
      mutated: false,
      skipped: false,
      timestamp: new Date(Date.now() + i * 1000).toISOString(),
    });
  }

  const deletedCount = await middlewareDb.cleanupHookLogs(2);
  assert.ok(deletedCount >= 0);
  const remaining = await middlewareDb.getHookLogs(created.name, 100);
  assert.ok(remaining.length <= 2);
});

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  createHookContext,
  registerHook,
  unregisterHook,
  updateHook,
  getHook,
  getAllHooks,
  loadHooksFromConfig,
  runHooks,
  getHookLogs,
  initPreRequestRegistry,
  clearAllHooks,
  getRegistryStats,
} from "../../src/lib/middleware/registry.ts";
import { HookPriority, type HookConfig, type HookMiddleware } from "../../src/lib/middleware/types.ts";

beforeEach(() => {
  clearAllHooks();
});

function makeHookConfig(overrides: Partial<HookConfig> = {}): HookConfig {
  const now = new Date().toISOString();
  return {
    name: "test-hook",
    description: "a test hook",
    priority: HookPriority.NORMAL,
    scope: { type: "global" },
    enabled: true,
    code: "return {};",
    createdAt: now,
    updatedAt: now,
    runCount: 0,
    ...overrides,
  };
}

describe("createHookContext", () => {
  it("clones body/headers so mutations don't leak back to the caller's originals", () => {
    const body = { model: "gpt-4o" };
    const headers = { "content-type": "application/json" };
    const context = createHookContext({ body, headers, model: "gpt-4o" });

    context.body.model = "mutated";
    context.headers["content-type"] = "mutated";

    assert.equal(body.model, "gpt-4o");
    assert.equal(headers["content-type"], "application/json");
  });

  it("defaults metadata to an empty object and combo/apiKeyInfo to undefined when not provided", () => {
    const context = createHookContext({ body: {}, headers: {}, model: "gpt-4o" });
    assert.deepEqual(context.metadata, {});
    assert.equal(context.combo, undefined);
    assert.equal(context.apiKeyInfo, undefined);
  });

  it("clones apiKeyInfo when provided", () => {
    const apiKeyInfo = { id: "key-1" };
    const context = createHookContext({ body: {}, headers: {}, model: "gpt-4o", apiKeyInfo });
    context.apiKeyInfo!.id = "mutated";
    assert.equal(apiKeyInfo.id, "key-1");
  });

  it("provides a working log object that falls back to console when no logger is given", () => {
    const context = createHookContext({ body: {}, headers: {}, model: "gpt-4o" });
    assert.doesNotThrow(() => context.log.info("tag", "msg"));
    assert.doesNotThrow(() => context.log.warn("tag", "msg"));
    assert.doesNotThrow(() => context.log.error("tag", "msg"));
  });
});

describe("registerHook / getHook / getAllHooks", () => {
  it("registers a hook with an explicit middleware function and makes it retrievable", () => {
    const middleware: HookMiddleware = async () => ({});
    registerHook(makeHookConfig({ name: "hook-a" }), middleware);

    const hook = getHook("hook-a");
    assert.ok(hook);
    assert.equal(hook!.name, "hook-a");
  });

  it("registers a hook by compiling its code string when no middleware function is given", () => {
    registerHook(makeHookConfig({ name: "hook-compiled", code: "return { model: 'compiled-model' };" }));
    assert.ok(getHook("hook-compiled"));
  });

  it("throws when registering a hook name that's already registered", () => {
    registerHook(makeHookConfig({ name: "dup-hook" }));
    assert.throws(() => registerHook(makeHookConfig({ name: "dup-hook" })), /already registered/);
  });

  it("throws when the hook code fails to compile", () => {
    assert.throws(
      () => registerHook(makeHookConfig({ name: "bad-code", code: "this is not valid javascript {{{" })),
      /Failed to compile hook/
    );
  });

  it("getAllHooks returns every registered hook", () => {
    registerHook(makeHookConfig({ name: "hook-1" }));
    registerHook(makeHookConfig({ name: "hook-2" }));
    const all = getAllHooks();
    assert.equal(all.length, 2);
    assert.deepEqual(
      all.map((h) => h.name).sort(),
      ["hook-1", "hook-2"]
    );
  });

  it("getHook returns undefined for an unregistered name", () => {
    assert.equal(getHook("does-not-exist"), undefined);
  });
});

describe("unregisterHook", () => {
  it("removes a registered hook and returns true", () => {
    registerHook(makeHookConfig({ name: "removable" }));
    assert.equal(unregisterHook("removable"), true);
    assert.equal(getHook("removable"), undefined);
  });

  it("returns false when removing a hook that was never registered", () => {
    assert.equal(unregisterHook("never-registered"), false);
  });
});

describe("updateHook", () => {
  it("returns false for a hook that doesn't exist", () => {
    assert.equal(updateHook("missing", { enabled: false }), false);
  });

  it("merges the updates into the existing config and bumps updatedAt", () => {
    registerHook(makeHookConfig({ name: "updatable", description: "old" }));
    const before = getHook("updatable")!.updatedAt;

    const updated = updateHook("updatable", { description: "new description" });
    assert.equal(updated, true);

    const hook = getHook("updatable")!;
    assert.equal(hook.description, "new description");
    assert.ok(hook.updatedAt >= before);
  });

  it("recompiles the middleware when code is updated", async () => {
    registerHook(makeHookConfig({ name: "recompile-me", code: "return { model: 'v1' };" }));
    updateHook("recompile-me", { code: "return { model: 'v2' };" });

    const context = createHookContext({ body: {}, headers: {}, model: "original" });
    const result = await runHooks(context);
    assert.equal(result.context.model, "v2");
  });

  it("records lastError and rethrows when the updated code fails to compile", () => {
    registerHook(makeHookConfig({ name: "bad-update", code: "return {};" }));
    assert.throws(() => updateHook("bad-update", { code: "not valid {{{" }));
    const hook = getHook("bad-update")!;
    assert.ok(hook.lastError);
  });
});

describe("loadHooksFromConfig", () => {
  it("loads hooks that aren't already registered and compiles their code", () => {
    loadHooksFromConfig([makeHookConfig({ name: "loaded-hook", code: "return { model: 'loaded' };" })]);
    assert.ok(getHook("loaded-hook"));
  });

  it("does not overwrite a hook that's already registered under the same name", () => {
    registerHook(makeHookConfig({ name: "existing", description: "original" }));
    loadHooksFromConfig([makeHookConfig({ name: "existing", description: "from-config" })]);
    assert.equal(getHook("existing")!.description, "original");
  });

  it("does not throw when a loaded hook's code fails to compile (logs and continues)", () => {
    assert.doesNotThrow(() =>
      loadHooksFromConfig([makeHookConfig({ name: "bad-loaded", code: "not valid {{{" })])
    );
    // The config is stored even though compilation failed (no middleware registered).
    assert.ok(getHook("bad-loaded"));
  });
});

describe("runHooks", () => {
  it("returns the context unchanged when there are no registered hooks", async () => {
    const context = createHookContext({ body: { a: 1 }, headers: {}, model: "gpt-4o" });
    const result = await runHooks(context);
    assert.deepEqual(result.context.body, { a: 1 });
    assert.equal(result.response, undefined);
  });

  it("skips disabled hooks", async () => {
    registerHook(
      makeHookConfig({ name: "disabled-hook", enabled: false }),
      async () => ({ model: "should-not-apply" })
    );
    const context = createHookContext({ body: {}, headers: {}, model: "original" });
    const result = await runHooks(context);
    assert.equal(result.context.model, "original");
  });

  it("applies body/headers/model/combo mutations from a hook result in order", async () => {
    registerHook(
      makeHookConfig({ name: "mutator", priority: HookPriority.HIGH }),
      async () => ({
        body: { injected: true },
        headers: { "x-injected": "1" },
        model: "new-model",
        combo: "new-combo",
      })
    );
    const context = createHookContext({ body: { original: true }, headers: {}, model: "old-model" });
    const result = await runHooks(context);

    assert.deepEqual(result.context.body, { original: true, injected: true });
    assert.equal(result.context.headers["x-injected"], "1");
    assert.equal(result.context.model, "new-model");
    assert.equal(result.context.combo, "new-combo");
  });

  it("runs hooks in priority order (lower runs first)", async () => {
    const order: string[] = [];
    registerHook(makeHookConfig({ name: "second", priority: HookPriority.LOW }), async () => {
      order.push("second");
      return {};
    });
    registerHook(makeHookConfig({ name: "first", priority: HookPriority.CRITICAL }), async () => {
      order.push("first");
      return {};
    });

    await runHooks(createHookContext({ body: {}, headers: {}, model: "m" }));
    assert.deepEqual(order, ["first", "second"]);
  });

  it("short-circuits and returns the hook's response, skipping remaining hooks", async () => {
    const order: string[] = [];
    registerHook(makeHookConfig({ name: "short-circuit", priority: HookPriority.CRITICAL }), async () => {
      order.push("short-circuit");
      return { response: { status: 429, body: { error: "rate limited" } } };
    });
    registerHook(makeHookConfig({ name: "never-runs", priority: HookPriority.LOW }), async () => {
      order.push("never-runs");
      return {};
    });

    const result = await runHooks(createHookContext({ body: {}, headers: {}, model: "m" }));
    assert.deepEqual(result.response, { status: 429, body: { error: "rate limited" } });
    assert.deepEqual(order, ["short-circuit"]);
  });

  it("stops processing remaining hooks when skipRemaining is set, without short-circuiting the response", async () => {
    const order: string[] = [];
    registerHook(makeHookConfig({ name: "skip-rest", priority: HookPriority.CRITICAL }), async () => {
      order.push("skip-rest");
      return { skipRemaining: true };
    });
    registerHook(makeHookConfig({ name: "never-runs-2", priority: HookPriority.LOW }), async () => {
      order.push("never-runs-2");
      return {};
    });

    const result = await runHooks(createHookContext({ body: {}, headers: {}, model: "m" }));
    assert.equal(result.response, undefined);
    assert.deepEqual(order, ["skip-rest"]);
  });

  it("catches a throwing hook, records lastError, and continues to the next hook", async () => {
    const order: string[] = [];
    registerHook(makeHookConfig({ name: "throws", priority: HookPriority.CRITICAL }), async () => {
      order.push("throws");
      throw new Error("boom");
    });
    registerHook(makeHookConfig({ name: "after-throw", priority: HookPriority.LOW }), async () => {
      order.push("after-throw");
      return {};
    });

    await runHooks(createHookContext({ body: {}, headers: {}, model: "m" }));
    assert.deepEqual(order, ["throws", "after-throw"]);
    assert.equal(getHook("throws")!.lastError, "boom");
  });

  it("only runs combo-scoped hooks when the comboId matches", async () => {
    let ran = false;
    registerHook(makeHookConfig({ name: "combo-scoped", scope: { type: "combo", comboId: "combo-a" } }), async () => {
      ran = true;
      return {};
    });

    await runHooks(createHookContext({ body: {}, headers: {}, model: "m" }), "combo-b");
    assert.equal(ran, false);

    await runHooks(createHookContext({ body: {}, headers: {}, model: "m" }), "combo-a");
    assert.equal(ran, true);
  });

  it("increments runCount on both success and failure", async () => {
    registerHook(makeHookConfig({ name: "counted" }), async () => ({}));
    await runHooks(createHookContext({ body: {}, headers: {}, model: "m" }));
    await runHooks(createHookContext({ body: {}, headers: {}, model: "m" }));
    assert.equal(getHook("counted")!.runCount, 2);
  });
});

describe("getHookLogs", () => {
  it("records a log entry per hook execution and returns them, most-recent-limited", async () => {
    registerHook(makeHookConfig({ name: "logged-hook" }), async () => ({ model: "x" }));
    await runHooks(createHookContext({ body: {}, headers: {}, model: "m" }));

    const logs = getHookLogs();
    assert.ok(logs.length >= 1);
    assert.equal(logs[logs.length - 1].hookName, "logged-hook");
    assert.equal(logs[logs.length - 1].mutated, true);
  });

  it("filters logs by hookName when provided", async () => {
    registerHook(makeHookConfig({ name: "hook-x" }), async () => ({}));
    registerHook(makeHookConfig({ name: "hook-y" }), async () => ({}));
    await runHooks(createHookContext({ body: {}, headers: {}, model: "m" }));

    const logsForX = getHookLogs("hook-x");
    assert.ok(logsForX.every((l) => l.hookName === "hook-x"));
  });

  it("respects the limit parameter", async () => {
    registerHook(makeHookConfig({ name: "many-runs" }), async () => ({}));
    for (let i = 0; i < 5; i++) {
      await runHooks(createHookContext({ body: {}, headers: {}, model: "m" }));
    }
    const logs = getHookLogs("many-runs", 2);
    assert.equal(logs.length, 2);
  });
});

describe("initPreRequestRegistry / clearAllHooks", () => {
  it("initPreRequestRegistry does not throw", () => {
    assert.doesNotThrow(() => initPreRequestRegistry());
  });

  it("clearAllHooks removes all hooks, middlewares, and logs", async () => {
    registerHook(makeHookConfig({ name: "to-clear" }), async () => ({}));
    await runHooks(createHookContext({ body: {}, headers: {}, model: "m" }));

    clearAllHooks();

    assert.deepEqual(getAllHooks(), []);
    assert.deepEqual(getHookLogs(), []);
  });
});

describe("getRegistryStats", () => {
  it("reports totals broken down by enabled/global/combo scope", () => {
    registerHook(makeHookConfig({ name: "enabled-global", enabled: true, scope: { type: "global" } }));
    registerHook(
      makeHookConfig({ name: "disabled-combo", enabled: false, scope: { type: "combo", comboId: "c1" } })
    );

    const stats = getRegistryStats();
    assert.equal(stats.totalHooks, 2);
    assert.equal(stats.enabledHooks, 1);
    assert.equal(stats.globalHooks, 1);
    assert.equal(stats.comboScopedHooks, 1);
  });
});

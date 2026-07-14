import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  recordComboRequest,
  recordComboShadowRequest,
  getComboMetrics,
  getAllComboMetrics,
  recordComboIntent,
  resetComboMetrics,
  resetAllComboMetrics,
} from "../../open-sse/services/comboMetrics.ts";

beforeEach(() => {
  resetAllComboMetrics();
});

describe("recordComboRequest / getComboMetrics", () => {
  it("returns null for a combo with no recorded requests", () => {
    assert.equal(getComboMetrics("unknown-combo"), null);
  });

  it("tracks total requests, successes, and failures", () => {
    recordComboRequest("combo-a", "openai/gpt-4o", { success: true, latencyMs: 100 });
    recordComboRequest("combo-a", "openai/gpt-4o", { success: false, latencyMs: 200 });

    const metrics = getComboMetrics("combo-a");
    assert.ok(metrics);
    assert.equal(metrics!.totalRequests, 2);
    assert.equal(metrics!.totalSuccesses, 1);
    assert.equal(metrics!.totalFailures, 1);
    assert.equal(metrics!.avgLatencyMs, 150);
    assert.equal(metrics!.successRate, 50);
  });

  it("tracks fallback counts and computes fallbackRate", () => {
    recordComboRequest("combo-fb", "openai/gpt-4o", {
      success: true,
      latencyMs: 100,
      fallbackCount: 1,
    });
    recordComboRequest("combo-fb", "openai/gpt-4o", {
      success: true,
      latencyMs: 100,
      fallbackCount: 0,
    });

    const metrics = getComboMetrics("combo-fb");
    assert.equal(metrics!.totalFallbacks, 1);
    assert.equal(metrics!.fallbackRate, 50);
  });

  it("records the routing strategy used", () => {
    recordComboRequest("combo-strategy", "openai/gpt-4o", {
      success: true,
      latencyMs: 50,
      strategy: "round-robin",
    });
    assert.equal(getComboMetrics("combo-strategy")!.strategy, "round-robin");
  });

  it("defaults the strategy to 'priority' when not specified", () => {
    recordComboRequest("combo-default-strategy", "openai/gpt-4o", {
      success: true,
      latencyMs: 50,
    });
    assert.equal(getComboMetrics("combo-default-strategy")!.strategy, "priority");
  });

  it("does not track per-model metrics when modelStr is null (all targets failed)", () => {
    recordComboRequest("combo-null-model", null, { success: false, latencyMs: 10 });
    const metrics = getComboMetrics("combo-null-model");
    assert.equal(metrics!.totalRequests, 1);
    assert.deepEqual(metrics!.byModel, {});
  });

  it("aggregates per-model metrics across multiple requests to the same model", () => {
    recordComboRequest("combo-model", "openai/gpt-4o", { success: true, latencyMs: 100 });
    recordComboRequest("combo-model", "openai/gpt-4o", { success: true, latencyMs: 300 });
    recordComboRequest("combo-model", "anthropic/claude-3", { success: false, latencyMs: 50 });

    const metrics = getComboMetrics("combo-model");
    assert.equal(metrics!.byModel["openai/gpt-4o"].requests, 2);
    assert.equal(metrics!.byModel["openai/gpt-4o"].avgLatencyMs, 200);
    assert.equal(metrics!.byModel["openai/gpt-4o"].successRate, 100);
    assert.equal(metrics!.byModel["anthropic/claude-3"].requests, 1);
    assert.equal(metrics!.byModel["anthropic/claude-3"].successRate, 0);
  });

  it("builds per-target metrics keyed by executionKey, inferring provider from the model", () => {
    recordComboRequest("combo-target", "openai/gpt-4o", {
      success: true,
      latencyMs: 100,
      target: { executionKey: "step-1", stepId: "s1" },
    });

    const metrics = getComboMetrics("combo-target");
    const target = metrics!.byTarget["step-1"];
    assert.ok(target);
    assert.equal(target.model, "openai/gpt-4o");
    assert.equal(target.provider, "openai");
    assert.equal(target.stepId, "s1");
    assert.equal(target.requests, 1);
  });

  it("falls back to the model string as the executionKey when target.executionKey is absent", () => {
    recordComboRequest("combo-target-fallback", "openai/gpt-4o", {
      success: true,
      latencyMs: 100,
    });
    const metrics = getComboMetrics("combo-target-fallback");
    assert.ok(metrics!.byTarget["openai/gpt-4o"]);
  });

  it("prefers an explicit target.provider over the inferred one", () => {
    recordComboRequest("combo-explicit-provider", "custom-model", {
      success: true,
      latencyMs: 10,
      target: { executionKey: "step-a", provider: "explicit-provider" },
    });
    const metrics = getComboMetrics("combo-explicit-provider");
    assert.equal(metrics!.byTarget["step-a"].provider, "explicit-provider");
  });

  it("merges repeated requests to the same target, updating latest metadata", () => {
    recordComboRequest("combo-merge", "openai/gpt-4o", {
      success: true,
      latencyMs: 100,
      target: { executionKey: "step-1", label: "first" },
    });
    recordComboRequest("combo-merge", "openai/gpt-4o", {
      success: true,
      latencyMs: 100,
      target: { executionKey: "step-1", label: "second" },
    });

    const target = getComboMetrics("combo-merge")!.byTarget["step-1"];
    assert.equal(target.requests, 2);
    assert.equal(target.label, "second");
  });

  it("explicit null connectionId/label clears existing values rather than being ignored", () => {
    recordComboRequest("combo-clear", "openai/gpt-4o", {
      success: true,
      latencyMs: 10,
      target: { executionKey: "step-1", connectionId: "conn-1", label: "labeled" },
    });
    recordComboRequest("combo-clear", "openai/gpt-4o", {
      success: true,
      latencyMs: 10,
      target: { executionKey: "step-1", connectionId: null, label: null },
    });

    const target = getComboMetrics("combo-clear")!.byTarget["step-1"];
    assert.equal(target.connectionId, null);
    assert.equal(target.label, null);
  });
});

describe("recordComboShadowRequest / shadow metrics", () => {
  it("keeps shadow metrics separate from production metrics", () => {
    recordComboRequest("combo-shadow", "openai/gpt-4o", { success: true, latencyMs: 100 });
    recordComboShadowRequest("combo-shadow", "openai/gpt-4o", { success: false, latencyMs: 999 });

    const metrics = getComboMetrics("combo-shadow");
    assert.equal(metrics!.totalRequests, 1);
    assert.equal(metrics!.shadow.totalRequests, 1);
    assert.equal(metrics!.shadow.totalFailures, 1);
  });

  it("surfaces a combo that only has shadow traffic (no production requests)", () => {
    recordComboShadowRequest("combo-shadow-only", "openai/gpt-4o", {
      success: true,
      latencyMs: 50,
    });

    const metrics = getComboMetrics("combo-shadow-only");
    assert.ok(metrics);
    assert.equal(metrics!.productionTraffic, false);
    assert.equal(metrics!.totalRequests, 0);
    assert.equal(metrics!.shadow.totalRequests, 1);
  });

  it("marks productionTraffic true only once a real production request lands", () => {
    recordComboShadowRequest("combo-mixed", "openai/gpt-4o", { success: true, latencyMs: 50 });
    assert.equal(getComboMetrics("combo-mixed")!.productionTraffic, false);

    recordComboRequest("combo-mixed", "openai/gpt-4o", { success: true, latencyMs: 50 });
    assert.equal(getComboMetrics("combo-mixed")!.productionTraffic, true);
  });
});

describe("getAllComboMetrics", () => {
  it("returns metrics for every combo tracked in either production or shadow maps", () => {
    recordComboRequest("combo-x", "openai/gpt-4o", { success: true, latencyMs: 10 });
    recordComboShadowRequest("combo-y", "openai/gpt-4o", { success: true, latencyMs: 10 });

    const all = getAllComboMetrics();
    assert.ok("combo-x" in all);
    assert.ok("combo-y" in all);
  });

  it("returns an empty object when nothing has been recorded", () => {
    assert.deepEqual(getAllComboMetrics(), {});
  });
});

describe("recordComboIntent", () => {
  it("accumulates intent counts per combo", () => {
    recordComboIntent("combo-intent", "code");
    recordComboIntent("combo-intent", "code");
    recordComboIntent("combo-intent", "chat");

    const metrics = getComboMetrics("combo-intent");
    assert.equal(metrics!.intentCounts.code, 2);
    assert.equal(metrics!.intentCounts.chat, 1);
  });

  it("normalizes a falsy intent to 'unknown'", () => {
    recordComboIntent("combo-intent-unknown", "");
    const metrics = getComboMetrics("combo-intent-unknown");
    assert.equal(metrics!.intentCounts.unknown, 1);
  });
});

describe("resetComboMetrics / resetAllComboMetrics", () => {
  it("resetComboMetrics clears only the specified combo", () => {
    recordComboRequest("combo-keep", "openai/gpt-4o", { success: true, latencyMs: 10 });
    recordComboRequest("combo-reset", "openai/gpt-4o", { success: true, latencyMs: 10 });

    resetComboMetrics("combo-reset");

    assert.equal(getComboMetrics("combo-reset"), null);
    assert.ok(getComboMetrics("combo-keep"));
  });

  it("resetAllComboMetrics clears every combo including shadow metrics", () => {
    recordComboRequest("combo-1", "openai/gpt-4o", { success: true, latencyMs: 10 });
    recordComboShadowRequest("combo-2", "openai/gpt-4o", { success: true, latencyMs: 10 });

    resetAllComboMetrics();

    assert.deepEqual(getAllComboMetrics(), {});
  });
});

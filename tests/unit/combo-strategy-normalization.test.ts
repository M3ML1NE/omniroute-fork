import test from "node:test";
import assert from "node:assert/strict";
import { normalizeComboRecord } from "../../src/lib/combos/steps.ts";
import {
  normalizeRoutingStrategy,
  ROUTING_STRATEGY_VALUES,
} from "../../src/shared/constants/routingStrategies.ts";

const REMOVED_STRATEGIES = [
  "context-relay",
  "fill-first",
  "random",
  "cost-optimized",
  "reset-aware",
  "reset-window",
  "strict-random",
  "auto",
  "lkgp",
  "context-optimized",
];

test("ROUTING_STRATEGY_VALUES is exactly the 5 supported strategies", () => {
  assert.deepEqual(
    [...ROUTING_STRATEGY_VALUES],
    ["priority", "weighted", "round-robin", "p2c", "least-used"]
  );
});

test("normalizeRoutingStrategy degrades every removed strategy to priority", () => {
  for (const strategy of REMOVED_STRATEGIES) {
    assert.equal(normalizeRoutingStrategy(strategy), "priority");
  }
});

test("normalizeRoutingStrategy keeps supported strategies and maps legacy usage", () => {
  for (const strategy of ROUTING_STRATEGY_VALUES) {
    assert.equal(normalizeRoutingStrategy(strategy), strategy);
  }
  assert.equal(normalizeRoutingStrategy("usage"), "least-used");
  assert.equal(normalizeRoutingStrategy(undefined), "priority");
  assert.equal(normalizeRoutingStrategy(""), "priority");
});

test("normalizeComboRecord degrades a stored removed strategy to priority on read", () => {
  const stored = {
    id: "legacy-combo",
    name: "legacy-combo",
    strategy: "lkgp",
    models: ["gigachat-compatible-1/GigaChat-2-Max"],
  };

  const normalized = normalizeComboRecord(stored);

  assert.equal(normalized.strategy, "priority");
  assert.equal(normalized.name, "legacy-combo");
  assert.equal(normalized.models.length, 1);
});

test("normalizeComboRecord preserves a supported strategy on read", () => {
  const normalized = normalizeComboRecord({
    id: "rr-combo",
    name: "rr-combo",
    strategy: "round-robin",
    models: ["gigachat-compatible-1/GigaChat-2-Max"],
  });

  assert.equal(normalized.strategy, "round-robin");
});

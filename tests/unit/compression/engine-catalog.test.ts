// Ported from OmniRoute upstream v3.8.48, adapted for GigaChat fork.
//
// Verifies the engine catalog (stripped to the 9 fork-registered engines — no llmlingua/omniglyph)
// and the deriveDefaultPlan single-mode / stacked derivation.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ENGINE_CATALOG,
  ENGINE_IDS,
  engineMeta,
} from "../../../open-sse/services/compression/engineCatalog.ts";
import { deriveDefaultPlan } from "../../../open-sse/services/compression/deriveDefaultPlan.ts";
import { registerBuiltinCompressionEngines } from "../../../open-sse/services/compression/engines/index.ts";
import { getCompressionEngine } from "../../../open-sse/services/compression/engines/registry.ts";

describe("engine catalog", () => {
  it("contains exactly the 9 fork-registered engines and drops llmlingua/omniglyph", () => {
    const ids = Object.keys(ENGINE_CATALOG).sort();
    assert.deepEqual(ids, [
      "aggressive",
      "caveman",
      "ccr",
      "headroom",
      "lite",
      "relevance",
      "rtk",
      "session-dedup",
      "ultra",
    ]);
    assert.equal(ENGINE_CATALOG.llmlingua, undefined);
    assert.equal(ENGINE_CATALOG.omniglyph, undefined);
  });

  it("orders ENGINE_IDS by ascending stackPriority", () => {
    assert.deepEqual(ENGINE_IDS, [
      "session-dedup",
      "ccr",
      "lite",
      "rtk",
      "headroom",
      "relevance",
      "caveman",
      "aggressive",
      "ultra",
    ]);
  });

  it("every catalog engine is registered in the builtin engine registry", () => {
    registerBuiltinCompressionEngines();
    for (const id of ENGINE_IDS) {
      assert.ok(getCompressionEngine(id), `engine ${id} must be registered`);
    }
  });

  it("engineMeta exposes levels only for engines with intensity options", () => {
    assert.deepEqual(engineMeta("rtk").levels, ["minimal", "standard", "aggressive"]);
    assert.deepEqual(engineMeta("caveman").levels, ["lite", "full", "ultra"]);
    assert.equal(engineMeta("lite").levels, undefined);
  });
});

describe("deriveDefaultPlan", () => {
  it("returns off when master disabled", () => {
    const plan = deriveDefaultPlan({ caveman: { enabled: true } }, false);
    assert.equal(plan.mode, "off");
    assert.deepEqual(plan.stackedPipeline, []);
  });

  it("returns off when no engines are on", () => {
    const plan = deriveDefaultPlan({ caveman: { enabled: false } }, true);
    assert.equal(plan.mode, "off");
  });

  it("maps a single single-mode engine to its standalone mode", () => {
    assert.equal(deriveDefaultPlan({ caveman: { enabled: true } }, true).mode, "standard");
    assert.equal(deriveDefaultPlan({ rtk: { enabled: true } }, true).mode, "rtk");
    assert.equal(deriveDefaultPlan({ lite: { enabled: true } }, true).mode, "lite");
  });

  it("stacks multiple engines ordered by stackPriority", () => {
    const plan = deriveDefaultPlan(
      { caveman: { enabled: true, level: "full" }, rtk: { enabled: true, level: "standard" } },
      true
    );
    assert.equal(plan.mode, "stacked");
    assert.deepEqual(plan.stackedPipeline, [
      { engine: "rtk", intensity: "standard" },
      { engine: "caveman", intensity: "full" },
    ]);
  });

  it("stacks a single non-single-mode engine (headroom) instead of standalone", () => {
    const plan = deriveDefaultPlan({ headroom: { enabled: true } }, true);
    assert.equal(plan.mode, "stacked");
    assert.deepEqual(plan.stackedPipeline, [{ engine: "headroom" }]);
  });
});

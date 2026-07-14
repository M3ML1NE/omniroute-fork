import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  memoLookup,
  memoStore,
  makeMemoKey,
  isDeterministicMode,
  clearMemoStore,
  MEMO_CAP,
} from "../../../open-sse/services/compression/resultMemo.ts";
import type { CompressionResult } from "../../../open-sse/services/compression/types.ts";
import { DEFAULT_COMPRESSION_CONFIG } from "../../../open-sse/services/compression/types.ts";
import type { CompressionEngine } from "../../../open-sse/services/compression/engines/types.ts";
import { applyCompression } from "../../../open-sse/services/compression/strategySelector.ts";
import {
  getCompressionEngine,
  registerEngine,
} from "../../../open-sse/services/compression/engines/registry.ts";
import { registerBuiltinCompressionEngines } from "../../../open-sse/services/compression/engines/index.ts";

const baseBody = {
  messages: [{ role: "user", content: "hello world compress me please" }],
  model: "gpt-4",
};

const memoConfig = {
  ...DEFAULT_COMPRESSION_CONFIG,
  enabled: true,
  defaultMode: "lite" as const,
  memoizeCompressionResults: true,
};

const noMemoConfig = {
  ...DEFAULT_COMPRESSION_CONFIG,
  enabled: true,
  defaultMode: "lite" as const,
  memoizeCompressionResults: false,
};

describe("resultMemo unit", () => {
  beforeEach(() => {
    clearMemoStore();
  });

  it("memoLookup returns null on miss", () => {
    const key = makeMemoKey(baseBody, "lite", noMemoConfig);
    assert.equal(memoLookup(key), null);
  });

  it("memoStore then memoLookup returns the stored result", () => {
    const key = makeMemoKey(baseBody, "lite", memoConfig);
    const result: CompressionResult = {
      body: { ...baseBody, _compressed: true },
      compressed: true,
      stats: {
        originalTokens: 10,
        compressedTokens: 8,
        savingsPercent: 20,
        techniquesUsed: ["lite"],
        mode: "lite",
        timestamp: Date.now(),
      },
    };
    memoStore(key, result);
    const hit = memoLookup(key);
    assert.notEqual(hit, null);
    assert.equal(hit!.compressed, true);
  });

  it("cached body is a COPY — mutating returned body does not corrupt next hit", () => {
    const key = makeMemoKey(baseBody, "lite", memoConfig);
    const result: CompressionResult = {
      body: { messages: [{ role: "user", content: "original" }] },
      compressed: true,
      stats: null,
    };
    memoStore(key, result);

    const hit1 = memoLookup(key);
    (hit1!.body as Record<string, unknown>)["injected"] = "evil";

    const hit2 = memoLookup(key);
    assert.equal((hit2!.body as Record<string, unknown>)["injected"], undefined);
  });

  it("mutating the result after store does not corrupt the cache (clone-on-store)", () => {
    const key = "mutate-after-store";
    const result: CompressionResult = {
      body: { messages: [{ role: "user", content: "original" }] },
      compressed: true,
      stats: null,
    };
    memoStore(key, result);
    (result.body.messages as Array<{ content: string }>)[0].content = "TAMPERED";
    const got = memoLookup(key);
    assert.equal((got!.body.messages as Array<{ content: string }>)[0].content, "original");
  });

  it("key folds in model + supportsVision (lite image-strip depends on vision capability)", () => {
    const k = (model?: string, vision?: boolean | null) =>
      makeMemoKey(baseBody, "lite", memoConfig, model, vision);
    assert.notEqual(k("gpt-4", false), k("gpt-4", true), "supportsVision must change the key");
    assert.notEqual(k("gpt-4", true), k("gemini-2", true), "model must change the key");
    assert.equal(k("gpt-4", true), k("gpt-4", true), "same inputs => same key (deterministic)");
  });

  it("FIFO eviction: after MEMO_CAP entries, oldest is evicted", () => {
    const firstKey = makeMemoKey({ x: 0 }, "lite", memoConfig);
    const stub: CompressionResult = { body: {}, compressed: false, stats: null };
    memoStore(firstKey, stub);

    for (let i = 1; i <= MEMO_CAP; i++) {
      const k = makeMemoKey({ x: i }, "lite", memoConfig);
      memoStore(k, stub);
    }

    assert.equal(memoLookup(firstKey), null);
  });
});

describe("isDeterministicMode", () => {
  it("lite is deterministic", () => {
    assert.equal(isDeterministicMode("lite", DEFAULT_COMPRESSION_CONFIG), true);
  });

  it("standard is deterministic", () => {
    assert.equal(isDeterministicMode("standard", DEFAULT_COMPRESSION_CONFIG), true);
  });

  it("rtk is deterministic", () => {
    assert.equal(isDeterministicMode("rtk", DEFAULT_COMPRESSION_CONFIG), true);
  });

  it("off is NOT deterministic (nothing to cache)", () => {
    assert.equal(isDeterministicMode("off", DEFAULT_COMPRESSION_CONFIG), false);
  });

  it("aggressive is NOT deterministic (pluggable summarizer)", () => {
    assert.equal(isDeterministicMode("aggressive", DEFAULT_COMPRESSION_CONFIG), false);
  });

  it("ultra is NOT deterministic (SLM tier)", () => {
    assert.equal(isDeterministicMode("ultra", DEFAULT_COMPRESSION_CONFIG), false);
  });

  it("stacked with only deterministic engines IS deterministic", () => {
    const cfg = {
      ...DEFAULT_COMPRESSION_CONFIG,
      stackedPipeline: [
        { engine: "rtk" as const, intensity: "standard" as const },
        { engine: "caveman" as const, intensity: "full" as const },
      ],
    };
    assert.equal(isDeterministicMode("stacked", cfg), true);
  });

  it("stacked with relevance engine IS deterministic (pure sentence scorer)", () => {
    const cfg = {
      ...DEFAULT_COMPRESSION_CONFIG,
      stackedPipeline: [{ engine: "relevance" as const }, { engine: "lite" as const }],
    };
    assert.equal(isDeterministicMode("stacked", cfg), true);
  });

  it("stacked with aggressive engine is NOT deterministic", () => {
    const cfg = {
      ...DEFAULT_COMPRESSION_CONFIG,
      stackedPipeline: [{ engine: "aggressive" as const }, { engine: "rtk" as const }],
    };
    assert.equal(isDeterministicMode("stacked", cfg), false);
  });

  it("stacked with ultra engine is NOT deterministic", () => {
    const cfg = {
      ...DEFAULT_COMPRESSION_CONFIG,
      stackedPipeline: [{ engine: "ultra" as const }, { engine: "caveman" as const }],
    };
    assert.equal(isDeterministicMode("stacked", cfg), false);
  });

  it("stacked with empty/undefined pipeline is NOT deterministic (safe default)", () => {
    const cfg = { ...DEFAULT_COMPRESSION_CONFIG, stackedPipeline: undefined };
    assert.equal(isDeterministicMode("stacked", cfg), false);
  });

  it("an unknown/new mode is NOT cached by default (opt-in whitelist)", () => {
    assert.equal(isDeterministicMode("totally-new-mode" as never, DEFAULT_COMPRESSION_CONFIG), false);
  });
});

describe("applyCompression with memoization", () => {
  beforeEach(() => {
    clearMemoStore();
  });

  it("flag OFF: memo store stays empty (no caching path)", () => {
    const body = {
      messages: [
        { role: "user", content: "The quick brown fox jumps over the lazy dog. ".repeat(20) },
      ],
      model: "gpt-4",
    };

    applyCompression(body, "lite", { config: noMemoConfig });
    const key = makeMemoKey(body, "lite", noMemoConfig, undefined);
    assert.equal(memoLookup(key), null);
  });

  it("flag ON + deterministic mode: cache populated and stats stable", () => {
    const body = {
      messages: [{ role: "user", content: "Memoization test content. ".repeat(15) }],
      model: "gpt-4",
    };

    const r1 = applyCompression(body, "lite", { config: memoConfig });
    const r2 = applyCompression(body, "lite", { config: memoConfig });

    assert.deepEqual(r1.stats?.savingsPercent, r2.stats?.savingsPercent);
    assert.deepEqual(r1.stats?.originalTokens, r2.stats?.originalTokens);

    const key = makeMemoKey(body, "lite", memoConfig);
    assert.notEqual(memoLookup(key), null);
  });

  it("flag ON + ultra mode: NOT cached", () => {
    const body = {
      messages: [{ role: "user", content: "Ultra mode should not be cached. ".repeat(10) }],
      model: "gpt-4",
    };

    applyCompression(body, "ultra", { config: memoConfig });
    const key = makeMemoKey(body, "ultra", memoConfig);
    assert.equal(memoLookup(key), null);
  });
});

// ── Genuine call-counter spy: prove the engine is NOT re-invoked on a memo hit ──
describe("applyCompression memoization — engine call-counter spy", () => {
  let originalRtk: CompressionEngine | null;

  beforeEach(() => {
    clearMemoStore();
    registerBuiltinCompressionEngines();
    originalRtk = getCompressionEngine("rtk");
  });

  afterEach(() => {
    // Restore the real rtk engine so we don't leak the spy into other suites.
    if (originalRtk) registerEngine(originalRtk);
  });

  it("second identical call with memo ON does NOT re-invoke the engine (spy count stays 1)", () => {
    assert.ok(originalRtk, "rtk engine must be registered");

    let applyCount = 0;
    const spyEngine: CompressionEngine = {
      ...(originalRtk as CompressionEngine),
      apply(body, options) {
        applyCount += 1;
        return (originalRtk as CompressionEngine).apply(body, options);
      },
    };
    registerEngine(spyEngine);

    const body = {
      messages: [
        { role: "tool", content: "line1\nline1\nline2\nline2\nline3\nline3\n".repeat(4) },
      ],
      model: "gpt-4",
    };
    // Stacked pipeline of a single deterministic engine (rtk) → memoizable.
    const stackedMemoConfig = {
      ...memoConfig,
      stackedPipeline: [{ engine: "rtk" as const, intensity: "standard" as const }],
    };

    const r1 = applyCompression(body, "stacked", { config: stackedMemoConfig });
    assert.equal(applyCount, 1, "first call must invoke the engine exactly once");

    const r2 = applyCompression(body, "stacked", { config: stackedMemoConfig });
    assert.equal(applyCount, 1, "second call must be served from memo — engine NOT re-invoked");

    // The cached result must be equivalent to the freshly computed one.
    assert.deepEqual(r2.stats?.compressedTokens, r1.stats?.compressedTokens);
    assert.deepEqual(r2.stats?.originalTokens, r1.stats?.originalTokens);
  });

  it("memo OFF: second identical call DOES re-invoke the engine (spy count = 2)", () => {
    assert.ok(originalRtk, "rtk engine must be registered");

    let applyCount = 0;
    const spyEngine: CompressionEngine = {
      ...(originalRtk as CompressionEngine),
      apply(body, options) {
        applyCount += 1;
        return (originalRtk as CompressionEngine).apply(body, options);
      },
    };
    registerEngine(spyEngine);

    const body = {
      messages: [{ role: "tool", content: "a\na\nb\nb\nc\nc\n".repeat(4) }],
      model: "gpt-4",
    };
    const stackedNoMemoConfig = {
      ...noMemoConfig,
      stackedPipeline: [{ engine: "rtk" as const, intensity: "standard" as const }],
    };

    applyCompression(body, "stacked", { config: stackedNoMemoConfig });
    applyCompression(body, "stacked", { config: stackedNoMemoConfig });
    assert.equal(applyCount, 2, "with memo off both calls invoke the engine");
  });
});

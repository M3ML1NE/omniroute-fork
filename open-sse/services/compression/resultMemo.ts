import crypto from "node:crypto";
import type { CompressionConfig, CompressionMode, CompressionResult } from "./types.ts";

export const MEMO_CAP = 5_000;

const memoMap = new Map<string, CompressionResult>();

// Opt-IN whitelist (NOT opt-out): cache only engines proven pure + STATELESS across
// requests. In this fork the compression engine set is `lite`, `caveman`, `rtk`,
// `relevance`, `aggressive`, `ultra`. `lite`/`caveman`/`rtk`/`relevance` read only the
// request body + config (no cross-request store, no timing/randomness affecting the
// compressed body), so they are safe to memoize. `aggressive` (pluggable summarizer)
// and `ultra` (SLM tier) are model-backed / non-deterministic → never cached. Any NEW
// engine is excluded until explicitly vetted.
const DETERMINISTIC_ENGINES = new Set<string>(["lite", "caveman", "rtk", "relevance"]);

/** Top-level modes safe to cache (whitelist — any unknown/new mode defaults to false). */
const DETERMINISTIC_MODES = new Set<CompressionMode>(["lite", "standard", "rtk"]);

export function isDeterministicMode(mode: CompressionMode, config?: CompressionConfig): boolean {
  if (mode === "stacked") {
    const pipeline = config?.stackedPipeline;
    if (!pipeline || pipeline.length === 0) return false;
    return pipeline.every((step) => DETERMINISTIC_ENGINES.has(step.engine));
  }
  return DETERMINISTIC_MODES.has(mode);
}

function sha256hex(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function makeMemoKey(
  body: Record<string, unknown>,
  mode: CompressionMode,
  config: CompressionConfig,
  model?: string,
  supportsVision?: boolean | null
): string {
  const bodyHash = sha256hex(JSON.stringify(body));
  // model + supportsVision MUST be part of the key: the `lite` engine strips data:image
  // URLs only when vision is unsupported (replaceImageUrls / modelSupportsVision), so the
  // same (body, config) yields a DIFFERENT result per target — omitting them would return a
  // wrong (image-stripped or image-kept) cached body across vision/non-vision targets.
  return sha256hex(
    JSON.stringify({
      bodyHash,
      mode,
      config,
      model: model ?? null,
      supportsVision: supportsVision ?? null,
    })
  );
}

function boundedSet(key: string, value: CompressionResult): void {
  if (!memoMap.has(key) && memoMap.size >= MEMO_CAP) {
    const firstKey = memoMap.keys().next().value;
    if (firstKey !== undefined) {
      memoMap.delete(firstKey);
    }
  }
  memoMap.set(key, value);
}

export function memoLookup(key: string): CompressionResult | null {
  const hit = memoMap.get(key);
  if (!hit) return null;
  // Return a clone so downstream mutation cannot corrupt the cached value.
  return JSON.parse(JSON.stringify(hit)) as CompressionResult;
}

export function memoStore(key: string, result: CompressionResult): void {
  // Clone on STORE too (memoLookup already clones on read). Storing the caller's live
  // object would let a later mutation of it corrupt the cached entry. Both ends isolated
  // ⇒ the cache is immutable once stored.
  boundedSet(key, JSON.parse(JSON.stringify(result)) as CompressionResult);
}

/** For tests only — clears the in-process memo store. */
export function clearMemoStore(): void {
  memoMap.clear();
}

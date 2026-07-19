/**
 * Unit tests for GigaChat v1 `precached_prompt_tokens` handling — the gap where
 * streamed gigachat-compatible usage chunks dropped cache-read tokens because
 * extractUsage()/extractUsageFromResponse() only checked prompt_cache_hit_tokens
 * (DeepSeek) and not GigaChat's precached_prompt_tokens.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractUsage } from "../../open-sse/utils/usageTracking.ts";
import { extractUsageFromResponse } from "../../open-sse/handlers/usageExtractor.ts";

type NormalizedUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
};

describe("extractUsage (streaming) — precached_prompt_tokens fallback", () => {
  it("maps precached_prompt_tokens onto cached_tokens when no other cache field is present", () => {
    const usage = extractUsage({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 5,
        precached_prompt_tokens: 42,
      },
    }) as NormalizedUsage;
    assert.equal(usage.prompt_tokens, 100);
    assert.equal(usage.completion_tokens, 5);
    assert.equal(usage.cached_tokens, 42);
  });

  it("prefers prompt_tokens_details.cached_tokens over precached_prompt_tokens when both present", () => {
    const usage = extractUsage({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 64 },
        precached_prompt_tokens: 42,
      },
    }) as NormalizedUsage;
    assert.equal(usage.cached_tokens, 64);
  });

  it("prefers prompt_cache_hit_tokens (DeepSeek) over precached_prompt_tokens when both present", () => {
    const usage = extractUsage({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 5,
        prompt_cache_hit_tokens: 30,
        precached_prompt_tokens: 42,
      },
    }) as NormalizedUsage;
    assert.equal(usage.cached_tokens, 30);
  });

  it("leaves cached_tokens undefined when precached_prompt_tokens is absent", () => {
    const usage = extractUsage({
      usage: { prompt_tokens: 100, completion_tokens: 5 },
    }) as NormalizedUsage;
    assert.equal(usage.cached_tokens, undefined);
  });
});

describe("extractUsageFromResponse (non-stream) — precached_prompt_tokens fallback", () => {
  it("maps precached_prompt_tokens onto cached_tokens as the last fallback", () => {
    const usage = extractUsageFromResponse({
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        precached_prompt_tokens: 4,
      },
    }) as NormalizedUsage;
    assert.equal(usage.cached_tokens, 4);
  });

  it("prefers prompt_tokens_details.cached_tokens over precached_prompt_tokens when both present", () => {
    const usage = extractUsageFromResponse({
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 8 },
        precached_prompt_tokens: 4,
      },
    }) as NormalizedUsage;
    assert.equal(usage.cached_tokens, 8);
  });
});

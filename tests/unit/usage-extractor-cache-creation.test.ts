/**
 * Unit tests for extractUsageFromResponse — prompt cache CREATION tokens.
 *
 * Regression: the OpenAI-format branch only mapped cache READ tokens
 * (cached_tokens), silently dropping cache CREATION tokens reported by
 * upstream in either shape:
 *   - top-level `cache_creation_input_tokens` (Claude-style field riding on
 *     an otherwise OpenAI-shaped usage object)
 *   - nested `prompt_tokens_details.cache_creation_tokens`
 * This left `usage_history.tokens_cache_creation` always 0 for OpenAI-format
 * providers, even though cache reads worked correctly.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractUsageFromResponse } from "../../open-sse/handlers/usageExtractor.ts";

describe("extractUsageFromResponse — cache creation tokens (OpenAI format)", () => {
  it("maps top-level cache_creation_input_tokens", () => {
    const usage = extractUsageFromResponse({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 64 },
        cache_creation_input_tokens: 16,
      },
    });
    assert.equal(usage.prompt_tokens, 100);
    assert.equal(usage.completion_tokens, 5);
    assert.equal(usage.cached_tokens, 64);
    assert.equal(usage.cache_creation_input_tokens, 16);
  });

  it("maps nested prompt_tokens_details.cache_creation_tokens", () => {
    const usage = extractUsageFromResponse({
      usage: {
        prompt_tokens: 200,
        completion_tokens: 8,
        prompt_tokens_details: { cached_tokens: 128, cache_creation_tokens: 32 },
      },
    });
    assert.equal(usage.cached_tokens, 128);
    assert.equal(usage.cache_creation_input_tokens, 32);
  });

  it("prefers top-level field over nested when both present", () => {
    const usage = extractUsageFromResponse({
      usage: {
        prompt_tokens: 300,
        completion_tokens: 10,
        cache_creation_input_tokens: 16,
        prompt_tokens_details: { cached_tokens: 64, cache_creation_tokens: 999 },
      },
    });
    assert.equal(usage.cache_creation_input_tokens, 16);
  });

  it("leaves cache_creation_input_tokens undefined when provider reports neither shape", () => {
    const usage = extractUsageFromResponse({
      usage: { prompt_tokens: 1000, completion_tokens: 500 },
    });
    assert.equal(usage.cache_creation_input_tokens, undefined);
  });
});

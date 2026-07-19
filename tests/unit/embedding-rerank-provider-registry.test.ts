import test from "node:test";
import assert from "node:assert/strict";
import {
  getAllEmbeddingModels,
  getEmbeddingProviders,
  getEmbeddingProvider,
  parseEmbeddingModel,
} from "../../open-sse/config/embeddingRegistry.ts";
import {
  getAllRerankModels,
  getRerankProviders,
  getRerankProvider,
  parseRerankModel,
} from "../../open-sse/config/rerankRegistry.ts";

// These registries were purged of every hardcoded named-provider entry
// (compatible-only-provider-docs-purge). Only the dynamic local-node
// resolution path (buildDynamicEmbeddingProvider) remains for embeddings;
// rerank has no dynamic builder equivalent. These tests lock the
// emptied-registry invariant so a future edit can't silently reintroduce
// a hardcoded named provider.

test("embedding provider registry has no hardcoded named-provider entries", () => {
  assert.deepEqual(getEmbeddingProviders(), {});
  assert.equal(getEmbeddingProvider("voyage-ai"), null);
  assert.equal(getEmbeddingProvider("upstage"), null);
  assert.equal(getEmbeddingProvider("nvidia"), null);
  assert.deepEqual(getAllEmbeddingModels(), []);
});

test("rerank provider registry has no hardcoded named-provider entries", () => {
  assert.deepEqual(getRerankProviders(), {});
  assert.equal(getRerankProvider("voyage-ai"), null);
  assert.equal(getRerankProvider("jina-ai"), null);
  assert.equal(getRerankProvider("nvidia"), null);
  assert.deepEqual(getAllRerankModels(), []);
});

test("parseEmbeddingModel falls back to first-segment-as-provider when no registry match exists", () => {
  const parsed = parseEmbeddingModel("nvidia/nv-embedqa-e5-v5");
  assert.equal(parsed.provider, "nvidia");
  assert.equal(parsed.model, "nv-embedqa-e5-v5");
});

test("parseRerankModel returns null provider when no registry match exists (no fallback phase)", () => {
  const parsed = parseRerankModel("nvidia/nv-rerankqa-mistral-4b-v3");
  assert.equal(parsed.provider, null);
  assert.equal(parsed.model, "nvidia/nv-rerankqa-mistral-4b-v3");
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getEmbeddingProvider,
  parseEmbeddingModel,
  getAllEmbeddingModels,
} from "../../open-sse/config/embeddingRegistry.ts";
import { getImageProvider, parseImageModel } from "../../open-sse/config/imageRegistry.ts";

// openrouter/github were hardcoded named-provider entries removed by the
// compatible-only-provider-docs-purge (Todo 5). These registries now only
// resolve dynamically-registered local provider_nodes, so a bare lookup by
// name returns null/undefined and prefix parsing falls through to the
// "first segment is provider" phase instead of matching a static entry.
describe("OpenRouter & GitHub registry entries (post-purge: no hardcoded named providers)", () => {
  describe("embeddingRegistry — openrouter", () => {
    it("no longer resolves a hardcoded openrouter provider config", () => {
      const p = getEmbeddingProvider("openrouter");
      assert.equal(p, null);
    });

    it("parses openrouter/openai/text-embedding-3-small via prefix fallback (no registry match)", () => {
      const result = parseEmbeddingModel("openrouter/openai/text-embedding-3-small");
      assert.equal(result.provider, "openrouter");
      assert.equal(result.model, "openai/text-embedding-3-small");
    });

    it("openrouter models no longer appear in getAllEmbeddingModels", () => {
      const all = getAllEmbeddingModels();
      const orModels = all.filter((m) => m.provider === "openrouter");
      assert.equal(orModels.length, 0);
    });
  });

  describe("embeddingRegistry — github", () => {
    it("no longer resolves a hardcoded github provider config", () => {
      const p = getEmbeddingProvider("github");
      assert.equal(p, null);
    });

    it("parses github/text-embedding-3-small via prefix fallback (no registry match)", () => {
      const result = parseEmbeddingModel("github/text-embedding-3-small");
      assert.equal(result.provider, "github");
      assert.equal(result.model, "text-embedding-3-small");
    });
  });

  describe("imageRegistry — openrouter", () => {
    it("no longer resolves a hardcoded openrouter image provider config", () => {
      const p = getImageProvider("openrouter");
      assert.equal(p, null);
    });

    it("returns a null provider for openrouter/openai/gpt-5.4-image-2 (no registry match, no fallback phase)", () => {
      const result = parseImageModel("openrouter/openai/gpt-5.4-image-2");
      assert.equal(result.provider, null);
      assert.equal(result.model, "openrouter/openai/gpt-5.4-image-2");
    });
  });
});

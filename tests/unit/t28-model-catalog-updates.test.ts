import test from "node:test";
import assert from "node:assert/strict";

import { getModelInfoCore } from "../../open-sse/services/model.ts";
import { REGISTRY } from "../../open-sse/config/providerRegistry.ts";




test("T28: qwen registry uses native chat.qwen.ai base URL", () => {
  assert.equal(
    REGISTRY.qwen.baseUrl,
    "https://chat.qwen.ai/api/v1/services/aigc/text-generation/generation"
  );
});

test("T28: vertex catalog includes partner models when vertex executor is available", () => {
  const vertexIds = REGISTRY.vertex.models.map((m) => m.id);

  assert.ok(vertexIds.includes("DeepSeek-V4-Flash"));
  assert.ok(vertexIds.includes("DeepSeek-V4-Pro"));
  assert.ok(vertexIds.includes("Qwen3.6-35B-A3B"));
  assert.ok(vertexIds.includes("GLM-5.1-FP8"));
});

test("T28: new catalog models resolve through getModelInfoCore", async () => {
  const minimax = await getModelInfoCore("minimax/MiniMax-M2.7", {});
  assert.equal(minimax.provider, "minimax");
  assert.equal(minimax.model, "MiniMax-M2.7");

  const flashLite = await getModelInfoCore("gemini/gemini-3.1-flash-lite-preview", {});
  assert.equal(flashLite.provider, "gemini");
  assert.equal(flashLite.model, "gemini-3.1-flash-lite-preview");

  const flashPreview = await getModelInfoCore("gemini/gemini-3-flash-preview", {});
  assert.equal(flashPreview.provider, "gemini");
  assert.equal(flashPreview.model, "gemini-3-flash-preview");

  const vertexPartner = await getModelInfoCore("vertex/Qwen3.6-35B-A3B", {});
  assert.equal(vertexPartner.provider, "vertex");
  assert.equal(vertexPartner.model, "Qwen3.6-35B-A3B");
});

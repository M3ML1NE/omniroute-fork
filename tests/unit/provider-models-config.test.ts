import test from "node:test";
import assert from "node:assert/strict";

import {
  PROVIDER_ID_TO_ALIAS,
  PROVIDER_MODELS,
  findModelName,
  getDefaultModel,
  getModelTargetFormat,
  getModelsByProviderId,
  getProviderModels,
  isValidModel,
  supportsClaudeMaxEffort,
  supportsXHighEffort,
} from "../../open-sse/config/providerModels.ts";

test("provider models helpers expose model lists and defaults", () => {
  const openaiModels = getProviderModels("openai");

  assert.ok(Array.isArray(openaiModels));
  assert.ok(openaiModels.length > 0);
  assert.equal(getProviderModels("provider-that-does-not-exist").length, 0);
  assert.equal(getDefaultModel("openai"), openaiModels[0].id);
  assert.equal(getDefaultModel("provider-that-does-not-exist"), null);
});

test("provider models helpers validate and resolve model metadata", () => {
  const openaiModels = PROVIDER_MODELS.openai;
  const firstModel = openaiModels[0];

  assert.equal(isValidModel("openai", firstModel.id), true);
  assert.equal(isValidModel("openai", "missing-model"), false);
  assert.equal(
    isValidModel("passthrough-provider", "anything-goes", new Set(["passthrough-provider"])),
    true
  );

  assert.equal(findModelName("openai", firstModel.id), firstModel.name);
  assert.equal(findModelName("openai", "missing-model"), "missing-model");
  assert.equal(findModelName("missing-provider", "missing-model"), "missing-model");

  assert.equal(getModelTargetFormat("openai", firstModel.id), firstModel.targetFormat || null);
  assert.equal(getModelTargetFormat("openai", "missing-model"), null);
  assert.equal(getModelTargetFormat("missing-provider", "missing-model"), null);
});

test("provider models helpers resolve provider IDs through aliases", () => {
  const firstProviderId = Object.keys(PROVIDER_ID_TO_ALIAS)[0];
  const alias = PROVIDER_ID_TO_ALIAS[firstProviderId] || firstProviderId;

  assert.deepEqual(getModelsByProviderId(firstProviderId), PROVIDER_MODELS[alias] || []);
  assert.deepEqual(getModelsByProviderId("provider-that-does-not-exist"), []);
});

test("Reka registry exposes preset models", () => {
  const rekaModels = getModelsByProviderId("reka");
  const ids = rekaModels.map((model) => model.id);

  assert.equal(PROVIDER_ID_TO_ALIAS.reka, "reka");
  assert.equal(getDefaultModel("reka"), "reka-flash-3");
  assert.deepEqual(ids, ["reka-flash-3", "reka-edge-2603"]);
  assert.equal(isValidModel("reka", "reka-edge-2603"), true);
});



test("Claude max effort support excludes Haiku family and non-Claude IDs", () => {
  assert.equal(supportsClaudeMaxEffort("claude-opus-4-7"), true);
  assert.equal(supportsClaudeMaxEffort("claude-opus-4-6"), true);
  assert.equal(supportsClaudeMaxEffort("claude-sonnet-4-6"), true);
  assert.equal(supportsClaudeMaxEffort("claude-sonnet-4-5-20250929"), true);
  assert.equal(supportsClaudeMaxEffort("claude-haiku-4-5-20251001"), false);
  assert.equal(supportsClaudeMaxEffort("claude-3-5-haiku-20241022"), false);
  assert.equal(supportsClaudeMaxEffort("anthropic/claude-haiku-4.5"), false);
  assert.equal(supportsClaudeMaxEffort("vendor/haiku-compatible-claude-sonnet-4-6"), true);
  assert.equal(supportsClaudeMaxEffort("gpt-5"), false);
  assert.equal(supportsClaudeMaxEffort("claude-future-5-0"), true);
});

test("Claude xhigh effort support defaults on for new models and opts out legacy models", () => {
  const claudeModels = new Set(getModelsByProviderId("claude").map((model) => model.id));

  assert.ok(claudeModels.has("claude-opus-4-8"));
  assert.equal(supportsXHighEffort("claude", "claude-opus-4-8"), true);
  assert.equal(supportsXHighEffort("claude", "claude-opus-4-7"), true);
  assert.equal(supportsXHighEffort("claude", "claude-opus-4-6"), false);
  assert.equal(supportsXHighEffort("claude", "claude-sonnet-4-6"), false);
  assert.equal(supportsXHighEffort("claude", "claude-future-5-0"), true);
});

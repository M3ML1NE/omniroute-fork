import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-model-capabilities-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const modelCapabilities = await import("../../src/lib/modelCapabilities.ts");

function buildCapability(overrides = {}) {
  return {
    tool_call: null,
    reasoning: null,
    attachment: null,
    structured_output: null,
    temperature: null,
    modalities_input: "[]",
    modalities_output: "[]",
    knowledge_cutoff: null,
    release_date: null,
    last_updated: null,
    status: null,
    family: null,
    open_weights: null,
    limit_context: null,
    limit_input: null,
    limit_output: null,
    interleaved_field: null,
    ...overrides,
  };
}

function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(() => {
  resetStorage();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("GPT OSS and DeepSeek Reasoner models support tool calling", () => {
  // GPT OSS models should not be blocked by the heuristic
  assert.equal(modelCapabilities.supportsToolCalling("fake-provider/gpt-oss-120b"), true);
  assert.equal(modelCapabilities.supportsToolCalling("gpt-oss-120b"), true);
  assert.equal(modelCapabilities.supportsToolCalling("nvidia/openai/gpt-oss-20b"), false); // in registry

  // DeepSeek Reasoner supports tool calling
  assert.equal(modelCapabilities.supportsToolCalling("deepseek-reasoner"), true);
  assert.equal(modelCapabilities.supportsToolCalling("deepseek/deepseek-r1"), true);

  // Full capability resolution
  const gptOss = modelCapabilities.getResolvedModelCapabilities("fake-provider/gpt-oss-120b");
  assert.equal(gptOss.toolCalling, true);
  const deepseek = modelCapabilities.getResolvedModelCapabilities("deepseek/deepseek-reasoner");
  assert.equal(deepseek.toolCalling, true);
});

test("Kimi K2.6 supports vision capability", () => {
  const kimi = modelCapabilities.getResolvedModelCapabilities("kimi-k2.6");
  assert.equal(kimi.supportsVision, true);
  assert.equal(kimi.supportsThinking, true);
  assert.equal(kimi.supportsTools, true);
  assert.equal(kimi.contextWindow, 262144);
  assert.equal(kimi.maxOutputTokens, 262144);

  // Also test via alias
  const kimiThinking = modelCapabilities.getResolvedModelCapabilities("kimi-k2.6-thinking");
  assert.equal(kimiThinking.supportsVision, true);
});

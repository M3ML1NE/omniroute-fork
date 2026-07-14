import test from "node:test";
import assert from "node:assert/strict";
import { applyHardBudget } from "../../open-sse/services/compression/hardBudget.ts";
import { estimateCompressionTokens } from "../../open-sse/services/compression/stats.ts";
import { applyStackedCompression } from "../../open-sse/services/compression/strategySelector.ts";
import { DEFAULT_COMPRESSION_CONFIG } from "../../open-sse/services/compression/types.ts";

const PROSE = [
  "The quick brown fox jumps over the lazy dog and runs through the forest.",
  "Artificial intelligence systems can process large amounts of information efficiently.",
  "Machine learning models require substantial computational resources for training.",
  "Error: something went wrong in the processing pipeline at line 42.",
  "Natural language processing enables computers to understand human language semantically.",
  "Deep learning architectures consist of multiple interconnected layers of neurons.",
  "The database contains approximately 1234567 records from the past fiscal year.",
  "Transformer models have revolutionized the field of natural language understanding.",
  "Reinforcement learning allows agents to learn optimal policies through experience.",
  "The gradient descent algorithm iteratively minimizes the loss function during training.",
  "Convolutional neural networks excel at image recognition and classification tasks.",
  "Transfer learning leverages pre-trained models to accelerate new task learning.",
  "Data preprocessing steps include normalization, tokenization, and feature extraction.",
  "Hyperparameter tuning is essential for optimizing model performance and generalization.",
  "The attention mechanism allows models to focus on relevant input sequence parts.",
  "Batch normalization stabilizes training by normalizing activations within mini-batches.",
  "Dropout regularization helps prevent overfitting in deep neural network architectures.",
  "The validation set monitors model performance and guides hyperparameter selection.",
  "Cross-entropy loss measures the difference between predicted and actual distributions.",
  "Stochastic gradient descent updates model parameters using randomly sampled batches.",
].join("\n");

function makeBody(content: string) {
  return { messages: [{ role: "user", content }] };
}

function totalTokens(body: { messages: Array<{ content: string }> }): number {
  return body.messages.reduce((s, m) => s + estimateCompressionTokens(m.content), 0);
}

// ── happy-path: compression-into-budget ─────────────────────────────────────

test("targetTokens cuts body to at most targetTokens", () => {
  const proseTokens = estimateCompressionTokens(PROSE);
  const target = Math.floor(proseTokens * 0.5);
  const result = applyHardBudget(makeBody(PROSE), { targetTokens: target });
  assert.equal(result.compressed, true);
  const out = totalTokens(result.body as { messages: Array<{ content: string }> });
  assert.ok(out <= target, `output ${out} must be <= target ${target}`);
});

test("targetRatio compresses toward the ratio target", () => {
  const proseTokens = estimateCompressionTokens(PROSE);
  const result = applyHardBudget(makeBody(PROSE), { targetRatio: 0.5 });
  assert.equal(result.compressed, true);
  const out = totalTokens(result.body as { messages: Array<{ content: string }> });
  assert.ok(out <= Math.ceil(proseTokens * 0.5), `output ${out} exceeds ratio target`);
});

test("targetTokens wins the tie-break over targetRatio (more aggressive result)", () => {
  const proseTokens = estimateCompressionTokens(PROSE);
  // targetTokens (aggressive) vs targetRatio 0.9 (barely trims). If targetTokens
  // wins, the output is far below the ratio target, not near it.
  const bothSet = applyHardBudget(makeBody(PROSE), { targetTokens: 60, targetRatio: 0.9 });
  const ratioOnly = applyHardBudget(makeBody(PROSE), { targetRatio: 0.9 });
  const bothOut = totalTokens(bothSet.body as { messages: Array<{ content: string }> });
  const ratioOut = totalTokens(ratioOnly.body as { messages: Array<{ content: string }> });
  assert.ok(bothOut < ratioOut, `targetTokens should win: ${bothOut} must be < ratio-only ${ratioOut}`);
  assert.ok(bothOut < Math.ceil(proseTokens * 0.9));
});

test("signal-carrying lines (Error:/number/URL) survive an aggressive cut", () => {
  const sensitive = [
    "Error: critical failure occurred",
    "The quick brown fox jumps over the lazy dog and runs today.",
    "Amount: 99999",
    "Irrelevant filler text here.",
    "Another line of boring unimportant low-signal content.",
    "https://example.com/api/endpoint",
    "More filler words to pad the token count here for us.",
    "And yet more words that are clearly not important at all.",
  ].join("\n");
  const total = estimateCompressionTokens(sensitive);
  const result = applyHardBudget(makeBody(sensitive), { targetTokens: Math.floor(total * 0.4) });
  const out = (result.body.messages as Array<{ content: string }>).map((m) => m.content).join("\n");
  assert.match(out, /Error:/);
  assert.match(out, /99999/);
  assert.match(out, /https:\/\//);
});

test("aggregate target keeps TOTAL <= target across multiple messages", () => {
  const block = (tag: string) =>
    [
      `The ${tag} alpha system processes large amounts of information efficiently every day.`,
      `The ${tag} beta module requires substantial computational resources for routine training.`,
      `The ${tag} gamma layer enables programs to understand structured language semantically here.`,
      `The ${tag} delta network consists of multiple interconnected processing components today.`,
      `The ${tag} epsilon routine accelerates new task learning through transfer of prior knowledge.`,
      `The ${tag} zeta pipeline stabilizes throughput by normalizing activations within batches.`,
    ].join("\n");
  const body = {
    messages: [
      { role: "user", content: block("one") },
      { role: "assistant", content: block("two") },
      { role: "user", content: block("three") },
      { role: "assistant", content: block("four") },
    ],
  };
  const target = 200;
  const before = totalTokens(body as { messages: Array<{ content: string }> });
  assert.ok(before > target);
  const result = applyHardBudget(body, { targetTokens: target });
  assert.equal(result.compressed, true);
  const after = totalTokens(result.body as { messages: Array<{ content: string }> });
  assert.ok(after <= target, `aggregate ${after} must stay <= ${target}`);
});

test("techniquesUsed includes hard-budget when compression occurred", () => {
  const proseTokens = estimateCompressionTokens(PROSE);
  const result = applyHardBudget(makeBody(PROSE), { targetTokens: Math.floor(proseTokens * 0.5) });
  assert.ok(result.stats !== null);
  assert.ok(result.stats!.techniquesUsed.includes("hard-budget"));
});

test("determinism: same input always produces same output", () => {
  const target = Math.floor(estimateCompressionTokens(PROSE) * 0.5);
  const r1 = applyHardBudget(makeBody(PROSE), { targetTokens: target });
  const r2 = applyHardBudget(makeBody(PROSE), { targetTokens: target });
  assert.equal(JSON.stringify(r1.body), JSON.stringify(r2.body));
});

test("warns when preserved content makes the target unreachable", () => {
  const lines = [
    "Value 11111 is here",
    "Value 22222 is here",
    "Value 33333 is here",
    "Value 44444 is here",
    "Value 55555 is here",
    "Value 66666 is here",
  ].join("\n");
  const total = estimateCompressionTokens(lines);
  const result = applyHardBudget(makeBody(lines), { targetTokens: Math.floor(total * 0.3) });
  assert.ok(result.stats !== null);
  const warnings = result.stats!.validationWarnings ?? [];
  assert.ok(warnings.some((w) => w.includes("hard-budget") && w.includes("could not reach target")));
});

// ── fail-open on garbage input ──────────────────────────────────────────────

test("fail-open when messages is not an array", () => {
  const body = { messages: "not an array" } as Record<string, unknown>;
  const result = applyHardBudget(body, { targetTokens: 10 });
  assert.equal(result.compressed, false);
  assert.equal(result.stats, null);
});

test("fail-open on empty body object", () => {
  const result = applyHardBudget({}, { targetTokens: 10 });
  assert.equal(result.compressed, false);
  assert.equal(result.stats, null);
});

test("fail-open on empty messages array", () => {
  const result = applyHardBudget({ messages: [] }, { targetTokens: 10 });
  assert.equal(result.compressed, false);
  assert.equal(result.stats, null);
});

test("already-under-target is a no-op", () => {
  const body = makeBody("Hello world.");
  const result = applyHardBudget(body, { targetTokens: 1000 });
  assert.equal(result.compressed, false);
  assert.equal(JSON.stringify(result.body), JSON.stringify(body));
});

test("targetTokens:0 engages the post-pass (not a silent skip)", () => {
  const result = applyHardBudget(makeBody(PROSE), { targetTokens: 0 });
  const warnings = result.stats?.validationWarnings ?? [];
  assert.ok(result.compressed || warnings.length > 0);
});

// ── off-by-default verification ─────────────────────────────────────────────

test("no target set is a byte-identical no-op (off by default)", () => {
  const body = makeBody(PROSE);
  const result = applyHardBudget(body, {});
  assert.equal(result.compressed, false);
  assert.equal(JSON.stringify(result.body), JSON.stringify(body));
  assert.equal(result.stats, null);
});

test("DEFAULT_COMPRESSION_CONFIG leaves targetTokens and targetRatio unset", () => {
  assert.equal(DEFAULT_COMPRESSION_CONFIG.targetTokens, undefined);
  assert.equal(DEFAULT_COMPRESSION_CONFIG.targetRatio, undefined);
});

test("stacked pipeline without a target does not apply hard-budget", () => {
  const config = { ...DEFAULT_COMPRESSION_CONFIG, enabled: true };
  const result = applyStackedCompression(makeBody(PROSE), [{ engine: "caveman", intensity: "lite" }], {
    config,
  });
  const techniques = result.stats?.techniquesUsed ?? [];
  assert.ok(!techniques.includes("hard-budget"));
});

test("stacked pipeline with config.targetTokens runs hard-budget at end of pipeline", () => {
  const config = { ...DEFAULT_COMPRESSION_CONFIG, enabled: true, targetTokens: 150 };
  const result = applyStackedCompression(makeBody(PROSE), [{ engine: "caveman", intensity: "lite" }], {
    config,
  });
  const techniques = result.stats?.techniquesUsed ?? [];
  assert.ok(techniques.includes("hard-budget"));
  const out = totalTokens(result.body as { messages: Array<{ content: string }> });
  assert.ok(out <= 150, `integration output ${out} must be <= 150`);
});

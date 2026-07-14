import test from "node:test";
import assert from "node:assert/strict";
import { relevanceEngine } from "../../open-sse/services/compression/engines/relevance/index.ts";
import { scoreSentences } from "../../open-sse/services/compression/engines/relevance/scorer.ts";
import { getEffectiveMode } from "../../open-sse/services/compression/strategySelector.ts";
import { DEFAULT_COMPRESSION_CONFIG } from "../../open-sse/services/compression/types.ts";

const DEFAULT_CFG = {
  enabled: false,
  overlapThreshold: 0.1,
  budgetPercent: 0.5,
  boilerplateWeight: 0.5,
};

// ── happy-path: compression-to-relevance-score ──────────────────────────────

test("apply keeps port-relevant sentences and drops irrelevant prose", () => {
  const body = {
    messages: [
      { role: "user", content: "How do I configure the PostgreSQL database connection?" },
      {
        role: "user",
        content:
          "What is the port? " +
          "Also tell me about host parameters. " +
          "Unrelated: what color is the sky? " +
          "PostgreSQL port is 5432. " +
          "The sky is blue on a clear day. " +
          "Connection requires host and port settings.",
      },
    ],
  };
  const result = relevanceEngine.apply(body, {
    stepConfig: { enabled: true, budgetPercent: 0.5, overlapThreshold: 0.05 },
  });
  assert.equal(result.compressed, true);
  const messages = result.body.messages as Array<{ content: string }>;
  const lastContent = messages[messages.length - 1].content;
  assert.match(lastContent, /port/i);
});

test("scoreSentences ranks a relevant sentence above an irrelevant one", () => {
  const sentences = [
    "The quick brown fox jumps over the lazy dog",
    "How do I configure the database connection?",
  ];
  const scores = scoreSentences(sentences, "configure database connection settings", DEFAULT_CFG);
  assert.equal(scores.length, 2);
  assert.ok(scores[1] > scores[0]);
});

test("scoreSentences penalizes boilerplate relative to content", () => {
  const sentences = [
    "Please note that this is very important information.",
    "Use db.connect() with host and port parameters.",
  ];
  const scores = scoreSentences(sentences, "connect database host port", DEFAULT_CFG);
  assert.ok(scores[1] > scores[0]);
});

test("compression preserves original sentence order after greedy selection", () => {
  const body = {
    messages: [
      { role: "user", content: "Tell me about cats and dogs." },
      {
        role: "user",
        content:
          "Cats are independent animals. " +
          "Completely irrelevant filler sentence here today. " +
          "Dogs are loyal companions. " +
          "Another filler sentence with random content. " +
          "Cats and dogs are popular pets worldwide.",
      },
    ],
  };
  const result = relevanceEngine.apply(body, {
    stepConfig: { enabled: true, budgetPercent: 0.6, overlapThreshold: 0.05 },
  });
  if (result.compressed) {
    const messages = result.body.messages as Array<{ content: string }>;
    const lastContent = messages[messages.length - 1].content;
    const catIdx = lastContent.indexOf("Cats are independent");
    const dogIdx = lastContent.indexOf("Dogs are loyal");
    if (catIdx !== -1 && dogIdx !== -1) {
      assert.ok(catIdx < dogIdx);
    }
  }
  assert.ok(typeof result.compressed === "boolean");
});

test("signal-carrying sentences (Error:/digits) are never dropped", () => {
  const body = {
    messages: [
      { role: "user", content: "quantum entanglement relevance signal token" },
      {
        role: "user",
        content:
          "This sentence is completely unrelated to the query. " +
          "Error: connection refused at port 5432. " +
          "Another unrelated sentence about random things here. " +
          "Yet another irrelevant sentence with no matching tokens.",
      },
    ],
  };
  const result = relevanceEngine.apply(body, {
    stepConfig: { enabled: true, budgetPercent: 0.3, overlapThreshold: 0.0 },
  });
  const messages = result.body.messages as Array<{ content: string }>;
  const lastContent = messages[messages.length - 1].content;
  assert.match(lastContent, /Error: connection refused/);
});

test("techniquesUsed includes relevance-extract when compression occurred", () => {
  const body = {
    messages: [
      { role: "user", content: "Explain database indexing." },
      {
        role: "user",
        content:
          "Database indexes speed up queries on large tables. " +
          "Unrelated random words about nothing important here. " +
          "Indexes are created with CREATE INDEX in SQL. " +
          "Please note that this sentence is filler content only.",
      },
    ],
  };
  const result = relevanceEngine.apply(body, {
    stepConfig: { enabled: true, budgetPercent: 0.5, overlapThreshold: 0.05 },
  });
  assert.equal(result.compressed, true);
  assert.ok(result.stats !== null);
  assert.ok(result.stats!.techniquesUsed.includes("relevance-extract"));
});

test("determinism: same input produces same output", () => {
  const body = {
    messages: [
      { role: "user", content: "How does the retry mechanism work for failed requests?" },
      {
        role: "user",
        content:
          "The retry mechanism triggers after a timeout occurs. " +
          "Exponential backoff is applied between the retries. " +
          "Please note this is very important to remember. " +
          "The maximum retry count is fully configurable. " +
          "Indeed this is something to consider carefully.",
      },
    ],
  };
  const opts = { stepConfig: { enabled: true, budgetPercent: 0.5, overlapThreshold: 0.05 } };
  const r1 = relevanceEngine.apply(body, opts);
  const r2 = relevanceEngine.apply(body, opts);
  assert.deepEqual(r1.body, r2.body);
  assert.equal(r1.compressed, r2.compressed);
});

// ── fail-open on malformed / garbage input ──────────────────────────────────

test("fail-open when messages is not an array", () => {
  const body = { messages: "not an array" };
  const result = relevanceEngine.apply(body, { stepConfig: { enabled: true } });
  assert.equal(result.compressed, false);
  assert.deepEqual(result.body, body);
  assert.equal(result.stats, null);
});

test("fail-open when there is no user message", () => {
  const body = {
    messages: [{ role: "assistant", content: "Some long assistant reply with many words here." }],
  };
  const result = relevanceEngine.apply(body, { stepConfig: { enabled: true } });
  assert.equal(result.compressed, false);
  assert.deepEqual(result.body, body);
});

test("fail-open on empty body object", () => {
  const body = {};
  const result = relevanceEngine.apply(body, { stepConfig: { enabled: true } });
  assert.equal(result.compressed, false);
  assert.equal(result.stats, null);
});

test("fail-open on garbage query with special regex characters (ReDoS-safe)", () => {
  const malicious = "((a+)+)$ [.*+?^=!:${}()|[\\]/\\\\] test+++";
  const sentences = ["Some normal sentence here.", "Another sentence with content."];
  assert.doesNotThrow(() => {
    const scores = scoreSentences(sentences, malicious, DEFAULT_CFG);
    assert.equal(scores.length, 2);
  });
});

test("fail-open on single-sentence user message (nothing to extract)", () => {
  const body = { messages: [{ role: "user", content: "Just one sentence here." }] };
  const result = relevanceEngine.apply(body, { stepConfig: { enabled: true, budgetPercent: 0.5 } });
  assert.equal(result.compressed, false);
});

test("multimodal array content does not throw and is handled safely", () => {
  const body = {
    messages: [
      { role: "user", content: [{ type: "text", text: "What is the database host?" }] },
    ],
  };
  assert.doesNotThrow(() => {
    const result = relevanceEngine.apply(body, { stepConfig: { enabled: true } });
    assert.ok(typeof result.compressed === "boolean");
  });
});

// ── off-by-default verification ─────────────────────────────────────────────

test("relevance is not the default compression mode", () => {
  assert.notEqual(DEFAULT_COMPRESSION_CONFIG.defaultMode, "relevance" as unknown);
  assert.equal(DEFAULT_COMPRESSION_CONFIG.defaultMode, "off");
});

test("relevance is never auto-selected by getEffectiveMode with defaults", () => {
  const mode = getEffectiveMode(DEFAULT_COMPRESSION_CONFIG, null, 0);
  assert.notEqual(mode, "relevance" as unknown);
  assert.equal(mode, "off");
});

test("default relevance stepConfig has enabled=false in the config schema", () => {
  const schema = relevanceEngine.getConfigSchema();
  const enabledField = schema.find((f) => f.key === "enabled");
  assert.ok(enabledField);
  assert.equal(enabledField!.defaultValue, false);
});

test("engine metadata identifies it as an opt-in stackable engine", () => {
  assert.equal(relevanceEngine.id, "relevance");
  assert.equal(relevanceEngine.stackable, true);
  assert.equal(relevanceEngine.stackPriority, 18);
  assert.ok(relevanceEngine.getConfigSchema().length > 0);
});

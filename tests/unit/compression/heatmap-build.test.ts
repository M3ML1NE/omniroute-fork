import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCompressionPreviewDiff } from "../../../open-sse/services/compression/diffHelper.ts";

describe("buildCompressionPreviewDiff — saliency heatmap data-layer (#5285)", () => {
  it("returns no heatmap field when the mode flag is absent", () => {
    const result = buildCompressionPreviewDiff("hello world the", "hello world", null);
    assert.ok(!("heatmap" in result), "should not include heatmap when not requested");
  });

  it("ultra mode: per-token scores 0–1, stopword scores low, number/URL score 1.0", () => {
    const original = "the quick 42 https://example.com";
    const compressed = "quick 42 https://example.com";
    const result = buildCompressionPreviewDiff(original, compressed, null, {}, "ultra");

    assert.ok(result.heatmap, "heatmap should be present when mode is ultra");
    assert.equal(result.heatmap!.mode, "ultra");

    const tokens = result.heatmap!.tokens;
    assert.ok(tokens.length > 0, "tokens array should not be empty");
    for (const t of tokens) {
      assert.ok(t.score >= 0 && t.score <= 1, `score ${t.score} out of [0,1] for "${t.text}"`);
    }

    const theToken = tokens.find((t) => t.text.trim() === "the");
    assert.ok(theToken, 'should have a token for "the"');
    assert.ok(theToken!.score <= 0.2, `stopword "the" expected score ≤0.2, got ${theToken!.score}`);

    const numToken = tokens.find((t) => t.text.trim() === "42");
    assert.ok(numToken, 'should have a token for "42"');
    assert.equal(numToken!.score, 1.0);

    const urlToken = tokens.find((t) => t.text.includes("https://"));
    assert.ok(urlToken, "should have a URL token");
    assert.equal(urlToken!.score, 1.0);
  });

  it("ultra mode: kept flag reflects whether a token survived into compressed", () => {
    const result = buildCompressionPreviewDiff(
      "the quick brown fox",
      "quick brown fox",
      null,
      {},
      "ultra"
    );
    const tokens = result.heatmap!.tokens;

    const theToken = tokens.find((t) => t.text.trim() === "the");
    assert.ok(theToken);
    assert.equal(theToken!.kept, false, '"the" should not be kept');

    for (const word of ["quick", "brown", "fox"]) {
      const tok = tokens.find((t) => t.text.trim() === word);
      assert.ok(tok, `should have a token for "${word}"`);
      assert.equal(tok!.kept, true, `"${word}" should be kept`);
    }
  });

  it("universal mode: kept/removed and binary scores consistent with diff segments", () => {
    const result = buildCompressionPreviewDiff(
      "the quick brown fox",
      "quick brown fox",
      null,
      {},
      "universal"
    );
    assert.equal(result.heatmap!.mode, "universal");
    const tokens = result.heatmap!.tokens;

    const theToken = tokens.find((t) => t.text.trim() === "the");
    assert.ok(theToken);
    assert.equal(theToken!.kept, false);
    assert.equal(theToken!.score, 0);

    const quickToken = tokens.find((t) => t.text.trim() === "quick");
    assert.ok(quickToken);
    assert.equal(quickToken!.kept, true);
    assert.equal(quickToken!.score, 1);
  });

  it("universal mode: all tokens kept when compressed === original", () => {
    const result = buildCompressionPreviewDiff("hello world", "hello world", null, {}, "universal");
    for (const t of result.heatmap!.tokens) {
      assert.equal(t.kept, true, `token "${t.text}" should be kept`);
    }
  });
});

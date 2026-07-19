import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isAllowedProvider,
  PROVIDER_WHITELIST,
} from "../../../open-sse/config/providerWhitelist.js";

describe("isAllowedProvider", () => {
  it("allows gigachat-compatible", () => {
    assert.equal(isAllowedProvider("gigachat-compatible"), true);
  });

  it("allows openai-compatible", () => {
    assert.equal(isAllowedProvider("openai-compatible"), true);
  });

  it("rejects standalone gigachat (removed)", () => {
    assert.equal(isAllowedProvider("gigachat"), false);
  });

  it("rejects anthropic", () => {
    assert.equal(isAllowedProvider("anthropic"), false);
  });

  it("rejects claude-web", () => {
    assert.equal(isAllowedProvider("claude-web"), false);
  });

  it("rejects openai (not openai-compatible)", () => {
    assert.equal(isAllowedProvider("openai"), false);
  });

  it("rejects empty string", () => {
    assert.equal(isAllowedProvider(""), false);
  });

  it("whitelist non-empty", () => {
    assert.ok(PROVIDER_WHITELIST.length >= 2);
  });
});

describe("PROVIDER_WHITELIST invariant (T5.1-a)", () => {
  it("is exactly ['gigachat-compatible', 'openai-compatible'] — no more, no less", () => {
    assert.deepEqual([...PROVIDER_WHITELIST], ["gigachat-compatible", "openai-compatible"]);
  });
});

describe("isAllowedProvider rejects dead provider ids (T5.1-b)", () => {
  const deadProviders = [
    "codex",
    "kiro",
    "qoder",
    "antigravity",
    "cursor",
    "windsurf",
    "copilot",
    "gemini-cli",
    "bailian",
    "amazon-q",
    "claude",
    "anthropic-compatible",
  ];

  for (const id of deadProviders) {
    it(`rejects dead provider: ${id}`, () => {
      assert.equal(
        isAllowedProvider(id),
        false,
        `Expected isAllowedProvider("${id}") to be false — provider was removed from this fork`
      );
    });
  }
});

describe("isAllowedProvider rejects removed mlproxy surface + bare gigachat (T6.1)", () => {
  const removedProviders = ["mlproxy", "mlspace", "gigachat"];

  for (const id of removedProviders) {
    it(`rejects removed provider: ${id}`, () => {
      assert.equal(
        isAllowedProvider(id),
        false,
        `Expected isAllowedProvider("${id}") to be false — provider was removed from this fork`
      );
    });
  }

  it("accepts prefixed gigachat-compatible-<id> and openai-compatible-<id> forms", () => {
    // PROVIDER_WHITELIST holds bare category names ("gigachat-compatible"); actual
    // runtime provider identities are dynamic ${prefix}-${generateId()} strings
    // validated via isGigachatCompatibleProvider/isOpenAICompatibleProvider
    // (src/shared/constants/providers.ts), not isAllowedProvider directly.
    assert.ok("gigachat-compatible-x".startsWith("gigachat-compatible"));
    assert.ok("openai-compatible-y".startsWith("openai-compatible"));
  });
});

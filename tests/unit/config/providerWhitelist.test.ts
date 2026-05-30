import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isAllowedProvider,
  PROVIDER_WHITELIST,
} from "../../../open-sse/config/providerWhitelist.js";

describe("isAllowedProvider", () => {
  it("allows gigachat", () => {
    assert.equal(isAllowedProvider("gigachat"), true);
  });

  it("allows openai-compatible", () => {
    assert.equal(isAllowedProvider("openai-compatible"), true);
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

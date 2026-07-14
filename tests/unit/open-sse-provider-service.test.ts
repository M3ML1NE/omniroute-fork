import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isGigachatCompatible,
  getOpenAICompatibleType,
  detectFormatFromEndpoint,
  detectFormat,
  getProviderConfig,
  getProviderFallbackCount,
  buildProviderUrl,
  buildProviderHeaders,
  getTargetFormat,
  isLastMessageFromUser,
  hasThinkingConfig,
  normalizeThinkingConfig,
} from "../../open-sse/services/provider.ts";

describe("isGigachatCompatible", () => {
  it("returns true for a gigachat-compatible-* provider id", () => {
    assert.equal(isGigachatCompatible("gigachat-compatible-1"), true);
  });

  it("returns false for openai-compatible-* and non-string values", () => {
    assert.equal(isGigachatCompatible("openai-compatible-1"), false);
    assert.equal(isGigachatCompatible(null), false);
    assert.equal(isGigachatCompatible(undefined), false);
    assert.equal(isGigachatCompatible(42), false);
  });
});

describe("getOpenAICompatibleType", () => {
  it("returns 'chat' for a non-openai-compatible provider", () => {
    assert.equal(getOpenAICompatibleType("anthropic"), "chat");
  });

  it("respects an explicit apiType from providerSpecificData", () => {
    assert.equal(
      getOpenAICompatibleType("openai-compatible-1", { apiType: "responses" }),
      "responses"
    );
    assert.equal(
      getOpenAICompatibleType("openai-compatible-1", { apiType: "embeddings" }),
      "embeddings"
    );
  });

  it("ignores an unrecognized apiType value and falls through to name-based detection", () => {
    assert.equal(
      getOpenAICompatibleType("openai-compatible-embeddings-x", { apiType: "not-a-real-type" }),
      "embeddings"
    );
  });

  it("infers the type from the provider id when no providerSpecificData is given", () => {
    assert.equal(getOpenAICompatibleType("openai-compatible-responses-1"), "responses");
    assert.equal(getOpenAICompatibleType("openai-compatible-audio-transcriptions-1"), "audio-transcriptions");
    assert.equal(getOpenAICompatibleType("openai-compatible-audio-speech-1"), "audio-speech");
    assert.equal(getOpenAICompatibleType("openai-compatible-images-generations-1"), "images-generations");
  });

  it("defaults to 'chat' for a plain openai-compatible-* provider id", () => {
    assert.equal(getOpenAICompatibleType("openai-compatible-1"), "chat");
  });

  it("also recognizes gigachat-compatible-* provider ids", () => {
    assert.equal(getOpenAICompatibleType("gigachat-compatible-embeddings-1"), "embeddings");
  });
});

describe("detectFormatFromEndpoint", () => {
  it("detects openai-responses from a /responses path", () => {
    assert.equal(detectFormatFromEndpoint({}, "/v1/responses"), "openai-responses");
    assert.equal(detectFormatFromEndpoint({}, "responses"), "openai-responses");
  });

  it("detects claude from a /messages path", () => {
    assert.equal(detectFormatFromEndpoint({}, "/v1/messages"), "claude");
  });

  it("detects openai from a /chat/completions path", () => {
    assert.equal(detectFormatFromEndpoint({}, "/v1/chat/completions"), "openai");
    assert.equal(detectFormatFromEndpoint({}, "/v1/completions"), "openai");
  });

  it("falls back to body-based detectFormat when the path doesn't match a known route", () => {
    const result = detectFormatFromEndpoint({ contents: [] }, "/some/other/path");
    assert.equal(result, "gemini");
  });
});

describe("detectFormat", () => {
  it("detects openai-responses when the body has an 'input' field", () => {
    assert.equal(detectFormat({ input: "hello" }), "openai-responses");
  });

  it("detects openai-responses via responses-specific fields even without 'input'", () => {
    assert.equal(detectFormat({ max_output_tokens: 100 }), "openai-responses");
    assert.equal(detectFormat({ previous_response_id: "resp_1" }), "openai-responses");
  });

  it("detects antigravity from a wrapped gemini request with userAgent marker", () => {
    assert.equal(
      detectFormat({ request: { contents: [] }, userAgent: "antigravity" }),
      "antigravity"
    );
  });

  it("detects gemini from a top-level contents array", () => {
    assert.equal(detectFormat({ contents: [] }), "gemini");
  });

  it("detects openai from OpenAI-specific indicator fields", () => {
    assert.equal(detectFormat({ stream_options: {} }), "openai");
    assert.equal(detectFormat({ response_format: { type: "json_object" } }), "openai");
    assert.equal(detectFormat({ logprobs: true }), "openai");
    assert.equal(detectFormat({ n: 2 }), "openai");
  });

  it("detects claude from explicit anthropic markers alongside a messages array", () => {
    assert.equal(detectFormat({ messages: [{ role: "user", content: "hi" }], system: "sys" }), "claude");
    assert.equal(
      detectFormat({ messages: [{ role: "user", content: "hi" }], anthropic_version: "2023-06-01" }),
      "claude"
    );
  });

  it("detects claude from Claude-shaped image content blocks", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "image", source: { type: "base64", data: "..." } },
          ],
        },
      ],
    };
    assert.equal(detectFormat(body), "claude");
  });

  it("detects openai from OpenAI-shaped image_url content blocks", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "image_url", image_url: { url: "https://example.com/x.png" } },
          ],
        },
      ],
    };
    assert.equal(detectFormat(body), "openai");
  });

  it("detects claude from tool_use/tool_result content blocks", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "tool_use", id: "1", name: "x", input: {} },
          ],
        },
      ],
    };
    assert.equal(detectFormat(body), "claude");
  });

  it("uses the max_tokens heuristic to detect claude for a plain string-content message", () => {
    const body = { messages: [{ role: "user", content: "hi" }], max_tokens: 100 };
    assert.equal(detectFormat(body), "claude");
  });

  it("defaults to openai when nothing else matches", () => {
    assert.equal(detectFormat({ messages: [{ role: "user", content: "hi" }] }), "openai");
    assert.equal(detectFormat({}), "openai");
  });
});

describe("getProviderConfig", () => {
  it("returns an openai-responses format config for a responses-type openai-compatible provider", () => {
    const config = getProviderConfig("openai-compatible-responses-1");
    assert.equal(config.format, "openai-responses");
  });

  it("returns an openai format config for a plain openai-compatible provider", () => {
    const config = getProviderConfig("openai-compatible-1");
    assert.equal(config.format, "openai");
    assert.equal(config.baseUrl, "https://api.openai.com/v1");
  });

  it("falls back to the openai-compatible default config for an unknown provider (this fork's PROVIDERS is empty)", () => {
    const config = getProviderConfig("some-unregistered-provider");
    assert.equal(config.format, "openai");
  });
});

describe("getProviderFallbackCount", () => {
  it("returns 1 when the resolved config has no baseUrls array", () => {
    assert.equal(getProviderFallbackCount("openai-compatible-1"), 1);
  });
});

describe("buildProviderUrl", () => {
  it("builds a /chat/completions URL for a plain openai-compatible provider with an explicit baseUrl", () => {
    const url = buildProviderUrl("openai-compatible-1", "gpt-4o", true, {
      baseUrl: "https://my-proxy.example.com/v1",
    });
    assert.equal(url, "https://my-proxy.example.com/v1/chat/completions");
  });

  it("strips a trailing slash from the base URL before appending the path", () => {
    const url = buildProviderUrl("openai-compatible-1", "gpt-4o", true, {
      baseUrl: "https://my-proxy.example.com/v1/",
    });
    assert.equal(url, "https://my-proxy.example.com/v1/chat/completions");
  });

  it("uses providerSpecificData.baseUrl when no explicit baseUrl option is given", () => {
    const url = buildProviderUrl("openai-compatible-1", "gpt-4o", true, {
      providerSpecificData: { baseUrl: "https://psd-proxy.example.com/v1" },
    });
    assert.equal(url, "https://psd-proxy.example.com/v1/chat/completions");
  });

  it("falls back to the OpenAI default base URL when nothing else is configured", () => {
    const url = buildProviderUrl("openai-compatible-1", "gpt-4o", true, {});
    assert.equal(url, "https://api.openai.com/v1/chat/completions");
  });

  it("builds an /embeddings URL for an embeddings-typed provider", () => {
    const url = buildProviderUrl("openai-compatible-embeddings-1", "text-embedding-3", true, {
      baseUrl: "https://embeds.example.com/v1",
    });
    assert.equal(url, "https://embeds.example.com/v1/embeddings");
  });

  it("falls back to the resolved config's baseUrl for a non-openai-compatible provider (empty registry in this fork)", () => {
    const url = buildProviderUrl("some-unregistered-provider", "model-x");
    assert.equal(url, "https://api.openai.com/v1");
  });
});

describe("buildProviderHeaders", () => {
  it("builds bearer auth headers from apiKey when the provider has no registry entry (this fork's registry is empty)", () => {
    const headers = buildProviderHeaders("openai-compatible-1", { apiKey: "sk-test" }, true);
    assert.equal(headers["Authorization"], "Bearer sk-test");
    assert.equal(headers["Content-Type"], "application/json");
    assert.equal(headers["Accept"], "text/event-stream");
  });

  it("prefers apiKey over accessToken for bearer auth", () => {
    const headers = buildProviderHeaders(
      "openai-compatible-1",
      { apiKey: "sk-key", accessToken: "at-token" },
      false
    );
    assert.equal(headers["Authorization"], "Bearer sk-key");
  });

  it("falls back to accessToken when apiKey is absent", () => {
    const headers = buildProviderHeaders("openai-compatible-1", { accessToken: "at-token" }, false);
    assert.equal(headers["Authorization"], "Bearer at-token");
  });

  it("omits the Accept: text/event-stream header when stream is false", () => {
    const headers = buildProviderHeaders("openai-compatible-1", { apiKey: "sk-test" }, false);
    assert.equal("Accept" in headers, false);
  });
});

describe("getTargetFormat", () => {
  it("returns openai-responses for a responses-typed openai-compatible provider", () => {
    assert.equal(getTargetFormat("openai-compatible-responses-1"), "openai-responses");
  });

  it("returns openai for a plain openai-compatible provider", () => {
    assert.equal(getTargetFormat("openai-compatible-1"), "openai");
  });

  it("falls back to the resolved config's format for an unregistered provider", () => {
    assert.equal(getTargetFormat("some-unregistered-provider"), "openai");
  });
});

describe("isLastMessageFromUser", () => {
  it("returns true when messages is empty or absent (no evidence otherwise)", () => {
    assert.equal(isLastMessageFromUser({}), true);
    assert.equal(isLastMessageFromUser({ messages: [] }), true);
  });

  it("returns true when the last message has role 'user'", () => {
    assert.equal(
      isLastMessageFromUser({ messages: [{ role: "assistant" }, { role: "user" }] }),
      true
    );
  });

  it("returns false when the last message is not from the user", () => {
    assert.equal(
      isLastMessageFromUser({ messages: [{ role: "user" }, { role: "assistant" }] }),
      false
    );
  });

  it("checks body.contents when body.messages is absent (Gemini shape)", () => {
    assert.equal(isLastMessageFromUser({ contents: [{ role: "user" }] }), true);
    assert.equal(isLastMessageFromUser({ contents: [{ role: "model" }] }), false);
  });
});

describe("hasThinkingConfig", () => {
  it("detects OpenAI-style reasoning_effort", () => {
    assert.equal(hasThinkingConfig({ reasoning_effort: "high" }), true);
  });

  it("detects Claude/Gemini-style thinking.type === 'enabled'", () => {
    assert.equal(hasThinkingConfig({ thinking: { type: "enabled" } }), true);
  });

  it("returns false when neither field is present", () => {
    assert.equal(hasThinkingConfig({}), false);
    assert.equal(hasThinkingConfig({ thinking: { type: "disabled" } }), false);
  });
});

describe("normalizeThinkingConfig", () => {
  it("strips thinking config when the last message is not from the user", () => {
    const body = {
      messages: [{ role: "user" }, { role: "assistant" }],
      thinking: { type: "enabled" },
    };
    const result = normalizeThinkingConfig(body);
    assert.equal("thinking" in result, false);
  });

  it("preserves thinking config when the last message is from the user", () => {
    const body = {
      messages: [{ role: "assistant" }, { role: "user" }],
      thinking: { type: "enabled" },
    };
    const result = normalizeThinkingConfig(body);
    assert.deepEqual(result.thinking, { type: "enabled" });
  });

  it("returns the same body object it was given (mutates in place)", () => {
    const body = { messages: [{ role: "assistant" }], thinking: { type: "enabled" } };
    const result = normalizeThinkingConfig(body);
    assert.equal(result, body);
  });
});

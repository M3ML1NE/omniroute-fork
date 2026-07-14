import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleBypassRequest } from "../../open-sse/utils/bypassHandler.ts";

const CLAUDE_CLI_UA = "claude-cli/1.0.0";

describe("handleBypassRequest", () => {
  it("returns null for non-claude-cli user agents", () => {
    const body = { messages: [{ role: "user", content: "count" }] };
    assert.equal(handleBypassRequest(body, "gpt-4", "some-other-agent"), null);
  });

  it("returns null for an empty/default user agent", () => {
    const body = { messages: [{ role: "user", content: "count" }] };
    assert.equal(handleBypassRequest(body, "gpt-4"), null);
  });

  it("returns null when the body has no messages", () => {
    assert.equal(handleBypassRequest({}, "gpt-4", CLAUDE_CLI_UA), null);
    assert.equal(handleBypassRequest({ messages: [] }, "gpt-4", CLAUDE_CLI_UA), null);
  });

  it("returns null when no bypass pattern matches", () => {
    const body = { messages: [{ role: "user", content: "tell me about the weather" }] };
    assert.equal(handleBypassRequest(body, "gpt-4", CLAUDE_CLI_UA), null);
  });

  it("bypasses on the title-extraction pattern (assistant message = '{')", () => {
    const body = {
      messages: [
        { role: "user", content: "summarize this" },
        { role: "assistant", content: [{ type: "text", text: "{" }] },
      ],
      stream: false,
    };
    const result = handleBypassRequest(body, "gpt-4", CLAUDE_CLI_UA);
    assert.ok(result);
    assert.equal(result.success, true);
  });

  it("bypasses on the Warmup pattern", () => {
    const body = { messages: [{ role: "user", content: "Warmup" }], stream: false };
    const result = handleBypassRequest(body, "gpt-4", CLAUDE_CLI_UA);
    assert.ok(result);
    assert.equal(result.success, true);
  });

  it("bypasses on the exact single 'count' message pattern", () => {
    const body = { messages: [{ role: "user", content: "count" }], stream: false };
    const result = handleBypassRequest(body, "gpt-4", CLAUDE_CLI_UA);
    assert.ok(result);
  });

  it("does not bypass 'count' when there are multiple messages", () => {
    const body = {
      messages: [
        { role: "user", content: "hi" },
        { role: "user", content: "count" },
      ],
    };
    assert.equal(handleBypassRequest(body, "gpt-4", CLAUDE_CLI_UA), null);
  });

  it("bypasses when a user message matches a configured skip pattern", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: "Please write a 5-10 word title for the following conversation:",
        },
      ],
      stream: false,
    };
    const result = handleBypassRequest(body, "gpt-4", CLAUDE_CLI_UA);
    assert.ok(result);
  });

  it("extracts text from array-style message content for pattern matching", () => {
    const body = {
      messages: [{ role: "user", content: [{ type: "text", text: "Warmup" }] }],
      stream: false,
    };
    const result = handleBypassRequest(body, "gpt-4", CLAUDE_CLI_UA);
    assert.ok(result);
  });

  it("returns a streaming SSE response by default", async () => {
    const body = { messages: [{ role: "user", content: "count" }] };
    const result = handleBypassRequest(body, "gpt-4", CLAUDE_CLI_UA);
    assert.ok(result);
    assert.equal(result.response.headers.get("Content-Type"), "text/event-stream");
    const text = await result.response.text();
    assert.match(text, /data: \[DONE\]/);
  });

  it("returns a non-streaming JSON response when stream is explicitly false", async () => {
    const body = { messages: [{ role: "user", content: "count" }], stream: false };
    const result = handleBypassRequest(body, "gpt-4", CLAUDE_CLI_UA);
    assert.ok(result);
    assert.equal(result.response.headers.get("Content-Type"), "application/json");
    const json = await result.response.json();
    assert.equal(json.object, "chat.completion");
    assert.equal(json.model, "gpt-4");
    assert.equal(json.choices[0].message.role, "assistant");
    assert.ok(json.choices[0].message.content.length > 0);
  });

  it("propagates the requested model id into the response body", async () => {
    const body = { messages: [{ role: "user", content: "count" }], stream: false };
    const result = handleBypassRequest(body, "claude-3-opus", CLAUDE_CLI_UA);
    const json = await result.response.json();
    assert.equal(json.model, "claude-3-opus");
  });
});

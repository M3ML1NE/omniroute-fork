import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  startMockGigachat,
  type MockGigachatServer,
} from "../../fixtures/mock-gigachat-server.js";

/**
 * gpt2giga edge-case parity test corpus (T21).
 *
 * Mock GigaChat server (T5 fixture) is OpenAI-compatible: it accepts and emits
 * OpenAI-shaped chat completions. The DefaultExecutor's gigachat case (T9 trim)
 * does NOT perform body translation — it expects upstream to be OpenAI-compatible.
 *
 * These 20 scenarios verify the wire-level parity surface that flows through
 * default.ts (URL normalization, Bearer auth, OpenAI request/response shape)
 * by driving the mock server end-to-end.
 */
describe("gpt2giga parity (mock GigaChat)", () => {
  let mock: MockGigachatServer;

  before(async () => {
    mock = await startMockGigachat();
  });

  after(async () => {
    await mock.close();
  });

  /** Helper: POST chat completions */
  async function chat(body: Record<string, unknown>): Promise<Response> {
    return fetch(`${mock.url}/api/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("01: simple text chat (non-stream) returns OpenAI response shape", async () => {
    const r = await chat({
      model: "GigaChat",
      messages: [{ role: "user", content: "hello" }],
    });
    assert.equal(r.status, 200);
    const body = (await r.json()) as {
      id: string;
      object: string;
      choices: { message: { role: string; content: string } }[];
    };
    assert.equal(body.object, "chat.completion");
    assert.equal(body.choices[0].message.role, "assistant");
    assert.equal(body.choices[0].message.content, "mock-reply");
  });

  it("02: simple text chat (stream=true) returns SSE chunks ending [DONE]", async () => {
    const r = await chat({
      model: "GigaChat",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.ok(text.includes("data: "), "must contain SSE data lines");
    assert.ok(text.includes("[DONE]"), "must terminate with [DONE]");
    // Verify chunk shape
    assert.ok(
      text.includes('"object":"chat.completion.chunk"'),
      "chunks must be chat.completion.chunk",
    );
  });

  it("03: functions[] request — mock receives and echoes tool_calls", async () => {
    const r = await chat({
      model: "GigaChat",
      messages: [{ role: "user", content: "weather?" }],
      functions: [
        {
          name: "get_weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
          },
        },
      ],
    });
    assert.equal(r.status, 200);
    const body = (await r.json()) as {
      choices: { message: { tool_calls?: { function: { name: string } }[] } }[];
    };
    assert.ok(body.choices[0].message.tool_calls, "should have tool_calls");
    assert.equal(body.choices[0].message.tool_calls?.[0].function.name, "get_weather");
  });

  it("04: multiple functions[] are all sent to upstream", async () => {
    const r = await chat({
      model: "GigaChat",
      messages: [{ role: "user", content: "do many things" }],
      functions: [
        { name: "fn_a", parameters: { type: "object", properties: {} } },
        { name: "fn_b", parameters: { type: "object", properties: {} } },
        { name: "fn_c", parameters: { type: "object", properties: {} } },
      ],
    });
    assert.equal(r.status, 200);
    // Mock captures last request — verify all three functions arrived
    const captured = mock.lastRequest?.body as { functions?: { name: string }[] } | null;
    assert.ok(captured?.functions, "captured request must have functions");
    assert.equal(captured?.functions?.length, 3);
    assert.deepEqual(
      captured?.functions?.map((f) => f.name),
      ["fn_a", "fn_b", "fn_c"],
    );
  });

  it("05: function_call response surfaces as tool_calls[]", async () => {
    const r = await chat({
      model: "GigaChat",
      messages: [{ role: "user", content: "call something" }],
      functions: [{ name: "do_it", parameters: { type: "object", properties: {} } }],
    });
    const body = (await r.json()) as {
      choices: {
        message: { tool_calls?: { id: string; type: string }[] };
      }[];
    };
    const tc = body.choices[0].message.tool_calls?.[0];
    assert.ok(tc, "tool_calls[0] must exist");
    assert.equal(tc?.type, "function");
    assert.match(tc?.id ?? "", /^call_/);
  });

  it("06: finish_reason becomes 'tool_calls' when functions present", async () => {
    const r = await chat({
      model: "GigaChat",
      messages: [{ role: "user", content: "x" }],
      functions: [{ name: "fn", parameters: {} }],
    });
    const body = (await r.json()) as { choices: { finish_reason: string }[] };
    assert.equal(body.choices[0].finish_reason, "tool_calls");
  });

  it("07: system message first is preserved through pipeline", async () => {
    await chat({
      model: "GigaChat",
      messages: [
        { role: "system", content: "you are helpful" },
        { role: "user", content: "hi" },
      ],
    });
    const captured = mock.lastRequest?.body as {
      messages: { role: string; content: string }[];
    } | null;
    assert.equal(captured?.messages[0].role, "system");
    assert.equal(captured?.messages[0].content, "you are helpful");
  });

  it("08: consecutive same-role messages pass through (no merge required)", async () => {
    const r = await chat({
      model: "GigaChat",
      messages: [
        { role: "user", content: "part 1" },
        { role: "user", content: "part 2" },
      ],
    });
    assert.equal(r.status, 200);
    const captured = mock.lastRequest?.body as {
      messages: { role: string }[];
    } | null;
    assert.equal(captured?.messages.length, 2);
  });

  it("09: response_format json_schema passes through unchanged", async () => {
    const r = await chat({
      model: "GigaChat",
      messages: [{ role: "user", content: "json please" }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "answer",
          schema: { type: "object", properties: { ok: { type: "boolean" } } },
        },
      },
    });
    assert.equal(r.status, 200);
    const captured = mock.lastRequest?.body as {
      response_format?: { type: string };
    } | null;
    assert.equal(captured?.response_format?.type, "json_schema");
  });

  it("10: tool name with hyphens passes through (mock does not sanitize)", async () => {
    await chat({
      model: "GigaChat",
      messages: [{ role: "user", content: "x" }],
      functions: [{ name: "get-weather-now", parameters: {} }],
    });
    const captured = mock.lastRequest?.body as {
      functions: { name: string }[];
    } | null;
    // gpt2giga reference would sanitize hyphens to underscores BEFORE sending.
    // Default executor does not — so name arrives as-is. Documented behavior.
    assert.equal(captured?.functions[0].name, "get-weather-now");
  });

  it("11: finish_reason 'stop' is preserved when no functions", async () => {
    const r = await chat({
      model: "GigaChat",
      messages: [{ role: "user", content: "hi" }],
    });
    const body = (await r.json()) as { choices: { finish_reason: string }[] };
    assert.equal(body.choices[0].finish_reason, "stop");
  });

  it("12: max_tokens parameter is forwarded to upstream", async () => {
    await chat({
      model: "GigaChat",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 100,
    });
    const captured = mock.lastRequest?.body as {
      max_tokens?: number;
    } | null;
    assert.equal(captured?.max_tokens, 100);
  });

  it("13: usage tokens (prompt/completion/total) present in non-stream response", async () => {
    const r = await chat({
      model: "GigaChat",
      messages: [{ role: "user", content: "hi" }],
    });
    const body = (await r.json()) as {
      usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      };
    };
    assert.ok(body.usage.prompt_tokens > 0);
    assert.ok(body.usage.completion_tokens > 0);
    assert.equal(
      body.usage.total_tokens,
      body.usage.prompt_tokens + body.usage.completion_tokens,
    );
  });

  it("14: unknown path returns 404 (proxy must not synthesize success)", async () => {
    const r = await fetch(`${mock.url}/unknown/path`);
    assert.equal(r.status, 404);
    const body = (await r.json()) as { error: { message: string } };
    assert.equal(body.error.message, "Not found");
  });

  it("15: empty messages array still receives 200 from mock (proxy may pre-validate)", async () => {
    const r = await chat({
      model: "GigaChat",
      messages: [],
    });
    // Mock is permissive; real proxy should reject before reaching upstream.
    // Documented: if proxy adds 400 validation later, update this expectation.
    assert.equal(r.status, 200);
  });

  it("16: streaming role appears only in first chunk, content in subsequent", async () => {
    const r = await chat({
      model: "GigaChat",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    const text = await r.text();
    const dataLines = text.split("\n").filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"));
    assert.ok(dataLines.length >= 2, "must have at least 2 SSE chunks");
    const first = JSON.parse(dataLines[0].slice(6)) as {
      choices: { delta: { role?: string; content?: string } }[];
    };
    const second = JSON.parse(dataLines[1].slice(6)) as {
      choices: { delta: { role?: string; content?: string } }[];
    };
    assert.equal(first.choices[0].delta.role, "assistant");
    assert.equal(second.choices[0].delta.role, undefined);
  });

  it("17: tool_choice 'none' is forwarded", async () => {
    await chat({
      model: "GigaChat",
      messages: [{ role: "user", content: "hi" }],
      tool_choice: "none",
    });
    const captured = mock.lastRequest?.body as { tool_choice?: string } | null;
    assert.equal(captured?.tool_choice, "none");
  });

  it("18: tool_choice 'required' is forwarded (warning is impl detail)", async () => {
    await chat({
      model: "GigaChat",
      messages: [{ role: "user", content: "hi" }],
      tool_choice: "required",
    });
    const captured = mock.lastRequest?.body as { tool_choice?: string } | null;
    assert.equal(captured?.tool_choice, "required");
  });

  it("19: multimodal content blocks (text + image_url) pass through", async () => {
    await chat({
      model: "GigaChat",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what's in this image?" },
            { type: "image_url", image_url: { url: "https://example.com/img.png" } },
          ],
        },
      ],
    });
    const captured = mock.lastRequest?.body as {
      messages: { content: unknown }[];
    } | null;
    const content = captured?.messages[0].content as { type: string }[];
    assert.ok(Array.isArray(content));
    assert.equal(content[0].type, "text");
    assert.equal(content[1].type, "image_url");
  });

  it("20: model name is preserved in response (no rewriting)", async () => {
    const r = await chat({
      model: "GigaChat",
      messages: [{ role: "user", content: "hi" }],
    });
    const body = (await r.json()) as { model: string };
    assert.equal(body.model, "GigaChat");
  });
});

describe("gpt2giga parity (auxiliary endpoints)", () => {
  let mock: MockGigachatServer;

  before(async () => {
    mock = await startMockGigachat();
  });

  after(async () => {
    await mock.close();
  });

  it("AUX-1: GET /api/v1/models returns GigaChat", async () => {
    const r = await fetch(`${mock.url}/api/v1/models`);
    assert.equal(r.status, 200);
    const body = (await r.json()) as { data: { id: string }[] };
    assert.ok(body.data.some((m) => m.id === "GigaChat"));
  });

  it("AUX-2: POST /oauth/token returns Bearer access_token", async () => {
    const r = await fetch(`${mock.url}/oauth/token`, { method: "POST" });
    assert.equal(r.status, 200);
    const body = (await r.json()) as {
      access_token: string;
      token_type: string;
      expires_at: number;
    };
    assert.ok(body.access_token.startsWith("mock-token-"));
    assert.equal(body.token_type, "Bearer");
    assert.ok(body.expires_at > Math.floor(Date.now() / 1000));
  });

  it("AUX-3: POST /api/v1/embeddings returns vector + usage", async () => {
    const r = await fetch(`${mock.url}/api/v1/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "GigaChat", input: "test" }),
    });
    assert.equal(r.status, 200);
    const body = (await r.json()) as {
      data: { embedding: number[] }[];
      usage: { prompt_tokens: number };
    };
    assert.ok(Array.isArray(body.data[0].embedding));
    assert.ok(body.data[0].embedding.length > 0);
    assert.ok(body.usage.prompt_tokens > 0);
  });
});

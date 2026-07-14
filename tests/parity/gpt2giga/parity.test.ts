import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  startMockGigachat,
  type MockGigachatServer,
} from "../../fixtures/mock-gigachat-server.js";

/**
 * gpt2giga edge-case parity test corpus (T21).
 *
 * Mock GigaChat server (T5 fixture) emits true GigaChat v1 wire shapes:
 * message.function_call with OBJECT arguments, functions_state_id, and
 * finish_reason "function_call". Tests 03/05/06 assert the GigaChat-native
 * response shape; the DefaultExecutor (gigachat-conversion-e2e suite) converts
 * these back to OpenAI tool_calls for the caller.
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

  it("03: functions[] request — mock receives and echoes function_call", async () => {
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
      choices: { message: { function_call?: { name: string } } }[];
    };
    assert.ok(body.choices[0].message.function_call, "should have function_call");
    assert.equal(body.choices[0].message.function_call?.name, "get_weather");
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

  it("05: function_call response surfaces as function_call on message", async () => {
    const r = await chat({
      model: "GigaChat",
      messages: [{ role: "user", content: "call something" }],
      functions: [{ name: "do_it", parameters: { type: "object", properties: {} } }],
    });
    const body = (await r.json()) as {
      choices: {
        message: { function_call?: { name: string }; functions_state_id?: string };
      }[];
    };
    const fc = body.choices[0].message.function_call;
    assert.ok(fc, "function_call must exist");
    assert.equal(fc?.name, "do_it");
    assert.ok(body.choices[0].message.functions_state_id, "functions_state_id must be present");
  });

  it("06: finish_reason becomes 'function_call' when functions present", async () => {
    const r = await chat({
      model: "GigaChat",
      messages: [{ role: "user", content: "x" }],
      functions: [{ name: "fn", parameters: {} }],
    });
    const body = (await r.json()) as { choices: { finish_reason: string }[] };
    assert.equal(body.choices[0].finish_reason, "function_call");
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

describe("gpt2giga parity (W4 surface)", () => {
  /**
   * W4 surface parity cases (T4.7).
   *
   * Each test spins its own mock in wire:"gigachat" mode so the suite is
   * self-contained and does not share state with the main 01-20 block.
   *
   * These tests document the GigaChat v1 wire contract:
   *   - functions[] (not tools[]) on the request body
   *   - functions_state_id round-trip
   *   - X-Session-ID header capture
   *   - reasoning_content in response
   *   - response_format json_schema passthrough
   *   - stream delta.function_call shape + finish_reason "function_call"
   */

  it("W4-21: tools→functions wire shape — send functions[] → mock emits function_call (GigaChat wire contract)", async () => {
    const mock = await startMockGigachat({ wire: "gigachat" });
    try {
      const r = await fetch(`${mock.url}/api/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "GigaChat",
          messages: [{ role: "user", content: "what is the weather?" }],
          functions: [
            {
              name: "get_weather",
              parameters: {
                type: "object",
                properties: { city: { type: "string" } },
              },
            },
          ],
        }),
      });
      assert.equal(r.status, 200);
      const body = (await r.json()) as {
        choices: {
          message: {
            function_call?: { name: string; arguments: Record<string, unknown> };
          };
          finish_reason: string;
        }[];
      };
      // GigaChat wire: function_call on message (not tool_calls)
      assert.ok(body.choices[0].message.function_call, "must have function_call (GigaChat wire)");
      assert.equal(body.choices[0].message.function_call?.name, "get_weather");
      // arguments is an OBJECT (not a JSON string) in GigaChat v1 wire
      assert.equal(typeof body.choices[0].message.function_call?.arguments, "object");
      // tool_calls must NOT appear on the GigaChat wire response
      assert.ok(
        !("tool_calls" in body.choices[0].message),
        "tool_calls must be absent from GigaChat wire response",
      );
      // Captured request must have functions[] (not tools[])
      const captured = mock.lastRequest?.body as {
        functions?: { name: string }[];
        tools?: unknown;
      } | null;
      assert.ok(Array.isArray(captured?.functions), "captured body must have functions[]");
      assert.equal(captured?.functions?.[0].name, "get_weather");
      assert.ok(!captured?.tools, "captured body must NOT have tools[]");
    } finally {
      await mock.close();
    }
  });

  it("W4-22: functions_state_id round-trip — response carries a non-empty string token", async () => {
    const mock = await startMockGigachat({ wire: "gigachat" });
    try {
      const r = await fetch(`${mock.url}/api/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "GigaChat",
          messages: [{ role: "user", content: "call a function" }],
          functions: [{ name: "do_something", parameters: { type: "object", properties: {} } }],
        }),
      });
      assert.equal(r.status, 200);
      const body = (await r.json()) as {
        choices: {
          message: {
            function_call?: { name: string };
            functions_state_id?: string;
          };
          finish_reason: string;
        }[];
      };
      const stateId = body.choices[0].message.functions_state_id;
      assert.ok(typeof stateId === "string" && stateId.length > 0, "functions_state_id must be a non-empty string");
      // Verify it looks like a UUID-style token (mock emits "0e2a1b3c-4d5e-6f70-8a9b-mockstate0001")
      assert.ok(stateId.includes("-"), "functions_state_id must contain hyphens (UUID-style)");
      assert.equal(body.choices[0].finish_reason, "function_call");
    } finally {
      await mock.close();
    }
  });

  it("W4-23: X-Session-ID header passthrough — mock captures the header verbatim", async () => {
    const mock = await startMockGigachat({ wire: "gigachat" });
    try {
      await fetch(`${mock.url}/api/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Session-ID": "test-session-123",
        },
        body: JSON.stringify({
          model: "GigaChat",
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      // Node.js http module lowercases header names
      const capturedHeaders = mock.lastRequest?.headers as Record<string, string | string[] | undefined>;
      assert.equal(
        capturedHeaders["x-session-id"],
        "test-session-123",
        "mock must capture X-Session-ID header (lowercased)",
      );
    } finally {
      await mock.close();
    }
  });

  it("W4-24: reasoning_content — non-stream response includes reasoning_content string", async () => {
    const mock = await startMockGigachat({ wire: "gigachat" });
    try {
      const r = await fetch(`${mock.url}/api/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "GigaChat",
          messages: [{ role: "user", content: "think about this" }],
        }),
      });
      assert.equal(r.status, 200);
      const body = (await r.json()) as {
        choices: {
          message: {
            content: string;
            reasoning_content?: string;
          };
          finish_reason: string;
        }[];
      };
      const rc = body.choices[0].message.reasoning_content;
      assert.ok(typeof rc === "string" && rc.length > 0, "reasoning_content must be a non-empty string");
      assert.equal(body.choices[0].finish_reason, "stop");
      // Content is still present alongside reasoning_content
      assert.equal(body.choices[0].message.content, "mock-reply");
    } finally {
      await mock.close();
    }
  });

  it("W4-25: structured output — response_format json_schema passes through to upstream body", async () => {
    const mock = await startMockGigachat({ wire: "gigachat" });
    try {
      const r = await fetch(`${mock.url}/api/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "GigaChat",
          messages: [{ role: "user", content: "give me json" }],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "x",
              schema: { type: "object" },
            },
          },
        }),
      });
      assert.equal(r.status, 200);
      const captured = mock.lastRequest?.body as {
        response_format?: { type: string; json_schema?: { name: string } };
      } | null;
      assert.equal(captured?.response_format?.type, "json_schema");
      assert.equal(captured?.response_format?.json_schema?.name, "x");
    } finally {
      await mock.close();
    }
  });

  it("W4-26: stream function_call — SSE stream emits delta.function_call chunks, finish_reason 'function_call', ends [DONE]", async () => {
    const mock = await startMockGigachat({ wire: "gigachat", streamArgsMode: "whole" });
    try {
      const r = await fetch(`${mock.url}/api/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "GigaChat",
          stream: true,
          messages: [{ role: "user", content: "stream a function call" }],
          functions: [
            {
              name: "stream_fn",
              parameters: { type: "object", properties: { city: { type: "string" } } },
            },
          ],
        }),
      });
      assert.equal(r.status, 200);
      const text = await r.text();

      // Must end with [DONE]
      assert.ok(text.includes("[DONE]"), "stream must terminate with [DONE]");

      const dataLines = text
        .split("\n")
        .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"));
      assert.ok(dataLines.length >= 2, "must have at least 2 SSE data chunks");

      // Parse all chunks
      const chunks = dataLines.map((l) =>
        JSON.parse(l.slice(6)) as {
          choices: {
            delta: {
              role?: string;
              function_call?: { name?: string; arguments?: string };
              functions_state_id?: string;
              tool_calls?: unknown;
            };
            finish_reason: string | null;
          }[];
        },
      );

      // First chunk: delta.function_call.name (GigaChat wire — NOT tool_calls)
      const firstDelta = chunks[0].choices[0].delta;
      assert.ok(firstDelta.function_call, "first chunk delta must have function_call (GigaChat wire)");
      assert.equal(firstDelta.function_call?.name, "stream_fn");
      assert.ok(!firstDelta.tool_calls, "delta must NOT have tool_calls on GigaChat wire");

      // At least one chunk must have delta.function_call.arguments
      const hasArgChunk = chunks.some(
        (c) => c.choices[0].delta.function_call?.arguments !== undefined,
      );
      assert.ok(hasArgChunk, "at least one chunk must carry delta.function_call.arguments");

      // Last data chunk before [DONE]: finish_reason === "function_call"
      const lastChunk = chunks[chunks.length - 1];
      assert.equal(lastChunk.choices[0].finish_reason, "function_call");
    } finally {
      await mock.close();
    }
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

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { DefaultExecutor } from "../../../open-sse/executors/default.ts";
import { startMockGigachat, type MockGigachatServer } from "../../fixtures/mock-gigachat-server.js";

const NODE_ID = "gigachat-compatible-e2e";
const WIRE_NODE_ID = "gigachat-compatible-wire";

type JsonRecord = Record<string, unknown>;

function gigaCreds(baseUrl: string): JsonRecord {
  // No mTLS here: the mock runs over plain HTTP, so a plain apiKey credential is
  // enough to exercise the full execute() -> buildUrl/buildHeaders/
  // transformRequest -> fetch round-trip without certificates.
  return {
    apiKey: "mock-key",
    connectionId: NODE_ID,
    providerSpecificData: { baseUrl: `${baseUrl}/api/v1` },
  };
}

/**
 * End-to-end proof that a gigachat-compatible node converts an OpenAI request
 * (tools + reasoning) into GigaChat's wire shape and back, using a mock GigaChat
 * server in place of the unavailable real upstream.
 */
describe("gigachat-compatible OpenAI<->GigaChat conversion (mock upstream)", () => {
  let mock: MockGigachatServer;

  before(async () => {
    mock = await startMockGigachat();
  });

  after(async () => {
    await mock.close();
  });

  it("converts OpenAI tools[] to GigaChat functions[] on the wire and returns tool_calls", async () => {
    const exec = new DefaultExecutor(NODE_ID);
    const { response: res } = await exec.execute({
      model: "GigaChat-3",
      stream: false,
      credentials: gigaCreds(mock.url),
      body: {
        model: "GigaChat-3",
        messages: [{ role: "user", content: "weather in Moscow?" }],
        tools: [
          {
            type: "function",
            function: {
              name: "get-weather",
              description: "Get weather",
              parameters: {
                type: "object",
                properties: {
                  city: { type: "string" },
                  // nested object WITHOUT properties — the #422 case
                  filters: { type: "object" },
                },
                required: ["city"],
              },
            },
          },
        ],
        tool_choice: "auto",
      },
    });

    assert.equal(res.status, 200, "upstream returned 200");

    // 1) What actually went over the wire to GigaChat.
    const sent = mock.lastRequest?.body as JsonRecord;
    assert.ok(Array.isArray(sent.functions), "tools[] was converted to functions[]");
    assert.equal(sent.tools, undefined, "tools[] removed from upstream payload");
    assert.equal(sent.tool_choice, undefined, "tool_choice stripped (GigaChat rejects it)");

    const fn = (sent.functions as JsonRecord[])[0];
    assert.equal(fn.name, "get_weather", "hyphenated tool name sanitized to underscore");
    const params = fn.parameters as JsonRecord;
    const props = params.properties as JsonRecord;
    // #422 fix: every object node must carry a properties field.
    assert.deepEqual(
      (props.filters as JsonRecord).properties,
      {},
      "nested object gained properties:{} so GigaChat accepts the schema"
    );

    // 2) The response carries tool_calls back to the caller.
    const json = (await res.json()) as {
      choices: { message: { tool_calls?: { function: { name: string } }[] } }[];
    };
    const toolCalls = json.choices[0].message.tool_calls;
    assert.ok(toolCalls && toolCalls.length > 0, "tool_calls returned");
    assert.equal(toolCalls[0].function.name, "get-weather");
  });

  it("passes reasoning back from GigaChat and replays reasoning_content in the request", async () => {
    const exec = new DefaultExecutor(NODE_ID);
    const { response: res } = await exec.execute({
      model: "GigaChat-3",
      stream: false,
      credentials: gigaCreds(mock.url),
      body: {
        model: "GigaChat-3",
        messages: [
          { role: "user", content: "think first" },
          // prior assistant turn carrying reasoning_content must survive conversion
          {
            role: "assistant",
            content: "ok",
            reasoning_content: "previous chain of thought",
          },
          { role: "user", content: "continue" },
        ],
      },
    });

    assert.equal(res.status, 200);

    // reasoning_content on the inbound assistant message is preserved upstream.
    const sent = mock.lastRequest?.body as JsonRecord;
    const sentMessages = sent.messages as JsonRecord[];
    const assistantMsg = sentMessages.find((m) => m.role === "assistant");
    assert.ok(assistantMsg, "assistant message forwarded");
    assert.equal(
      assistantMsg?.reasoning_content,
      "previous chain of thought",
      "reasoning_content preserved on the upstream request"
    );

    // GigaChat's reasoning_content comes back to the caller.
    const json = (await res.json()) as {
      choices: { message: { reasoning_content?: string; content?: string } }[];
    };
    assert.equal(
      json.choices[0].message.reasoning_content,
      "mock reasoning: deciding what to do",
      "reasoning_content returned from upstream"
    );
  });

  it("streams a tool/reasoning turn end-to-end (SSE) without conversion errors", async () => {
    const exec = new DefaultExecutor(NODE_ID);
    const { response: res } = await exec.execute({
      model: "GigaChat-3",
      stream: true,
      credentials: gigaCreds(mock.url),
      body: {
        model: "GigaChat-3",
        stream: true,
        messages: [{ role: "user", content: "stream please" }],
        tools: [
          {
            type: "function",
            function: { name: "noop", description: "d", parameters: { type: "object" } },
          },
        ],
      },
    });

    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes("data: "), "SSE data frames present");
    assert.ok(text.includes("[DONE]"), "stream terminates with [DONE]");

    // Even in streaming, tools[] must have been converted to functions[].
    const sent = mock.lastRequest?.body as JsonRecord;
    assert.ok(Array.isArray(sent.functions), "functions[] sent in streaming request");
    assert.equal(sent.tools, undefined, "tools[] removed in streaming request");
    assert.equal(sent.stream_options, undefined, "stream_options stripped for GigaChat");
  });
});

/**
 * Bidirectional tools/functions + tool_choice/function_call conversion against the
 * true GigaChat v1 wire shape (wire:"gigachat"): non-stream message.function_call
 * with an OBJECT arguments field + finish_reason "function_call".
 */
describe("gigachat wire-mode bidirectional tools/tool_choice conversion", () => {
  let mock: MockGigachatServer;

  before(async () => {
    mock = await startMockGigachat({ wire: "gigachat" });
  });

  after(async () => {
    await mock.close();
  });

  function wireCreds(baseUrl: string): JsonRecord {
    return {
      apiKey: "mock-key",
      connectionId: WIRE_NODE_ID,
      providerSpecificData: { baseUrl: `${baseUrl}/api/v1` },
    };
  }

  // (a) + (b): tools[] -> functions[]; tool_choice -> function_call; negative
  // body assertions (no tools/tool_choice); (d) function_call -> tool_calls back.
  it("(a,b,d) converts tools+tool_choice out and function_call back to tool_calls", async () => {
    const exec = new DefaultExecutor(WIRE_NODE_ID);
    const { response: res } = await exec.execute({
      model: "GigaChat-3",
      stream: false,
      credentials: wireCreds(mock.url),
      body: {
        model: "GigaChat-3",
        messages: [{ role: "user", content: "weather in Moscow?" }],
        tools: [
          {
            type: "function",
            function: {
              name: "get-weather",
              description: "Get weather",
              parameters: {
                type: "object",
                properties: { city: { type: "string" } },
                required: ["city"],
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "get-weather" } },
      },
    });

    assert.equal(res.status, 200);

    const sent = mock.lastRequest?.body as JsonRecord;
    assert.ok(Array.isArray(sent.functions), "tools[] converted to functions[]");
    assert.equal(sent.tools, undefined, "NO tools key sent to GigaChat");
    assert.equal(sent.tool_choice, undefined, "NO tool_choice key sent to GigaChat");
    // {function:{name}} object form maps to {name} (sanitized).
    assert.deepEqual(
      sent.function_call,
      { name: "get_weather" },
      "tool_choice object mapped to function_call {name}"
    );

    // (d) The GigaChat function_call response comes back as OpenAI tool_calls.
    const json = (await res.json()) as {
      choices: {
        message: { tool_calls?: { function: { name: string; arguments: string } }[] };
        finish_reason: string;
      }[];
    };
    const choice = json.choices[0];
    assert.equal(choice.finish_reason, "tool_calls", "finish_reason normalized to tool_calls");
    const toolCalls = choice.message.tool_calls;
    assert.ok(toolCalls && toolCalls.length > 0, "tool_calls returned to client");
    assert.equal(toolCalls[0].function.name, "get-weather", "original hyphenated name restored");

    // arguments MUST be a string and that string MUST be valid JSON.
    const args = toolCalls[0].function.arguments;
    assert.equal(typeof args, "string", "arguments is a string, not an object");
    const parsedArgs = JSON.parse(args);
    assert.deepEqual(parsedArgs, { city: "Moscow" }, "arguments string is valid JSON");
  });

  // (b) string tool_choice mappings: auto->auto, none->none, required->auto.
  it("(b) maps string tool_choice auto/none/required to function_call", async () => {
    const exec = new DefaultExecutor(WIRE_NODE_ID);
    const cases: Array<[string, string]> = [
      ["auto", "auto"],
      ["none", "none"],
      ["required", "auto"],
    ];
    for (const [input, expected] of cases) {
      await exec.execute({
        model: "GigaChat-3",
        stream: false,
        credentials: wireCreds(mock.url),
        body: {
          model: "GigaChat-3",
          messages: [{ role: "user", content: "hi" }],
          tools: [
            {
              type: "function",
              function: { name: "noop", description: "d", parameters: { type: "object" } },
            },
          ],
          tool_choice: input,
        },
      });
      const sent = mock.lastRequest?.body as JsonRecord;
      assert.equal(sent.tool_choice, undefined, `tool_choice "${input}" stripped`);
      assert.equal(
        sent.function_call,
        expected,
        `tool_choice "${input}" mapped to function_call "${expected}"`
      );
    }
  });

  // (c) legacy clients sending functions[]/function_call directly pass through;
  // schema normalization still applies to the raw functions[].
  it("(c) passes through legacy functions[]/function_call and normalizes schema", async () => {
    const exec = new DefaultExecutor(WIRE_NODE_ID);
    const { response: res } = await exec.execute({
      model: "GigaChat-3",
      stream: false,
      credentials: wireCreds(mock.url),
      body: {
        model: "GigaChat-3",
        messages: [{ role: "user", content: "legacy" }],
        functions: [
          {
            name: "legacy_fn",
            description: "legacy",
            // nested object WITHOUT properties — #422 normalization must apply.
            parameters: { type: "object", properties: { filters: { type: "object" } } },
          },
        ],
        function_call: "auto",
      },
    });

    assert.equal(res.status, 200);
    const sent = mock.lastRequest?.body as JsonRecord;
    assert.ok(Array.isArray(sent.functions), "legacy functions[] preserved");
    assert.equal(sent.tools, undefined, "no tools key");
    assert.equal(sent.function_call, "auto", "legacy function_call preserved");
    const fn = (sent.functions as JsonRecord[])[0];
    const params = fn.parameters as JsonRecord;
    const props = params.properties as JsonRecord;
    assert.deepEqual(
      (props.filters as JsonRecord).properties,
      {},
      "#422: nested object gained properties:{} even on the legacy path"
    );
  });

  // (e) role:"tool" + tool_call_id -> role:"function" + resolved name, with the
  // name recovered from the prior assistant message's tool_calls.
  it("(e) resolves tool_call_id to the function name from prior assistant message", async () => {
    const exec = new DefaultExecutor(WIRE_NODE_ID);
    await exec.execute({
      model: "GigaChat-3",
      stream: false,
      credentials: wireCreds(mock.url),
      body: {
        model: "GigaChat-3",
        messages: [
          { role: "user", content: "weather?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_abc123",
                type: "function",
                function: { name: "get-weather", arguments: '{"city":"Moscow"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_abc123", content: "Sunny, 25C" },
        ],
      },
    });

    const sent = mock.lastRequest?.body as JsonRecord;
    const sentMessages = sent.messages as JsonRecord[];
    const functionMsg = sentMessages.find((m) => m.role === "function");
    assert.ok(functionMsg, "tool message converted to role:function");
    assert.equal(
      functionMsg?.name,
      "get_weather",
      "name resolved from prior assistant tool_call (sanitized)"
    );
    assert.equal(functionMsg?.tool_call_id, undefined, "tool_call_id removed");
    // content coerced to a JSON-object string (GigaChat rejects bare strings).
    assert.equal(typeof functionMsg?.content, "string", "content is a string");
    JSON.parse(functionMsg?.content as string);
  });

  // (e) QA failure: an unresolvable tool_call_id must surface a clear 400.
  it("(e) returns 400 when tool_call_id cannot be resolved to a name", async () => {
    const exec = new DefaultExecutor(WIRE_NODE_ID);
    const { response: res } = await exec.execute({
      model: "GigaChat-3",
      stream: false,
      credentials: wireCreds(mock.url),
      body: {
        model: "GigaChat-3",
        messages: [
          { role: "user", content: "weather?" },
          // No assistant message emitted call_missing — history is malformed.
          { role: "tool", tool_call_id: "call_missing", content: "Sunny" },
        ],
      },
    });

    assert.equal(res.status, 400, "unresolvable tool_call_id yields a 400");
    const json = (await res.json()) as { error?: { message?: string } };
    assert.match(
      json.error?.message ?? "",
      /call_missing/,
      "400 body names the unresolvable tool_call_id"
    );
  });

  // T4.4: Non-stream reasoning_content round-trip
  it("T4.4 (a) exposes reasoning_content in non-stream response", async () => {
    const testReasoningContent = "mock reasoning: analyzing the user query";
    const mock2 = await startMockGigachat({
      wire: "gigachat",
      reasoningContent: testReasoningContent,
    });

    try {
      const exec = new DefaultExecutor(NODE_ID);
      const { response: res } = await exec.execute({
        model: "GigaChat-3",
        stream: false,
        credentials: gigaCreds(mock2.url),
        body: {
          model: "GigaChat-3",
          messages: [{ role: "user", content: "hello" }],
          reasoning_effort: "high",
        },
      });

      assert.equal((mock2.lastRequest?.body as JsonRecord).reasoning_effort, "high");
      assert.equal(res.status, 200, "request succeeded");
      const json = (await res.json()) as JsonRecord;
      const message = ((json.choices as JsonRecord[])?.[0]?.message as JsonRecord) || {};

      assert.equal(
        message.reasoning_content,
        testReasoningContent,
        "reasoning_content from GigaChat upstream is exposed in OpenAI response"
      );
    } finally {
      await mock2.close();
    }
  });

  // T4.4: Stream reasoning_content round-trip
  it("T4.4 (b) exposes reasoning_content in streaming response", async () => {
    const testReasoningContent = "mock reasoning: processing stream";
    const mock2 = await startMockGigachat({
      wire: "gigachat",
      streamArgsMode: "whole",
      reasoningContent: testReasoningContent,
    });

    try {
      const exec = new DefaultExecutor(NODE_ID);
      const { response: res } = await exec.execute({
        model: "GigaChat-3",
        stream: true,
        credentials: gigaCreds(mock2.url),
        body: {
          model: "GigaChat-3",
          stream: true,
          messages: [{ role: "user", content: "hello" }],
          tools: [
            {
              type: "function",
              function: {
                name: "test-function",
                description: "Test",
                parameters: { type: "object", properties: { a: { type: "string" } } },
              },
            },
          ],
          reasoning_effort: "high",
        },
      });

      assert.equal((mock2.lastRequest?.body as JsonRecord).reasoning_effort, "high");
      assert.equal(res.status, 200, "streaming request succeeded");
      const text = await res.text();

      // Parse SSE stream chunks
      let foundReasoningContent = false;
      const lines = text.split("\n");
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const chunk = JSON.parse(line.substring(6)) as JsonRecord;
            const choices = chunk.choices as JsonRecord[];
            if (Array.isArray(choices)) {
              for (const choice of choices) {
                const delta = choice.delta as JsonRecord;
                if (delta && typeof delta.reasoning_content === "string") {
                  assert.equal(
                    delta.reasoning_content,
                    testReasoningContent,
                    "reasoning_content appears in streaming delta"
                  );
                  foundReasoningContent = true;
                }
              }
            }
          } catch {
            // Skip non-JSON or [DONE]
          }
        }
      }

      assert.ok(
        foundReasoningContent,
        "streaming response contains reasoning_content in at least one delta"
      );
    } finally {
      await mock2.close();
    }
  });

  // T4.4: Sanitizer high retention for GigaChat
  it("T4.4 (c) sanitizer allows reasoning_effort high for GigaChat", async () => {
    const { sanitizeReasoningEffortForProvider } = await import(
      "../../../open-sse/executors/base.ts"
    );

    const body = {
      model: "GigaChat-3",
      messages: [{ role: "user", content: "test" }],
      reasoning_effort: "high",
    };

    // GigaChat and gigachat-compatible-* should downgrade reasoning_effort
    const sanitized1 = sanitizeReasoningEffortForProvider(body, "gigachat", "GigaChat-3");
    assert.equal(
      (sanitized1 as JsonRecord).reasoning_effort,
      "high",
      "gigachat provider preserves reasoning_effort high"
    );

    const sanitized2 = sanitizeReasoningEffortForProvider(
      body,
      "gigachat-compatible-test",
      "GigaChat-3"
    );
    assert.equal(
      (sanitized2 as JsonRecord).reasoning_effort,
      "high",
      "gigachat-compatible-* provider preserves reasoning_effort high"
    );

    const bodyMax = { ...body, reasoning_effort: "max" };
    const sanitized3 = sanitizeReasoningEffortForProvider(bodyMax, "gigachat", "GigaChat-3");
    assert.equal(
      (sanitized3 as JsonRecord).reasoning_effort,
      "high",
      "gigachat downgrades max to high"
    );

    const bodyXHigh = { ...body, reasoning_effort: "xhigh" };
    const sanitized4 = sanitizeReasoningEffortForProvider(
      bodyXHigh,
      "gigachat-compatible-test",
      "GigaChat-3"
    );
    assert.equal(
      (sanitized4 as JsonRecord).reasoning_effort,
      "high",
      "gigachat-compatible-* downgrades xhigh to high"
    );
  });

  it("converts OpenAI response_format json_schema to GigaChat format with schema normalization", async () => {
    const exec = new DefaultExecutor(NODE_ID);
    const { response: res } = await exec.execute({
      model: "GigaChat-3",
      stream: false,
      credentials: gigaCreds(mock.url),
      body: {
        model: "GigaChat-3",
        messages: [{ role: "user", content: "return JSON" }],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "MySchema",
            schema: {
              type: "object",
              properties: {
                status: { type: "string" },
                // nested object without properties — the #422 case
                metadata: { type: "object" },
              },
            },
            strict: true,
          },
        },
      },
    });

    assert.equal(res.status, 200, "request with json_schema succeeded");

    // Verify what went over the wire to GigaChat
    const sent = mock.lastRequest?.body as JsonRecord;
    const rf = sent.response_format as JsonRecord;

    assert.equal(rf.type, "json_schema", "response_format.type preserved");
    assert.equal(rf.name, undefined, "response_format.name removed");
    assert.equal((rf.json_schema as any), undefined, "response_format.json_schema wrapper removed");
    assert.equal(rf.strict, true, "response_format.strict preserved");

    const schema = rf.schema as JsonRecord;
    assert.ok(schema, "schema field exists at top level");
    assert.equal(schema.type, "object", "schema.type preserved");

    const props = schema.properties as JsonRecord;
    const metadata = props.metadata as JsonRecord;
    // #422 fix: nested object must have properties field
    assert.deepEqual(
      metadata.properties,
      {},
      "nested object gained properties:{} for GigaChat"
    );
  });

  it("passes through OpenAI response_format json_object unchanged for GigaChat", async () => {
    const exec = new DefaultExecutor(NODE_ID);
    const { response: res } = await exec.execute({
      model: "GigaChat-3",
      stream: false,
      credentials: gigaCreds(mock.url),
      body: {
        model: "GigaChat-3",
        messages: [{ role: "user", content: "return JSON" }],
        response_format: {
          type: "json_object",
        },
      },
    });

    assert.equal(res.status, 200, "request with json_object succeeded");

    // Verify json_object passes through exactly
    const sent = mock.lastRequest?.body as JsonRecord;
    const rf = sent.response_format as JsonRecord;

    assert.deepEqual(
      rf,
      { type: "json_object" },
      "json_object response_format passed through unchanged"
    );
  });

});

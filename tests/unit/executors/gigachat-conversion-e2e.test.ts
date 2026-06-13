import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { DefaultExecutor } from "../../../open-sse/executors/default.ts";
import { startMockGigachat, type MockGigachatServer } from "../../fixtures/mock-gigachat-server.js";

const NODE_ID = "gigachat-compatible-e2e";

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
    assert.equal(toolCalls[0].function.name, "get_weather");
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

import test from "node:test";
import assert from "node:assert/strict";

import { getExecutor } from "../../open-sse/executors/index.ts";
import { GigaChat400Error } from "../../open-sse/executors/default.ts";
import {
  convertGigaChatV2NonStreamResponse,
  createGigaChatV2StreamTransform,
} from "../../open-sse/executors/gigachatV2.ts";

const PROVIDER = "gigachat-compatible-v2test";
const V2_CREDS = {
  providerSpecificData: { apiVersion: "v2", baseUrl: "https://api.giga.chat/v2" },
};

function transform(body: unknown, stream = false): Record<string, unknown> {
  const exec = getExecutor(PROVIDER);
  return exec.transformRequest("GigaChat-2-Max", body, stream, V2_CREDS) as Record<string, unknown>;
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

function runStream(chunks: string[]): Promise<string> {
  const encoder = new TextEncoder();
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return drain(source.pipeThrough(createGigaChatV2StreamTransform()));
}

// ── Request conversion (OpenAI → v2) ──────────────────────────────────────────

test("v2 request: string content becomes a content-item array", () => {
  const out = transform({ model: "m", messages: [{ role: "user", content: "hi" }] });
  assert.deepEqual(out.messages, [{ role: "user", content: [{ text: "hi" }] }]);
});

test("v2 request: multi-part content keeps text parts, drops non-text", () => {
  const out = transform({
    model: "m",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "a" },
          { type: "image_url", image_url: { url: "x" } },
          { type: "text", text: "b" },
        ],
      },
    ],
  });
  assert.deepEqual((out.messages as any)[0].content, [{ text: "a" }, { text: "b" }]);
});

test("v2 request: tools become a single functions.specifications wrapper with sanitized names", () => {
  const out = transform({
    model: "m",
    messages: [],
    tools: [
      { type: "function", function: { name: "get-weather", description: "d", parameters: {} } },
      { type: "function", function: { name: "list_files", parameters: {} } },
    ],
  });
  const tools = out.tools as any[];
  assert.equal(tools.length, 1);
  const specs = tools[0].functions.specifications;
  assert.equal(specs.length, 2);
  assert.equal(specs[0].name, "get_weather");
  assert.equal(specs[1].name, "list_files");
  assert.deepEqual(specs[0].parameters, { type: "object", properties: {} });
  const map = out._toolNameMap as Map<string, string>;
  assert.equal(map.get("get_weather"), "get-weather");
});

test("v2 request: tool_choice auto/none/required/forced map to tool_config", () => {
  assert.deepEqual(
    (transform({ model: "m", messages: [], tool_choice: "auto" }) as any).tool_config,
    {
      mode: "auto",
    }
  );
  assert.deepEqual(
    (transform({ model: "m", messages: [], tool_choice: "none" }) as any).tool_config,
    {
      mode: "none",
    }
  );
  assert.deepEqual(
    (transform({ model: "m", messages: [], tool_choice: "required" }) as any).tool_config,
    { mode: "auto" }
  );
  const forced = transform({
    model: "m",
    messages: [],
    tool_choice: { type: "function", function: { name: "get-weather" } },
  });
  assert.deepEqual((forced as any).tool_config, { mode: "forced", function_name: "get_weather" });
  assert.ok(!("tool_choice" in forced));
});

test("v2 request: sampling params move under model_options; unsupported dropped", () => {
  const out = transform({
    model: "m",
    messages: [],
    temperature: 0.5,
    top_p: 0.9,
    max_tokens: 100,
    repetition_penalty: 1.1,
    frequency_penalty: 0.2,
    presence_penalty: 0.3,
    n: 2,
    user: "u",
    logit_bias: {},
    stream_options: { include_usage: true },
  });
  assert.deepEqual(out.model_options, {
    temperature: 0.5,
    top_p: 0.9,
    max_tokens: 100,
    repetition_penalty: 1.1,
  });
  for (const k of [
    "temperature",
    "top_p",
    "max_tokens",
    "frequency_penalty",
    "presence_penalty",
    "n",
    "user",
    "logit_bias",
    "stream_options",
  ]) {
    assert.ok(!(k in out), `${k} must be dropped from top level`);
  }
});

test("v2 request: max_completion_tokens folds into model_options.max_tokens", () => {
  const out = transform({ model: "m", messages: [], max_completion_tokens: 42 });
  assert.deepEqual(out.model_options, { max_tokens: 42 });
  assert.ok(!("max_completion_tokens" in out));
});

test("v2 request: response_format json_schema unwraps and normalizes; text passes; json_object drops", () => {
  const js = transform({
    model: "m",
    messages: [],
    response_format: {
      type: "json_schema",
      json_schema: { name: "S", schema: { type: "object" }, strict: true },
    },
  });
  assert.deepEqual((js.model_options as any).response_format, {
    type: "json_schema",
    schema: { type: "object", properties: {} },
    strict: true,
  });

  const text = transform({ model: "m", messages: [], response_format: { type: "text" } });
  assert.deepEqual((text.model_options as any).response_format, { type: "text" });

  const obj = transform({ model: "m", messages: [], response_format: { type: "json_object" } });
  assert.ok(!obj.model_options || !("response_format" in (obj.model_options as any)));
});

test("v2 request: reasoning_effort and reasoning.effort map to model_options.reasoning medium", () => {
  const a = transform({ model: "m", messages: [], reasoning_effort: "high" });
  assert.deepEqual((a.model_options as any).reasoning, { effort: "medium" });
  assert.ok(!("reasoning_effort" in a));
  const b = transform({ model: "m", messages: [], reasoning: { effort: "low" } });
  assert.deepEqual((b.model_options as any).reasoning, { effort: "medium" });
  assert.ok(!("reasoning" in b));
});

test("v2 request: assistant tool_calls become content function_call with STRING arguments", () => {
  const out = transform({
    model: "m",
    messages: [
      {
        role: "assistant",
        tool_calls: [{ id: "c1", function: { name: "get-weather", arguments: '{"city":"NYC"}' } }],
      },
    ],
  });
  const msg = (out.messages as any)[0];
  assert.equal(msg.role, "assistant");
  assert.deepEqual(msg.content, [
    { function_call: { name: "get_weather", arguments: '{"city":"NYC"}' } },
  ]);
  assert.equal(typeof msg.content[0].function_call.arguments, "string");
});

test("v2 request: tool result becomes function_result with resolved name and object-string result", () => {
  const out = transform({
    model: "m",
    messages: [
      {
        role: "assistant",
        tool_calls: [{ id: "c1", function: { name: "get-weather", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "c1", content: "Sunny" },
    ],
  });
  const toolMsg = (out.messages as any)[1];
  assert.equal(toolMsg.role, "tool");
  const fr = toolMsg.content[0].function_result;
  assert.equal(fr.name, "get_weather");
  assert.deepEqual(JSON.parse(fr.result), { result: "Sunny" });
});

test("v2 request: already-object tool result content is kept as-is", () => {
  const out = transform({
    model: "m",
    messages: [{ role: "tool", name: "get_weather", content: '{"temp":25}' }],
  });
  const fr = (out.messages as any)[0].content[0].function_result;
  assert.deepEqual(JSON.parse(fr.result), { temp: 25 });
});

test("v2 request: unresolvable tool_call_id raises GigaChat400Error", () => {
  assert.throws(
    () =>
      transform({
        model: "m",
        messages: [{ role: "tool", tool_call_id: "missing", content: "x" }],
      }),
    (err: unknown) => err instanceof GigaChat400Error
  );
});

test("v2 request: tools_state_id and legacy functions_state_id forward as tools_state_id", () => {
  const withNew = transform({
    model: "m",
    messages: [{ role: "assistant", content: "ok", tools_state_id: "uuid-new" }],
  });
  assert.equal((withNew.messages as any)[0].tools_state_id, "uuid-new");

  const withLegacy = transform({
    model: "m",
    messages: [{ role: "assistant", content: "ok", functions_state_id: "uuid-legacy" }],
  });
  assert.equal((withLegacy.messages as any)[0].tools_state_id, "uuid-legacy");
});

// ── Non-stream response conversion (v2 → OpenAI) ──────────────────────────────

test("v2 response: assistant message becomes choices[0].message content", () => {
  const out = convertGigaChatV2NonStreamResponse(
    {
      model: "GigaChat-2-Max",
      created_at: 1700000000,
      messages: [{ role: "assistant", content: [{ text: "Hello" }] }],
      finish_reason: "stop",
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    },
    null
  );
  assert.equal(out.object, "chat.completion");
  assert.equal(out.created, 1700000000);
  assert.equal(out.model, "GigaChat-2-Max");
  const choice = (out.choices as any)[0];
  assert.equal(choice.message.content, "Hello");
  assert.equal(choice.finish_reason, "stop");
  assert.deepEqual(out.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
});

test("v2 response: reasoning message folds into reasoning_content", () => {
  const out = convertGigaChatV2NonStreamResponse(
    {
      messages: [
        { role: "reasoning", content: [{ text: "let me think" }] },
        { role: "assistant", content: [{ text: "answer" }] },
      ],
      finish_reason: "stop",
    },
    null
  );
  const msg = (out.choices as any)[0].message;
  assert.equal(msg.reasoning_content, "let me think");
  assert.equal(msg.content, "answer");
});

test("v2 response: function_call becomes tool_calls with un-sanitized name", () => {
  const map = new Map<string, string>([["get_weather", "get-weather"]]);
  const out = convertGigaChatV2NonStreamResponse(
    {
      messages: [
        {
          role: "assistant",
          content: [{ function_call: { name: "get_weather", arguments: '{"city":"NYC"}' } }],
        },
      ],
      finish_reason: "function_call",
    },
    map
  );
  const choice = (out.choices as any)[0];
  assert.equal(choice.finish_reason, "tool_calls");
  assert.equal(choice.message.content, null);
  assert.equal(choice.message.tool_calls[0].function.name, "get-weather");
  assert.equal(choice.message.tool_calls[0].function.arguments, '{"city":"NYC"}');
});

test("v2 response: blacklist finish_reason maps to content_filter", () => {
  const out = convertGigaChatV2NonStreamResponse(
    { messages: [{ role: "assistant", content: [{ text: "" }] }], finish_reason: "blacklist" },
    null
  );
  assert.equal((out.choices as any)[0].finish_reason, "content_filter");
});

test("v2 response: usage cached_tokens maps to prompt_tokens_details", () => {
  const out = convertGigaChatV2NonStreamResponse(
    {
      messages: [{ role: "assistant", content: [{ text: "x" }] }],
      finish_reason: "stop",
      usage: {
        input_tokens: 20,
        output_tokens: 8,
        total_tokens: 28,
        input_tokens_details: { cached_tokens: 3 },
      },
    },
    null
  );
  assert.deepEqual(out.usage, {
    prompt_tokens: 20,
    completion_tokens: 8,
    total_tokens: 28,
    prompt_tokens_details: { cached_tokens: 3 },
  });
});

test("v2 response: tools_state_id passes through onto the message", () => {
  const out = convertGigaChatV2NonStreamResponse(
    {
      messages: [{ role: "assistant", tools_state_id: "uuid-x", content: [{ text: "y" }] }],
      finish_reason: "stop",
    },
    null
  );
  assert.equal((out.choices as any)[0].message.tools_state_id, "uuid-x");
});

// ── Streaming conversion (v2 SSE → OpenAI SSE) ────────────────────────────────

test("v2 stream: delta events forward as plain data lines and end with [DONE]", async () => {
  const input =
    'event: response.message.delta\ndata: {"choices":[{"delta":{"content":"Hi","role":"assistant"},"index":0}],"model":"m","object":"chat.completion"}\n\n' +
    'event: response.message.done\ndata: {"choices":[{"delta":{"content":""},"index":0,"finish_reason":"stop"}],"model":"m","usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}\n\n';
  const out = await runStream([input]);
  assert.ok(out.includes('"content":"Hi"'));
  assert.ok(!out.includes("event:"));
  assert.ok(out.trimEnd().endsWith("data: [DONE]"));
});

test("v2 stream: done event with function_call finish_reason maps to tool_calls", async () => {
  const input =
    'event: response.message.done\ndata: {"choices":[{"delta":{},"index":0,"finish_reason":"function_call"}],"model":"m"}\n\n';
  const out = await runStream([input]);
  assert.ok(out.includes('"finish_reason":"tool_calls"'));
});

test("v2 stream: alternate v2-shaped done (no choices) synthesizes a final chunk", async () => {
  const input =
    'event: response.message.done\ndata: {"model":"m","created_at":1700000000,"finish_reason":"error","usage":{"input_tokens":4,"output_tokens":2,"total_tokens":6}}\n\n';
  const out = await runStream([input]);
  const dataLine = out.split("\n").find((l) => l.startsWith("data: {"));
  assert.ok(dataLine);
  const chunk = JSON.parse(dataLine!.slice(6));
  assert.equal(chunk.choices[0].finish_reason, "error");
  assert.deepEqual(chunk.usage, { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 });
});

test("v2 stream: tool events are dropped", async () => {
  const input =
    'event: response.tool.in_progress\ndata: {"tool":"x"}\n\n' +
    'event: response.tool.completed\ndata: {"tool":"x"}\n\n' +
    'event: response.message.done\ndata: {"choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"model":"m"}\n\n';
  const out = await runStream([input]);
  assert.ok(!out.includes('"tool"'));
  assert.ok(out.trimEnd().endsWith("data: [DONE]"));
});

test("v2 stream: partial frames split across chunk boundaries are buffered", async () => {
  const frame =
    'event: response.message.delta\ndata: {"choices":[{"delta":{"content":"split"},"index":0}],"model":"m"}\n\n';
  const mid = Math.floor(frame.length / 2);
  const out = await runStream([frame.slice(0, mid), frame.slice(mid)]);
  assert.ok(out.includes('"content":"split"'));
});

// ── buildUrl for /v2-suffixed base ────────────────────────────────────────────

test("v2 buildUrl: /v2-suffixed base composes to /v2/chat/completions", () => {
  const exec = getExecutor(PROVIDER);
  const url = exec.buildUrl("m", false, 0, V2_CREDS);
  assert.equal(url, "https://api.giga.chat/v2/chat/completions");
});

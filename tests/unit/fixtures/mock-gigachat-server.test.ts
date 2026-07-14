import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMockGigachat, type MockGigachatServer } from "../../../tests/fixtures/mock-gigachat-server.js";

describe("mock GigaChat server (HTTP)", () => {
  let server: MockGigachatServer;

  before(async () => {
    server = await startMockGigachat();
  });

  after(async () => {
    await server.close();
  });

  it("GET /api/v1/models returns model list", async () => {
    const r = await fetch(`${server.url}/api/v1/models`);
    assert.equal(r.status, 200);
    const body = (await r.json()) as { data: { id: string }[] };
    assert.equal(body.data[0].id, "GigaChat");
  });

  it("POST /api/v1/chat/completions returns mock-reply", async () => {
    const r = await fetch(`${server.url}/api/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "GigaChat", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(r.status, 200);
    const body = (await r.json()) as { choices: { message: { content: string } }[] };
    assert.equal(body.choices[0].message.content, "mock-reply");
  });

  it("POST /api/v1/chat/completions streaming returns SSE chunks", async () => {
    const r = await fetch(`${server.url}/api/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "GigaChat",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.ok(text.includes("data: "), "should have SSE data lines");
    assert.ok(text.includes("[DONE]"), "should end with [DONE]");
  });

  it("unknown path returns 404", async () => {
    const r = await fetch(`${server.url}/unknown`);
    assert.equal(r.status, 404);
  });
});

describe("mock GigaChat server (wire: gigachat)", () => {
  const functionsBody = {
    model: "GigaChat",
    functions: [{ name: "get_weather", parameters: { type: "object" } }],
    messages: [{ role: "user", content: "weather in Moscow?" }],
  };

  it("non-stream function call uses GigaChat message.function_call with OBJECT arguments", async () => {
    const server = await startMockGigachat({ wire: "gigachat" });
    try {
      const r = await fetch(`${server.url}/api/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(functionsBody),
      });
      assert.equal(r.status, 200);
      const body = (await r.json()) as {
        choices: {
          message: {
            content: string;
            function_call?: { name: string; arguments: unknown };
            functions_state_id?: string;
            tool_calls?: unknown;
          };
          finish_reason: string;
        }[];
        usage: { precached_prompt_tokens?: number };
      };
      const msg = body.choices[0].message;

      assert.equal(msg.content, "", "wire mode content is empty string, not null");
      assert.ok(msg.function_call, "expected GigaChat function_call, not tool_calls");
      assert.equal(msg.function_call?.name, "get_weather");
      assert.equal(
        typeof msg.function_call?.arguments,
        "object",
        "arguments must be an OBJECT, not a JSON string"
      );
      assert.deepEqual(msg.function_call?.arguments, { city: "Moscow" });
      assert.equal(msg.functions_state_id, "0e2a1b3c-4d5e-6f70-8a9b-mockstate0001");
      assert.equal(msg.tool_calls, undefined, "wire mode must NOT emit OpenAI tool_calls");
      assert.equal(body.choices[0].finish_reason, "function_call");
      assert.equal(body.usage.precached_prompt_tokens, 4);
    } finally {
      await server.close();
    }
  });

  it("non-stream without functions falls back to plain assistant reply", async () => {
    const server = await startMockGigachat({ wire: "gigachat" });
    try {
      const r = await fetch(`${server.url}/api/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "GigaChat", messages: [{ role: "user", content: "hi" }] }),
      });
      assert.equal(r.status, 200);
      const body = (await r.json()) as {
        choices: { message: { content: string }; finish_reason: string }[];
      };
      assert.equal(body.choices[0].message.content, "mock-reply");
      assert.equal(body.choices[0].finish_reason, "stop");
    } finally {
      await server.close();
    }
  });

  it("streaming (whole) emits one delta.function_call arguments chunk + [DONE]", async () => {
    const server = await startMockGigachat({ wire: "gigachat", streamArgsMode: "whole" });
    try {
      const r = await fetch(`${server.url}/api/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...functionsBody, stream: true }),
      });
      assert.equal(r.status, 200);
      const text = await r.text();
      const { name, args, stateId, finishReason } = collectFunctionStream(text);

      assert.equal(name, "get_weather");
      assert.equal(args, '{"city":"Moscow"}');
      assert.deepEqual(JSON.parse(args), { city: "Moscow" });
      assert.equal(stateId, "0e2a1b3c-4d5e-6f70-8a9b-mockstate0001");
      assert.equal(finishReason, "function_call");
      assert.ok(text.trim().endsWith("[DONE]"), "stream must end with [DONE]");
      assert.equal(countArgFragments(text), 1, "whole mode emits arguments in a single chunk");
    } finally {
      await server.close();
    }
  });

  it("streaming (split) fragments arguments across multiple delta.function_call chunks", async () => {
    const server = await startMockGigachat({ wire: "gigachat", streamArgsMode: "split" });
    try {
      const r = await fetch(`${server.url}/api/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...functionsBody, stream: true }),
      });
      assert.equal(r.status, 200);
      const text = await r.text();
      const { name, args, finishReason } = collectFunctionStream(text);

      assert.equal(name, "get_weather");
      assert.equal(args, '{"city":"Moscow"}', "reassembled fragments equal the whole arguments");
      assert.deepEqual(JSON.parse(args), { city: "Moscow" });
      assert.equal(finishReason, "function_call");
      assert.ok(countArgFragments(text) > 1, "split mode emits arguments across multiple chunks");
      assert.ok(text.includes("[DONE]"));
    } finally {
      await server.close();
    }
  });

  it("wire mode without functions streams plain content chunks", async () => {
    const server = await startMockGigachat({ wire: "gigachat" });
    try {
      const r = await fetch(`${server.url}/api/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "GigaChat", stream: true, messages: [{ role: "user", content: "hi" }] }),
      });
      assert.equal(r.status, 200);
      const text = await r.text();
      assert.ok(text.includes("Hello"), "plain streaming content preserved");
      assert.ok(text.includes("[DONE]"));
      assert.equal(countArgFragments(text), 0, "no function_call chunks without functions");
    } finally {
      await server.close();
    }
  });

  it("captures request body and headers for passthrough assertions", async () => {
    const server = await startMockGigachat({ wire: "gigachat" });
    try {
      await fetch(`${server.url}/api/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Session-ID": "sess-abc-123" },
        body: JSON.stringify(functionsBody),
      });
      assert.ok(server.lastRequest, "expected a captured request");
      assert.equal(server.lastRequest?.method, "POST");
      assert.equal(server.lastRequest?.path, "/api/v1/chat/completions");
      assert.equal(server.lastRequest?.headers["x-session-id"], "sess-abc-123");
      assert.deepEqual(
        (server.lastRequest?.body as { functions: unknown[] }).functions,
        functionsBody.functions
      );
    } finally {
      await server.close();
    }
  });

});

function parseSseChunks(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data: ") || t === "data: [DONE]") continue;
    out.push(JSON.parse(t.slice("data: ".length)) as Record<string, unknown>);
  }
  return out;
}

function collectFunctionStream(text: string): {
  name: string | undefined;
  args: string;
  stateId: string | undefined;
  finishReason: string | undefined;
} {
  let name: string | undefined;
  let args = "";
  let stateId: string | undefined;
  let finishReason: string | undefined;
  for (const chunk of parseSseChunks(text)) {
    const choice = (chunk.choices as { delta?: Record<string, unknown>; finish_reason?: string }[])[0];
    const delta = choice?.delta ?? {};
    const fc = delta.function_call as { name?: string; arguments?: string } | undefined;
    if (fc?.name) name = fc.name;
    if (typeof fc?.arguments === "string") args += fc.arguments;
    if (typeof delta.functions_state_id === "string") stateId = delta.functions_state_id;
    if (choice?.finish_reason) finishReason = choice.finish_reason;
  }
  return { name, args, stateId, finishReason };
}

function countArgFragments(text: string): number {
  let count = 0;
  for (const chunk of parseSseChunks(text)) {
    const choice = (chunk.choices as { delta?: Record<string, unknown> }[])[0];
    const fc = choice?.delta?.function_call as { arguments?: string } | undefined;
    if (typeof fc?.arguments === "string") count++;
  }
  return count;
}

/**
 * Stream-transform-level test proving a v1 GigaChat SSE usage chunk carrying
 * `precached_prompt_tokens` reaches the client with
 * `prompt_tokens_details.cached_tokens`, and that `finish_reason: "blacklist"`
 * reaches the client as `content_filter` — exercising createPassthroughStreamWithLogger
 * directly (the gigachat-compatible passthrough branch in stream.ts), following the
 * pattern established in tests/unit/stream-utilities.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.ts";

async function readAll(transform: {
  readable: ReadableStream<Uint8Array>;
}): Promise<string> {
  const reader = transform.readable.getReader();
  const decoder = new TextDecoder();
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value);
  }
  return result;
}

function parseSseDataLines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:") || t.slice(5).trim() === "[DONE]") continue;
    try {
      out.push(JSON.parse(t.slice(5).trim()));
    } catch {
      // skip
    }
  }
  return out;
}

describe("gigachat-compatible passthrough stream: precached_prompt_tokens + blacklist finish_reason", () => {
  it("maps usage.precached_prompt_tokens onto prompt_tokens_details.cached_tokens on the emitted chunk", async () => {
    const transform = createPassthroughStreamWithLogger(
      "gigachat-compatible-stream-test",
      null,
      null,
      "GigaChat-3",
      null,
      null,
      null,
      null,
      null,
      null
    );

    const writer = transform.writable.getWriter();
    await writer.write(
      new TextEncoder().encode(
        [
          'data: {"id":"1","object":"chat.completion.chunk","model":"GigaChat","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}',
          "",
        ].join("\n") + "\n"
      )
    );
    await writer.write(
      new TextEncoder().encode(
        [
          'data: {"id":"1","object":"chat.completion.chunk","model":"GigaChat","choices":[{"index":0,"delta":{},"finish_reason":null}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15,"precached_prompt_tokens":42}}',
          "",
        ].join("\n") + "\n"
      )
    );
    await writer.write(
      new TextEncoder().encode(
        [
          'data: {"id":"1","object":"chat.completion.chunk","model":"GigaChat","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
          "data: [DONE]",
          "",
        ].join("\n") + "\n"
      )
    );
    await writer.close();

    const result = await readAll(transform);
    const chunks = parseSseDataLines(result);

    const usageChunk = chunks.find(
      (c) => (c as { usage?: unknown }).usage !== undefined
    ) as { usage?: { precached_prompt_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } } | undefined;

    assert.ok(usageChunk, "a chunk carrying usage reached the client");
    assert.equal(
      usageChunk?.usage?.prompt_tokens_details?.cached_tokens,
      42,
      "precached_prompt_tokens surfaced as prompt_tokens_details.cached_tokens on the client SSE"
    );
    assert.equal(
      usageChunk?.usage?.precached_prompt_tokens,
      undefined,
      "non-standard precached_prompt_tokens key removed from the client payload"
    );
  });

  it("maps finish_reason blacklist to content_filter on the emitted chunk", async () => {
    const transform = createPassthroughStreamWithLogger(
      "gigachat-compatible-stream-test",
      null,
      null,
      "GigaChat-3",
      null,
      null,
      null,
      null,
      null,
      null
    );

    const writer = transform.writable.getWriter();
    await writer.write(
      new TextEncoder().encode(
        [
          'data: {"id":"1","object":"chat.completion.chunk","model":"GigaChat","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}',
          "",
        ].join("\n") + "\n"
      )
    );
    await writer.write(
      new TextEncoder().encode(
        [
          'data: {"id":"1","object":"chat.completion.chunk","model":"GigaChat","choices":[{"index":0,"delta":{},"finish_reason":"blacklist"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}',
          "data: [DONE]",
          "",
        ].join("\n") + "\n"
      )
    );
    await writer.close();

    const result = await readAll(transform);
    const chunks = parseSseDataLines(result);

    const finishChunk = chunks.find(
      (c) => (c as { choices?: { finish_reason?: string }[] }).choices?.[0]?.finish_reason
    ) as { choices?: { finish_reason?: string }[] } | undefined;

    assert.ok(finishChunk, "a chunk carrying finish_reason reached the client");
    assert.equal(
      finishChunk?.choices?.[0]?.finish_reason,
      "content_filter",
      "blacklist finish_reason mapped to content_filter on the client SSE"
    );
  });

  it("does not mutate a non-gigachat provider's stream", async () => {
    const transform = createPassthroughStreamWithLogger(
      "openai-compatible-stream-test",
      null,
      null,
      "gpt-4",
      null,
      null,
      null,
      null,
      null,
      null
    );

    const writer = transform.writable.getWriter();
    await writer.write(
      new TextEncoder().encode(
        [
          'data: {"id":"1","object":"chat.completion.chunk","model":"gpt-4","choices":[{"index":0,"delta":{},"finish_reason":"blacklist"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15,"precached_prompt_tokens":42}}',
          "data: [DONE]",
          "",
        ].join("\n") + "\n"
      )
    );
    await writer.close();

    const result = await readAll(transform);
    const chunks = parseSseDataLines(result);
    const chunk = chunks[0] as {
      choices?: { finish_reason?: string }[];
      usage?: { precached_prompt_tokens?: number; prompt_tokens_details?: unknown };
    };

    assert.equal(
      chunk?.choices?.[0]?.finish_reason,
      "blacklist",
      "non-gigachat provider finish_reason is left untouched"
    );
    assert.equal(
      chunk?.usage?.prompt_tokens_details,
      undefined,
      "non-gigachat provider does not gain a synthesized prompt_tokens_details"
    );
  });
});

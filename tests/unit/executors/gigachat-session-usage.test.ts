import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { DefaultExecutor } from "../../../open-sse/executors/default.ts";
import { startMockGigachat, type MockGigachatServer } from "../../fixtures/mock-gigachat-server.js";

const GIGA_NODE_ID = "gigachat-compatible-session";
const OPENAI_NODE_ID = "openai-compatible-session";

type JsonRecord = Record<string, unknown>;

function creds(nodeId: string, baseUrl: string): JsonRecord {
  return {
    apiKey: "mock-key",
    connectionId: nodeId,
    providerSpecificData: { baseUrl: `${baseUrl}/api/v1` },
  };
}

function headerValue(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string
): string | string[] | undefined {
  if (!headers) return undefined;
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match?.[1];
}

describe("T4.3 GigaChat X-Session-ID client-passthrough + precached_prompt_tokens mapping", () => {
  let mock: MockGigachatServer;

  before(async () => {
    mock = await startMockGigachat({ wire: "gigachat", precachedPromptTokens: 42 });
  });

  after(async () => {
    await mock.close();
  });

  it("forwards the client X-Session-ID header to GigaChat when the client sends one", async () => {
    const exec = new DefaultExecutor(GIGA_NODE_ID);
    const { response: res } = await exec.execute({
      model: "GigaChat-3",
      stream: false,
      credentials: creds(GIGA_NODE_ID, mock.url),
      clientHeaders: { "X-Session-ID": "client-session-xyz" },
      body: {
        model: "GigaChat-3",
        messages: [{ role: "user", content: "hi" }],
      },
    });

    assert.equal(res.status, 200);
    assert.equal(
      headerValue(mock.lastRequest?.headers, "x-session-id"),
      "client-session-xyz",
      "client X-Session-ID reached the upstream GigaChat request"
    );
  });

  it("does NOT send X-Session-ID to GigaChat when the client omits it", async () => {
    const exec = new DefaultExecutor(GIGA_NODE_ID);
    const { response: res } = await exec.execute({
      model: "GigaChat-3",
      stream: false,
      credentials: creds(GIGA_NODE_ID, mock.url),
      clientHeaders: {},
      body: {
        model: "GigaChat-3",
        messages: [{ role: "user", content: "hi" }],
      },
    });

    assert.equal(res.status, 200);
    assert.equal(
      headerValue(mock.lastRequest?.headers, "x-session-id"),
      undefined,
      "no X-Session-ID header is generated server-side"
    );
  });

  it("does NOT forward X-Session-ID for an openai-compatible node even when the client sends one", async () => {
    const exec = new DefaultExecutor(OPENAI_NODE_ID);
    const { response: res } = await exec.execute({
      model: "some-model",
      stream: false,
      credentials: creds(OPENAI_NODE_ID, mock.url),
      clientHeaders: { "X-Session-ID": "client-session-xyz" },
      body: {
        model: "some-model",
        messages: [{ role: "user", content: "hi" }],
      },
    });

    assert.equal(res.status, 200);
    assert.equal(
      headerValue(mock.lastRequest?.headers, "x-session-id"),
      undefined,
      "X-Session-ID is GigaChat-specific and must not leak to openai-compatible nodes"
    );
  });

  it("maps GigaChat precached_prompt_tokens onto usage.prompt_tokens_details.cached_tokens", async () => {
    const exec = new DefaultExecutor(GIGA_NODE_ID);
    const { response: res } = await exec.execute({
      model: "GigaChat-3",
      stream: false,
      credentials: creds(GIGA_NODE_ID, mock.url),
      body: {
        model: "GigaChat-3",
        messages: [{ role: "user", content: "hi" }],
      },
    });

    assert.equal(res.status, 200);
    const json = (await res.json()) as {
      usage: { prompt_tokens_details?: { cached_tokens?: number } };
    };
    assert.equal(
      json.usage.prompt_tokens_details?.cached_tokens,
      42,
      "precached_prompt_tokens surfaced as prompt_tokens_details.cached_tokens"
    );
  });
});

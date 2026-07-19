/**
 * Unit + e2e tests for GigaChat v1 `finish_reason: "blacklist"` mapping onto the
 * OpenAI equivalent `content_filter`. Official v1 API: finish_reason is one of
 * stop|length|function_call|blacklist|error. Our v2 path already mapped
 * blacklist -> content_filter (gigachatShared.ts::mapGigaChatV2FinishReason); v1
 * did not.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mapGigaChatV1BlacklistFinishReason,
  mapGigaChatV2FinishReason,
} from "../../open-sse/executors/gigachatShared.ts";
import { DefaultExecutor } from "../../open-sse/executors/default.ts";
import { startMockGigachat, type MockGigachatServer } from "../fixtures/mock-gigachat-server.js";

describe("mapGigaChatV1BlacklistFinishReason (unit)", () => {
  it("maps blacklist to content_filter", () => {
    assert.equal(mapGigaChatV1BlacklistFinishReason("blacklist"), "content_filter");
  });

  it("leaves error untouched (invalid function args, no clean OpenAI equivalent)", () => {
    assert.equal(mapGigaChatV1BlacklistFinishReason("error"), "error");
  });

  it("leaves stop/length/function_call untouched", () => {
    assert.equal(mapGigaChatV1BlacklistFinishReason("stop"), "stop");
    assert.equal(mapGigaChatV1BlacklistFinishReason("length"), "length");
    assert.equal(mapGigaChatV1BlacklistFinishReason("function_call"), "function_call");
  });

  it("returns undefined for non-string input", () => {
    assert.equal(mapGigaChatV1BlacklistFinishReason(undefined), undefined);
    assert.equal(mapGigaChatV1BlacklistFinishReason(null), undefined);
  });
});

describe("mapGigaChatV2FinishReason (regression guard — must stay unchanged)", () => {
  it("still maps blacklist/response_blacklist/request_* to content_filter", () => {
    assert.equal(mapGigaChatV2FinishReason("blacklist"), "content_filter");
    assert.equal(mapGigaChatV2FinishReason("response_blacklist"), "content_filter");
    assert.equal(mapGigaChatV2FinishReason("request_blacklist"), "content_filter");
  });

  it("still maps function_call to tool_calls", () => {
    assert.equal(mapGigaChatV2FinishReason("function_call"), "tool_calls");
  });

  it("still passes through stop/length unchanged", () => {
    assert.equal(mapGigaChatV2FinishReason("stop"), "stop");
    assert.equal(mapGigaChatV2FinishReason("length"), "length");
  });
});

describe("v1 non-stream: finish_reason blacklist -> content_filter (mock upstream)", () => {
  const NODE_ID = "gigachat-compatible-blacklist";
  let mock: MockGigachatServer;

  before(async () => {
    mock = await startMockGigachat({ wire: "gigachat", nonStreamFinishReason: "blacklist" });
  });

  after(async () => {
    await mock.close();
  });

  it("maps a blacklist non-stream response to content_filter end-to-end", async () => {
    const exec = new DefaultExecutor(NODE_ID);
    const { response: res } = await exec.execute({
      model: "GigaChat-3",
      stream: false,
      credentials: {
        apiKey: "mock-key",
        connectionId: NODE_ID,
        providerSpecificData: { baseUrl: `${mock.url}/api/v1` },
      },
      body: {
        model: "GigaChat-3",
        messages: [{ role: "user", content: "hi" }],
      },
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { choices: { finish_reason: string }[] };
    assert.equal(json.choices[0].finish_reason, "content_filter");
  });
});

describe("v1 non-stream: finish_reason stop/function_call unaffected (mock upstream)", () => {
  const NODE_ID = "gigachat-compatible-blacklist-baseline";
  let mock: MockGigachatServer;

  before(async () => {
    mock = await startMockGigachat({ wire: "gigachat" });
  });

  after(async () => {
    await mock.close();
  });

  it("leaves a plain stop response untouched", async () => {
    const exec = new DefaultExecutor(NODE_ID);
    const { response: res } = await exec.execute({
      model: "GigaChat-3",
      stream: false,
      credentials: {
        apiKey: "mock-key",
        connectionId: NODE_ID,
        providerSpecificData: { baseUrl: `${mock.url}/api/v1` },
      },
      body: {
        model: "GigaChat-3",
        messages: [{ role: "user", content: "hi" }],
      },
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { choices: { finish_reason: string }[] };
    assert.equal(json.choices[0].finish_reason, "stop");
  });
});

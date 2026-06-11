// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-chatcore-translation-"));
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const auth = await import("../../src/sse/services/auth.ts");
const pgModule = await import("../../src/lib/db/postgres.ts");
const callLogsDb = await import("../../src/lib/usage/callLogs.ts");
const readCacheDb = await import("../../src/lib/db/readCache.ts");

const MUTABLE_TEST_TABLES = [
  "provider_connections",
  "api_keys",
  "key_value",
  "call_logs",
  "semantic_cache",
  "usage_history",
  "model_combo_mappings",
  "combos",
];

async function purgePostgresTables() {
  const schema = pgModule.getSchema();
  const tables = MUTABLE_TEST_TABLES.map((t) => `${schema}.${t}`).join(", ");
  await pgModule.query(`TRUNCATE ${tables} CASCADE`);
}
const { invalidateCacheControlSettingsCache } =
  await import("../../src/lib/cacheControlSettings.ts");
const { clearCache, getCachedResponse, generateSignature } =
  await import("../../src/lib/semanticCache.ts");
const { clearIdempotency } = await import("../../src/lib/idempotencyLayer.ts");
const { getPendingRequests, clearPendingRequests } =
  await import("../../src/lib/usage/usageHistory.ts");
const { clearInflight } = await import("../../open-sse/services/requestDedup.ts");
const {
  buildAccountSemaphoreKey,
  getStats: getAccountSemaphoreStats,
  resetAll: resetAccountSemaphores,
} = await import("../../open-sse/services/accountSemaphore.ts");
const { getExecutor } = await import("../../open-sse/executors/index.ts");
const { clearModelLock, isModelLocked } =
  await import("../../open-sse/services/accountFallback.ts");
function saveModelsDevCapabilities(_caps: unknown): void {}
function clearModelsDevCapabilities(): void {}
const {
  getBackgroundDegradationConfig,
  setBackgroundDegradationConfig,
  resetStats: resetBackgroundStats,
} = await import("../../open-sse/services/backgroundTaskDetector.ts");
const { getCallLogs, getCallLogById } = await import("../../src/lib/usage/callLogs.ts");
const {
  handleChatCore,
  clearUpstreamProxyConfigCache,
  buildStreamingResponseHeaders,
} = await import("../../open-sse/handlers/chatCore.ts");
const { resetPayloadRulesConfigForTests, setPayloadRulesConfig } =
  await import("../../open-sse/services/payloadRules.ts");
const { FORMATS } = await import("../../open-sse/translator/formats.ts");
const { register, getRequestTranslator } = await import("../../open-sse/translator/registry.ts");

const originalFetch = globalThis.fetch;
const originalResponsesToOpenAI = getRequestTranslator(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI);
const originalSetTimeout = globalThis.setTimeout;
const originalBackgroundConfig = getBackgroundDegradationConfig();
const originalCallLogPipelineCaptureStreamChunks =
  process.env.CALL_LOG_PIPELINE_CAPTURE_STREAM_CHUNKS;

function noopLog() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function restorePipelineCaptureEnv() {
  if (originalCallLogPipelineCaptureStreamChunks === undefined) {
    delete process.env.CALL_LOG_PIPELINE_CAPTURE_STREAM_CHUNKS;
  } else {
    process.env.CALL_LOG_PIPELINE_CAPTURE_STREAM_CHUNKS =
      originalCallLogPipelineCaptureStreamChunks;
  }
}

function toPlainHeaders(headers) {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, value == null ? "" : String(value)])
  );
}

function buildOpenAIResponse(stream, text = "ok") {
  if (stream) {
    return new Response(
      `data: ${JSON.stringify({
        id: "chatcmpl-stream",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant", content: text } }],
      })}\n\ndata: [DONE]\n\n`,
      {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }
    );
  }

  return new Response(
    JSON.stringify({
      id: "chatcmpl-json",
      object: "chat.completion",
      model: "gpt-4o-mini",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 4,
        completion_tokens: 2,
        total_tokens: 6,
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}

function buildClaudeResponse(stream, text = "ok") {
  if (stream) {
    return new Response(
      [
        "event: message_start",
        `data: ${JSON.stringify({
          type: "message_start",
          message: {
            id: "msg_stream",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-6",
            usage: { input_tokens: 12, output_tokens: 0 },
          },
        })}`,
        "",
        "event: content_block_start",
        `data: ${JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        })}`,
        "",
        "event: content_block_delta",
        `data: ${JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text },
        })}`,
        "",
        "event: message_delta",
        `data: ${JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 3 },
        })}`,
        "",
        "event: message_stop",
        `data: ${JSON.stringify({ type: "message_stop" })}`,
        "",
      ].join("\n"),
      {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }
    );
  }

  return new Response(
    JSON.stringify({
      id: "msg_json",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 12,
        output_tokens: 3,
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}

function buildResponsesResponse(text = "ok") {
  return new Response(
    JSON.stringify({
      id: "resp_123",
      object: "response",
      status: "completed",
      model: "gpt-5.1-codex",
      output: [
        {
          id: "msg_123",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text, annotations: [] }],
        },
      ],
      usage: {
        input_tokens: 4,
        output_tokens: 2,
        total_tokens: 6,
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}

function capabilityEntry(limitContext) {
  return {
    tool_call: true,
    reasoning: false,
    attachment: false,
    structured_output: true,
    temperature: true,
    modalities_input: JSON.stringify(["text"]),
    modalities_output: JSON.stringify(["text"]),
    knowledge_cutoff: null,
    release_date: null,
    last_updated: null,
    status: null,
    family: null,
    open_weights: false,
    limit_context: limitContext,
    limit_input: limitContext,
    limit_output: 4096,
    interleaved_field: null,
  };
}

function hasCacheControl(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some((item) => hasCacheControl(item));
  }
  if (Object.hasOwn(value, "cache_control")) return true;
  return Object.values(value).some((item) => hasCacheControl(item));
}

function collectTextBlocks(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((message) =>
    Array.isArray(message.content) ? message.content.filter((block) => block?.type === "text") : []
  );
}

async function resetStorage() {
  clearUpstreamProxyConfigCache();
  resetPayloadRulesConfigForTests();
  register(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, originalResponsesToOpenAI, null);
  invalidateCacheControlSettingsCache();
  clearCache();
  clearIdempotency();
  clearInflight();
  clearModelsDevCapabilities();
  setBackgroundDegradationConfig(originalBackgroundConfig);
  resetBackgroundStats();
  globalThis.setTimeout = originalSetTimeout;
  await callLogsDb.drainCallLogWrites();
  await purgePostgresTables();
  core.resetDbInstance();
  readCacheDb.invalidateDbCache();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function waitFor(fn, timeoutMs = 1500) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await fn();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

async function waitForAsyncSideEffects() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 10));
}

async function getLatestCallLog() {
  const rows = await getCallLogs({ limit: 5 });
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return getCallLogById(rows[0].id);
}

async function invokeChatCore({
  body,
  provider = "openai",
  model = "gpt-4o-mini",
  endpoint = "/v1/chat/completions",
  accept = "application/json",
  userAgent = "unit-test",
  credentials,
  apiKeyInfo = null,
  responseFormat = "openai",
  responseFactory,
  isCombo = false,
  comboStrategy = null,
  requestHeaders = {},
  connectionId = null,
  onCredentialsRefreshed = null,
  onRequestSuccess = null,
}: any = {}) {
  const calls: any[] = [];

  globalThis.fetch = async (url, init = {}) => {
    const headers = toPlainHeaders(init.headers);
    const captured = {
      url: String(url),
      method: init.method || "GET",
      headers,
      body: init.body ? JSON.parse(String(init.body)) : null,
    };
    calls.push(captured);

    if (responseFactory) {
      return responseFactory(captured, calls);
    }

    const upstreamStream = String(headers.Accept || headers.accept || "")
      .toLowerCase()
      .includes("text/event-stream");
    if (responseFormat === "claude") return buildClaudeResponse(upstreamStream);
    if (responseFormat === "openai-responses") return buildResponsesResponse();
    return buildOpenAIResponse(upstreamStream);
  };

  try {
    const requestBody = structuredClone(body);
    const result = await handleChatCore({
      body: requestBody,
      modelInfo: { provider, model, extendedContext: false },
      credentials: credentials || {
        apiKey: "sk-test",
        providerSpecificData: {},
      },
      log: noopLog(),
      clientRawRequest: {
        endpoint,
        body: structuredClone(body),
        headers: new Headers({ accept, ...requestHeaders }),
      },
      connectionId,
      apiKeyInfo,
      userAgent,
      isCombo,
      comboStrategy,
      onCredentialsRefreshed,
      onRequestSuccess,
    } as any);
    await waitForAsyncSideEffects();

    return { result, calls, call: calls.at(-1) };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test.afterEach(async () => {
  globalThis.fetch = originalFetch;
  restorePipelineCaptureEnv();
  clearPendingRequests();
  resetAccountSemaphores();
  await waitForAsyncSideEffects();
  await resetStorage();
});

test.after(async () => {
  globalThis.fetch = originalFetch;
  restorePipelineCaptureEnv();
  clearPendingRequests();
  resetAccountSemaphores();
  await waitForAsyncSideEffects();
  await resetStorage();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("chatCore times out upstream execution before provider response headers", async () => {
  const executor = getExecutor("openai");
  const originalGetTimeoutMs = executor.getTimeoutMs?.bind(executor);
  executor.getTimeoutMs = () => 200;

  const connectionId = "upstream-start-timeout";
  const body = {
    model: "gpt-4o-mini",
    stream: false,
    messages: [{ role: "user", content: "never returns" }],
  };
  const fetchSignals: AbortSignal[] = [];
  globalThis.fetch = async (_url, init = {}) => {
    if (init.signal instanceof AbortSignal) fetchSignals.push(init.signal);
    return new Promise(() => {});
  };

  try {
    const invocation = handleChatCore({
      body: structuredClone(body),
      modelInfo: { provider: "openai", model: "gpt-4o-mini", extendedContext: false },
      credentials: {
        apiKey: "sk-test",
        providerSpecificData: {},
      },
      log: noopLog(),
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: structuredClone(body),
        headers: new Headers({ accept: "application/json" }),
      },
      connectionId,
      userAgent: "unit-test",
    } as any);

    const pendingDetail = (await waitFor(
      () =>
        Object.values(getPendingRequests().details[connectionId] || {}).find(
          (detail: any) => detail?.providerRequest
        ),
      150
    )) as any;
    assert.equal(pendingDetail?.providerRequest?.model, "gpt-4o-mini");
    assert.deepEqual(pendingDetail?.providerRequest?.messages, body.messages);

    const result = await invocation;
    await waitForAsyncSideEffects();

    assert.equal(result.success, false);
    assert.equal(result.status, 504);
    assert.equal(fetchSignals[0]?.aborted, true);
    assert.equal(getPendingRequests().details[connectionId], undefined);
  } finally {
    if (originalGetTimeoutMs) executor.getTimeoutMs = originalGetTimeoutMs;
    globalThis.fetch = originalFetch;
  }
});



test("chatCore honors providerSpecificData.apiType for legacy openai-compatible providers", async () => {
  const { call, result } = await invokeChatCore({
    provider: "openai-compatible-sp-openai",
    model: "gpt-5.4",
    endpoint: "/v1/chat/completions",
    credentials: {
      apiKey: "sk-test",
      providerSpecificData: {
        apiType: "responses",
        baseUrl: "https://proxy.example.com/v1",
        prefix: "sp-openai",
      },
    },
    body: {
      model: "gpt-5.4",
      stream: false,
      messages: [{ role: "user", content: "Reply with OK only." }],
      max_tokens: 64,
    },
    responseFormat: "openai-responses",
  });

  const payload = (await result.response.json()) as any;
  assert.equal(result.success, true);
  assert.match(call.url, /\/responses$/);
  assert.ok(call.body.input);
  assert.equal("messages" in call.body, false);
  assert.equal(payload.choices[0].message.content, "ok");
});



test("chatCore applies payload rules after translating Responses input into Chat payloads", async () => {
  setPayloadRulesConfig({
    default: [
      {
        models: [{ name: "gpt-*", protocol: "openai" }],
        params: {
          "messages.0.metadata.routeTag": "feature-110",
        },
      },
    ],
    override: [
      {
        models: [{ name: "gpt-*", protocol: "openai" }],
        params: {
          temperature: 0.25,
        },
      },
    ],
    filter: [],
    defaultRaw: [],
  });

  const { call, result } = await invokeChatCore({
    provider: "openai",
    model: "gpt-4o-mini",
    endpoint: "/v1/responses",
    body: {
      model: "gpt-4o-mini",
      stream: false,
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
      ],
    },
    responseFormat: "openai",
  });

  assert.equal(result.success, true);
  assert.equal(call.body.temperature, 0.25);
  assert.equal(call.body.messages[0].metadata.routeTag, "feature-110");
  assert.equal(call.body.messages[0].role, "user");
});


// Fix #2468: normalizeClaudeUpstreamMessages() now runs on the pure Claude passthrough
// path too. It extracts role:"system" messages into the top-level system parameter,
// strips empty text blocks, converts inline document blocks (no url/data) to text, and
// drops unknown block types (e.g. future_block). tool_result blocks are preserved via
// preserveToolResultBlocks:true.


// Fix #2468: normalizeClaudeUpstreamMessages() runs on the CC-compatible bridge path too
// (preserveClaudeMessages=true). Same normalization: system-role → top-level system,
// empty text stripped, document→text, future_block dropped, tool_result preserved.









test("chatCore preserves reasoning_effort for assistant-prefill OpenAI-compatible requests", async () => {
  const { call, result } = await invokeChatCore({
    provider: "openai-compatible-aio",
    model: "glm-5.1",
    endpoint: "/v1/chat/completions",
    body: {
      model: "aio/glm-5.1",
      messages: [
        { role: "user", content: "draft the answer" },
        { role: "assistant", content: "<thinking>" },
      ],
      reasoning_effort: "xhigh",
      stream: true,
    },
    responseFormat: "openai",
  });

  assert.equal(result.success, true);
  assert.equal(call.body.model, "glm-5.1");
  assert.equal(call.body.reasoning_effort, "xhigh");
});

test("chatCore logs chat completions endpoint as OpenAI protocol", async () => {
  const { call, result } = await invokeChatCore({
    provider: "openrouter",
    model: "deepseek/deepseek-v4-pro",
    endpoint: "/v1/chat/completions",
    body: {
      model: "openrouter/deepseek/deepseek-v4-pro",
      messages: [{ role: "user", content: "Human: Hi" }],
      temperature: 1,
      max_tokens: 64000,
      stream: false,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.9,
    },
    responseFormat: "openai",
  });

  assert.equal(result.success, true);
  assert.equal(call.body.model, "deepseek/deepseek-v4-pro");

  const logEntry = await waitFor(getLatestCallLog);
  assert.ok(logEntry, "expected call log to be persisted");
  assert.equal(logEntry.path, "/v1/chat/completions");
  assert.equal(logEntry.sourceFormat, FORMATS.OPENAI);
});

test("chatCore surfaces translation errors with explicit status codes", async () => {
  register(
    FORMATS.OPENAI_RESPONSES,
    FORMATS.OPENAI,
    () => {
      const error = new Error("responses translator rejected the payload");
      error.statusCode = 409;
      throw error;
    },
    null
  );

  const { result } = await invokeChatCore({
    provider: "openai",
    model: "gpt-4o-mini",
    endpoint: "/v1/responses",
    body: {
      model: "gpt-4o-mini",
      input: "hello",
    },
  });

  assert.equal(result.success, false);
  assert.equal(result.status, 409);
  assert.equal(result.error, "responses translator rejected the payload");
});

test("chatCore surfaces typed translation errors with the declared error type", async () => {
  register(
    FORMATS.OPENAI_RESPONSES,
    FORMATS.OPENAI,
    () => {
      const error = new Error("typed translator failure");
      error.statusCode = 422;
      error.errorType = "unsupported_feature";
      throw error;
    },
    null
  );

  const { result } = await invokeChatCore({
    provider: "openai",
    model: "gpt-4o-mini",
    endpoint: "/v1/responses",
    body: {
      model: "gpt-4o-mini",
      input: "hello",
    },
  });

  assert.equal(result.success, false);
  assert.equal(result.status, 422);

  const payload = (await result.response.json()) as any;
  assert.equal(payload.error.type, "unsupported_feature");
  assert.equal(payload.error.code, "unsupported_feature");
});

test("chatCore returns 500 when translation throws a generic error", async () => {
  register(
    FORMATS.OPENAI_RESPONSES,
    FORMATS.OPENAI,
    () => {
      throw new Error("unexpected translator crash");
    },
    null
  );

  const { result } = await invokeChatCore({
    provider: "openai",
    model: "gpt-4o-mini",
    endpoint: "/v1/responses",
    body: {
      model: "gpt-4o-mini",
      input: "hello",
    },
  });

  assert.equal(result.success, false);
  assert.equal(result.status, 500);
  assert.equal(result.error, "unexpected translator crash");
});


test("chatCore uses the native executor when no upstream proxy mode is enabled", async () => {
  const { call } = await invokeChatCore({
    provider: "openai",
    model: "gpt-4o-mini",
    body: {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hello" }],
    },
    responseFormat: "openai",
  });

  assert.match(call.url, /^https:\/\/api\.openai\.com\/v1\/chat\/completions$/);
});





test("chatCore serves a cached idempotent response without hitting the provider twice", async () => {
  const sharedHeaders = { "idempotency-key": "unit-idempotent-key" };

  const first = await invokeChatCore({
    provider: "openai",
    model: "gpt-4o-mini",
    requestHeaders: sharedHeaders,
    body: {
      model: "gpt-4o-mini",
      stream: false,
      messages: [{ role: "user", content: "repeat this safely" }],
    },
    responseFormat: "openai",
  });

  const second = await invokeChatCore({
    provider: "openai",
    model: "gpt-4o-mini",
    requestHeaders: sharedHeaders,
    body: {
      model: "gpt-4o-mini",
      stream: false,
      messages: [{ role: "user", content: "repeat this safely" }],
    },
    responseFormat: "openai",
  });

  assert.equal(first.calls.length, 1);
  assert.equal(second.calls.length, 0);
  assert.equal(second.result.success, true);
  assert.equal(second.result.response.headers.get("X-OmniRoute-Idempotent"), "true");

  const payload = (await second.result.response.json()) as any;
  assert.equal(payload.choices[0].message.content, "ok");
});

test("chatCore returns a semantic cache HIT for repeated deterministic requests", async () => {
  let upstreamHits = 0;
  const sharedBody = {
    model: "gpt-4o-mini",
    stream: false,
    temperature: 0,
    messages: [{ role: "user", content: "cache this exact answer" }],
  };

  const first = await invokeChatCore({
    provider: "openai",
    model: "gpt-4o-mini",
    body: sharedBody,
    responseFormat: "openai",
    responseFactory() {
      upstreamHits += 1;
      return buildOpenAIResponse(false, "cached-once");
    },
  });

  const second = await invokeChatCore({
    provider: "openai",
    model: "gpt-4o-mini",
    body: sharedBody,
    responseFormat: "openai",
    responseFactory() {
      upstreamHits += 1;
      return buildOpenAIResponse(false, "should-not-run");
    },
  });

  assert.equal(first.calls.length, 1);
  assert.equal(first.result.response.headers.get("X-OmniRoute-Cache"), "MISS");
  assert.equal(second.calls.length, 0);
  assert.equal(second.result.response.headers.get("X-OmniRoute-Cache"), "HIT");
  assert.equal(upstreamHits, 1);

  const payload = (await second.result.response.json()) as any;
  assert.equal(payload.choices[0].message.content, "cached-once");

  await waitForAsyncSideEffects();
  const semanticLog = await waitFor(async () => {
    const rows = await getCallLogs({ limit: 10 });
    const hit = rows.find((row) => row.cacheSource === "semantic");
    if (!hit) return null;
    return await getCallLogById(hit.id);
  });
  assert.ok(semanticLog, "expected semantic cache HIT to be persisted in call logs");
  assert.equal(semanticLog.cacheSource, "semantic");
  assert.equal(semanticLog.path, "/v1/chat/completions");
  assert.equal(semanticLog.status, 200);
});

test("chatCore skips semantic cache when disabled in settings", async () => {
  await settingsDb.updateSettings({ semanticCacheEnabled: false });

  let upstreamHits = 0;
  const sharedBody = {
    model: "gpt-4o-mini",
    stream: false,
    temperature: 0,
    messages: [{ role: "user", content: "do not reuse this response locally" }],
  };

  const first = await invokeChatCore({
    provider: "openai",
    model: "gpt-4o-mini",
    body: sharedBody,
    responseFormat: "openai",
    responseFactory() {
      upstreamHits += 1;
      return buildOpenAIResponse(false, `fresh-${upstreamHits}`);
    },
  });

  const second = await invokeChatCore({
    provider: "openai",
    model: "gpt-4o-mini",
    body: sharedBody,
    responseFormat: "openai",
    responseFactory() {
      upstreamHits += 1;
      return buildOpenAIResponse(false, `fresh-${upstreamHits}`);
    },
  });

  assert.equal(first.calls.length, 1);
  assert.equal(second.calls.length, 1);
  assert.equal(upstreamHits, 2);
  assert.equal(first.result.response.headers.get("X-OmniRoute-Cache"), "MISS");
  assert.equal(second.result.response.headers.get("X-OmniRoute-Cache"), "MISS");

  const payload = (await second.result.response.json()) as any;
  assert.equal(payload.choices[0].message.content, "fresh-2");
});


test("chatCore does not expose provider request credentials in non-stream response headers", async () => {
  const { result } = await invokeChatCore({
    provider: "openai",
    model: "gpt-4o-mini",
    body: {
      model: "gpt-4o-mini",
      stream: false,
      messages: [{ role: "user", content: "hide provider credentials" }],
    },
    responseFormat: "openai",
  });

  assert.equal(result.success, true);
  assert.equal(result.response.headers.get("authorization"), null);
  assert.equal(result.response.headers.get("x-api-key"), null);
  assert.equal(result.response.headers.get("Content-Type"), "application/json");
  assert.equal(result.response.headers.get("X-OmniRoute-Cache"), "MISS");
});

test("chatCore normalizes tool finish reasons and estimates usage when upstream omits it", async () => {
  const { result } = await invokeChatCore({
    provider: "openai",
    model: "gpt-4o-mini",
    body: {
      model: "gpt-4o-mini",
      stream: false,
      messages: [{ role: "user", content: "call the tool" }],
    },
    responseFormat: "openai",
    responseFactory() {
      return new Response(
        JSON.stringify({
          id: "chatcmpl_tool_no_usage",
          object: "chat.completion",
          model: "gpt-4o-mini",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "lookup_weather",
                      arguments: '{"city":"Sao Paulo"}',
                    },
                  },
                ],
              },
              finish_reason: "stop",
            },
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    },
  });

  const payload = (await result.response.json()) as any;
  assert.equal(result.success, true);
  assert.equal(payload.choices[0].finish_reason, "tool_calls");
  assert.ok(payload.usage.total_tokens > 0);
  assert.ok(payload.usage.prompt_tokens > 0);
});

test("chatCore bypasses Claude CLI warmup probes before touching the provider", async () => {
  const { calls, result } = await invokeChatCore({
    model: "gpt-5",
    userAgent: "claude-cli/2.1.89",
    body: {
      model: "gpt-5",
      stream: false,
      messages: [{ role: "user", content: [{ type: "text", text: "Warmup" }] }],
    },
  });

  const payload = (await result.response.json()) as any;
  assert.equal(result.success, true);
  assert.equal(calls.length, 0);
  assert.match(payload.choices[0].message.content, /CLI Command Execution/);
});

test("chatCore redirects background utility tasks to a cheaper mapped model", async () => {
  setBackgroundDegradationConfig({
    enabled: true,
    degradationMap: {
      ...originalBackgroundConfig.degradationMap,
      "gpt-5": "gpt-5-mini",
    },
    detectionPatterns: ["generate a title"],
  });

  const { call, result } = await invokeChatCore({
    provider: "openai",
    model: "gpt-5",
    body: {
      model: "gpt-5",
      max_tokens: 16,
      messages: [
        { role: "system", content: "Generate a title for the conversation." },
        { role: "user", content: "Discuss release notes" },
      ],
    },
  });

  assert.equal(result.success, true);
  assert.equal(call.body.model, "gpt-5-mini");
});






test("chatCore 429 lets account fallback apply the configured resilience cooldown", async () => {
  await settingsDb.updateSettings({
    resilienceSettings: {
      connectionCooldown: {
        apikey: {
          baseCooldownMs: 1000,
          useUpstreamRetryHints: false,
          maxBackoffSteps: 3,
        },
      },
    },
  });

  const connection = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "resilience-429",
    apiKey: "sk-resilience-429",
    isActive: true,
    providerSpecificData: {},
  });

  const { result } = await invokeChatCore({
    provider: "openai",
    model: "gpt-4o-mini",
    connectionId: connection.id,
    body: {
      model: "gpt-4o-mini",
      stream: false,
      messages: [{ role: "user", content: "rate limit me" }],
    },
    responseFactory() {
      return new Response(JSON.stringify({ error: { message: "too many requests" } }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  const afterCore = await providersDb.getProviderConnectionById((connection as any).id);
  assert.equal(result.success, false);
  assert.equal(result.status, 429);
  assert.equal((afterCore as any).rateLimitedUntil, undefined);

  const fallback = await auth.markAccountUnavailable(
    (connection as any).id,
    result.status,
    result.error,
    "openai",
    "gpt-4o-mini"
  );
  const afterFallback = await providersDb.getProviderConnectionById((connection as any).id);
  const cooldownRemaining = Number((afterFallback as any).rateLimitedUntil) - Date.now();

  assert.equal(fallback.shouldFallback, true);
  assert.equal(fallback.cooldownMs, 1000);
  assert.equal((afterFallback as any).testStatus, "unavailable");
  assert.ok(cooldownRemaining > 0 && cooldownRemaining <= 2_000);
});

test("chatCore falls back to the next family model when the requested model is unavailable", async () => {
  const { calls, result } = await invokeChatCore({
    provider: "openai",
    model: "gpt-5.1",
    body: {
      model: "gpt-5.1",
      stream: false,
      messages: [{ role: "user", content: "fallback on model unavailable" }],
    },
    responseFactory(_captured, seenCalls) {
      if (seenCalls.length === 1) {
        return new Response(JSON.stringify({ error: { message: "model not found" } }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      return buildOpenAIResponse(false, "family fallback ok");
    },
  });

  const payload = (await result.response.json()) as any;
  assert.equal(result.success, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.model, "gpt-5.1-mini");
  assert.equal(payload.choices[0].message.content, "family fallback ok");
});

test("chatCore falls back to a larger-context sibling when the request overflows context", async () => {
  saveModelsDevCapabilities({
    unknown: {
      "gpt-5": capabilityEntry(128_000),
      "gpt-5-mini": capabilityEntry(64_000),
      "gpt-4o": capabilityEntry(256_000),
    },
  });

  const { calls, result } = await invokeChatCore({
    provider: "openai",
    model: "gpt-5",
    body: {
      model: "gpt-5",
      stream: false,
      messages: [{ role: "user", content: "recover from context overflow" }],
    },
    responseFactory(_captured, seenCalls) {
      if (seenCalls.length === 1) {
        return new Response(JSON.stringify({ error: { message: "maximum context exceeded" } }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      return buildOpenAIResponse(false, "larger context fallback");
    },
  });

  const payload = (await result.response.json()) as any;
  assert.equal(result.success, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.model, "gpt-4o");
  assert.equal(payload.choices[0].message.content, "larger context fallback");
});

test("chatCore parses upstream SSE payloads for non-streaming requests", async () => {
  const { result } = await invokeChatCore({
    provider: "openai",
    model: "gpt-4o-mini",
    body: {
      model: "gpt-4o-mini",
      stream: false,
      messages: [{ role: "user", content: "parse sse" }],
    },
    responseFactory() {
      return buildOpenAIResponse(true, "sse json");
    },
  });

  const payload = (await result.response.json()) as any;
  assert.equal(result.success, true);
  assert.equal(payload.choices[0].message.content, "sse json");
});

test("chatCore rejects malformed non-streaming SSE payloads", async () => {
  const { result } = await invokeChatCore({
    provider: "openai",
    model: "gpt-4o-mini",
    body: {
      model: "gpt-4o-mini",
      stream: false,
      messages: [{ role: "user", content: "bad sse" }],
    },
    responseFactory() {
      return new Response("data: not-json\n\ndata: [DONE]\n\n", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });

  assert.equal(result.success, false);
  assert.equal(result.status, 502);
  assert.match(result.error, /Invalid SSE response/);
});

test("chatCore rejects malformed non-streaming JSON payloads", async () => {
  const { result } = await invokeChatCore({
    provider: "openai",
    model: "gpt-4o-mini",
    body: {
      model: "gpt-4o-mini",
      stream: false,
      messages: [{ role: "user", content: "return valid json" }],
    },
    responseFactory() {
      return new Response("{oops", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  assert.equal(result.success, false);
  assert.equal(result.status, 502);
  assert.equal(result.error, "Invalid JSON response from provider");
});

test("chatCore falls back after an empty-content success response", async () => {
  const { calls, result } = await invokeChatCore({
    provider: "openai",
    model: "gpt-5.1",
    body: {
      model: "gpt-5.1",
      stream: false,
      messages: [{ role: "user", content: "recover from empty content" }],
    },
    responseFactory(_captured, seenCalls) {
      if (seenCalls.length === 1) {
        return new Response(
          JSON.stringify({
            id: "chatcmpl-empty",
            object: "chat.completion",
            model: "gpt-5.1",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "" },
                finish_reason: "stop",
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
      return buildOpenAIResponse(false, "empty-content fallback ok");
    },
  });

  const payload = (await result.response.json()) as any;
  assert.equal(result.success, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.model, "gpt-5.1-mini");
  assert.equal(payload.choices[0].message.content, "empty-content fallback ok");
});

test("chatCore returns a gateway error when the empty-content fallback responds with invalid JSON", async () => {
  const { result, calls } = await invokeChatCore({
    provider: "openai",
    model: "gpt-5.1",
    body: {
      model: "gpt-5.1",
      stream: false,
      messages: [{ role: "user", content: "recover from empty content" }],
    },
    responseFactory(_captured, seenCalls) {
      if (seenCalls.length === 1) {
        return new Response(
          JSON.stringify({
            id: "chatcmpl-empty",
            object: "chat.completion",
            model: "gpt-5.1",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "" },
                finish_reason: "stop",
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      return new Response("{invalid-json", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  assert.equal(result.success, false);
  assert.equal(result.status, 502);
  assert.equal(result.error, "Provider returned empty content");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.model, "gpt-5.1-mini");
});


test("chatCore serves emergency fallback responses for budget errors on non-streaming requests", async () => {
  const { calls, result } = await invokeChatCore({
    provider: "openai",
    model: "gpt-4o-mini",
    body: {
      model: "gpt-4o-mini",
      stream: false,
      max_tokens: 9000,
      messages: [{ role: "user", content: "keep the request alive after budget exhaustion" }],
    },
    responseFactory(_captured, seenCalls) {
      if (seenCalls.length === 1) {
        return new Response(
          JSON.stringify({
            error: { message: "insufficient funds on this account" },
          }),
          {
            status: 402,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      return buildOpenAIResponse(false, "served by emergency fallback");
    },
  });

  const payload = (await result.response.json()) as any;

  assert.equal(result.success, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.model, "openai/gpt-oss-120b");
  assert.equal(calls[1].body.max_tokens, 4096);
  assert.equal(payload.choices[0].message.content, "served by emergency fallback");
});

test("chatCore injects progress events into streaming responses when requested", async () => {
  const { result } = await invokeChatCore({
    provider: "openai",
    model: "gpt-4o-mini",
    accept: "text/event-stream",
    requestHeaders: { "x-omniroute-progress": "true" },
    body: {
      model: "gpt-4o-mini",
      stream: true,
      messages: [{ role: "user", content: "stream with progress" }],
    },
    responseFactory() {
      return buildOpenAIResponse(true, "streamed");
    },
  });

  const streamText = await result.response.text();
  assert.equal(result.success, true);
  assert.equal(result.response.headers.get("X-OmniRoute-Progress"), "enabled");
  assert.match(streamText, /event: progress/);
});

test("chatCore emits final SSE metadata comments before [DONE] on streaming responses", async () => {
  const { result } = await invokeChatCore({
    provider: "openai",
    model: "gpt-4o-mini",
    accept: "text/event-stream",
    body: {
      model: "gpt-4o-mini",
      stream: true,
      messages: [{ role: "user", content: "stream metadata" }],
    },
    responseFactory() {
      return buildOpenAIResponse(true, "streamed");
    },
  });

  const streamText = await result.response.text();

  assert.equal(result.success, true);
  assert.equal(result.response.headers.get("X-OmniRoute-Provider"), "openai");
  assert.equal(result.response.headers.get("X-OmniRoute-Model"), "gpt-4o-mini");
  assert.match(streamText, /: x-omniroute-response-cost=\d+\.\d{10}/);
  assert.match(streamText, /: x-omniroute-tokens-in=\d+/);
  assert.match(streamText, /: x-omniroute-tokens-out=\d+/);
  assert.ok(
    streamText.indexOf(": x-omniroute-response-cost=") < streamText.indexOf("data: [DONE]")
  );
});

test("buildStreamingResponseHeaders drops upstream compression and framing headers", () => {
  const headers = new Headers(
    buildStreamingResponseHeaders(
      new Headers({
        "Content-Type": "text/event-stream",
        "Content-Encoding": "gzip",
        "Content-Length": "999",
        "Transfer-Encoding": "chunked",
        "X-Upstream-Trace": "trace-1",
      }),
      {
        provider: "openai",
        model: "gpt-4o-mini",
        cacheHit: false,
        latencyMs: 0,
        usage: null,
        costUsd: 0,
      }
    )
  );

  assert.equal(headers.get("Content-Type"), "text/event-stream");
  assert.equal(headers.get("Content-Encoding"), null);
  assert.equal(headers.get("Content-Length"), null);
  assert.equal(headers.get("Transfer-Encoding"), null);
  assert.equal(headers.get("X-Upstream-Trace"), "trace-1");
  assert.equal(headers.get("X-OmniRoute-Cache"), "MISS");
});

test("chatCore strips upstream compression and length headers from streaming responses", async () => {
  const upstreamPayload = `data: ${JSON.stringify({
    id: "chatcmpl-stream-headers",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { role: "assistant", content: "streamed" } }],
  })}\n\ndata: [DONE]\n\n`;
  const { result } = await invokeChatCore({
    provider: "openai",
    model: "gpt-4o-mini",
    accept: "text/event-stream",
    body: {
      model: "gpt-4o-mini",
      stream: true,
      messages: [{ role: "user", content: "stream header sanitization" }],
    },
    responseFactory() {
      return new Response(upstreamPayload, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Content-Length": String(Buffer.byteLength(upstreamPayload)),
          "X-Upstream-Trace": "trace-1",
        },
      });
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.response.headers.get("Content-Type"), "text/event-stream");
  assert.equal(result.response.headers.get("Content-Length"), null);
  assert.equal(result.response.headers.get("X-Upstream-Trace"), "trace-1");
  assert.equal(result.response.headers.get("X-OmniRoute-Cache"), "MISS");
  await result.response.text();
});

test("chatCore maps upstream aborts to request-aborted errors", async () => {
  const { result } = await invokeChatCore({
    provider: "openai",
    model: "gpt-4o-mini",
    body: {
      model: "gpt-4o-mini",
      stream: false,
      messages: [{ role: "user", content: "abort me" }],
    },
    responseFactory() {
      const error = new Error("request aborted by client");
      error.name = "AbortError";
      throw error;
    },
  });

  assert.equal(result.success, false);
  assert.equal(result.status, 499);
  assert.equal(result.error, "Request aborted");
});

test("chatCore returns streaming responses without waiting for upstream completion", async () => {
  const encoder = new TextEncoder();
  let closeUpstream: (() => void) | null = null;

  const invocation = invokeChatCore({
    provider: "openai",
    model: "gpt-4o-mini",
    accept: "text/event-stream",
    body: {
      model: "gpt-4o-mini",
      stream: true,
      messages: [{ role: "user", content: "do not buffer streaming" }],
    },
    responseFactory() {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  id: "chatcmpl-stream",
                  object: "chat.completion.chunk",
                  choices: [
                    {
                      index: 0,
                      delta: { role: "assistant", content: "streamed-without-buffering" },
                    },
                  ],
                })}\n\n`
              )
            );
            closeUpstream = () => {
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            };
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }
      );
    },
  });

  const raceResult = await Promise.race([
    invocation.then(() => "returned"),
    new Promise((resolve) => setTimeout(() => resolve("blocked"), 1000)),
  ]);

  if (raceResult !== "returned") {
    closeUpstream?.();
  }
  const { result } = await invocation;

  assert.equal(raceResult, "returned");
  closeUpstream?.();

  const streamText = await result.response.text();
  assert.equal(result.success, true);
  assert.match(streamText, /streamed-without-buffering/);
});

test("chatCore releases account semaphore slots when upstream execution throws", async () => {
  const connectionId = "sem-exception";
  const semaphoreKey = buildAccountSemaphoreKey({
    provider: "openai",
    accountKey: connectionId,
  });

  const { result } = await invokeChatCore({
    provider: "openai",
    model: "gpt-4o-mini",
    connectionId,
    credentials: {
      apiKey: "sk-test",
      maxConcurrent: 1,
      providerSpecificData: {},
    },
    body: {
      model: "gpt-4o-mini",
      stream: false,
      messages: [{ role: "user", content: "executor throws" }],
    },
    responseFactory() {
      throw new Error("simulated upstream network failure");
    },
  });

  await waitForAsyncSideEffects();

  assert.equal(result.success, false);
  assert.equal(result.status, 502);
  assert.equal(getAccountSemaphoreStats()[semaphoreKey], undefined);
});

test("chatCore locks per-model quota failures without dropping quota helper references", async () => {
  const model = "gemini-1.5-pro";
  const connection = await providersDb.createProviderConnection({
    provider: "gemini",
    authType: "apikey",
    name: "gemini-quota-lock",
    apiKey: "gemini-key",
    isActive: true,
    providerSpecificData: {},
  });

  try {
    const { result } = await invokeChatCore({
      provider: "gemini",
      model,
      connectionId: connection.id,
      credentials: {
        apiKey: "gemini-key",
        providerSpecificData: {},
      },
      body: {
        model,
        stream: false,
        messages: [{ role: "user", content: "quota lock" }],
      },
      responseFactory() {
        return new Response(
          JSON.stringify({ error: { message: "insufficient_quota: quota exhausted" } }),
          {
            status: 402,
            headers: { "Content-Type": "application/json" },
          }
        );
      },
    });

    assert.equal(result.success, false);
    assert.equal(result.status, 402);
    assert.equal(isModelLocked("gemini", connection.id, model), true);
  } finally {
    clearModelLock("gemini", connection.id, model);
  }
});

// ── Streaming semantic cache tests ──────────────────────────────────────────

test("chatCore caches streaming response and serves cache HIT on repeat", async () => {
  let upstreamHits = 0;
  const sharedBody = {
    model: "gpt-4o-mini",
    stream: true,
    temperature: 0,
    messages: [{ role: "user", content: "stream-cache-test" }],
  };

  const first = await invokeChatCore({
    provider: "openai",
    model: "gpt-4o-mini",
    accept: "text/event-stream",
    body: sharedBody,
    responseFormat: "openai",
    responseFactory() {
      upstreamHits += 1;
      return buildOpenAIResponse(true, "streamed-once");
    },
  });

  assert.equal(first.result.success, true);
  // Consume the stream to trigger onStreamComplete and cache write
  await first.result.response.text();
  await waitForAsyncSideEffects();

  // Second request with same body should get cache HIT (JSON, not SSE)
  const second = await invokeChatCore({
    provider: "openai",
    model: "gpt-4o-mini",
    accept: "text/event-stream",
    body: sharedBody,
    responseFormat: "openai",
    responseFactory() {
      upstreamHits += 1;
      return buildOpenAIResponse(true, "should-not-stream");
    },
  });

  assert.equal(upstreamHits, 1, "upstream should be called only once");
  assert.equal(second.calls.length, 0, "second request should not reach upstream");
  assert.equal(second.result.response.headers.get("X-OmniRoute-Cache"), "HIT");

  const payload = (await second.result.response.json()) as any;
  assert.ok(payload.choices, "cached response should have choices");
  assert.equal(payload.choices[0].message.content, "streamed-once");
});

test("chatCore does not cache streaming response when temperature > 0", async () => {
  let upstreamHits = 0;
  const sharedBody = {
    model: "gpt-4o-mini",
    stream: true,
    temperature: 0.7,
    messages: [{ role: "user", content: "non-deterministic-stream" }],
  };

  const first = await invokeChatCore({
    provider: "openai",
    model: "gpt-4o-mini",
    accept: "text/event-stream",
    body: sharedBody,
    responseFormat: "openai",
    responseFactory() {
      upstreamHits += 1;
      return buildOpenAIResponse(true, `hot-${upstreamHits}`);
    },
  });

  await first.result.response.text();
  await waitForAsyncSideEffects();

  const second = await invokeChatCore({
    provider: "openai",
    model: "gpt-4o-mini",
    accept: "text/event-stream",
    body: sharedBody,
    responseFormat: "openai",
    responseFactory() {
      upstreamHits += 1;
      return buildOpenAIResponse(true, `hot-${upstreamHits}`);
    },
  });

  await second.result.response.text();
  assert.equal(upstreamHits, 2, "both requests should hit upstream");
  assert.equal(second.calls.length, 1, "second request should reach upstream");
});

test("chatCore skips streaming cache when X-OmniRoute-No-Cache header is set", async () => {
  let upstreamHits = 0;
  const sharedBody = {
    model: "gpt-4o-mini",
    stream: true,
    temperature: 0,
    messages: [{ role: "user", content: "no-cache-stream" }],
  };

  const first = await invokeChatCore({
    provider: "openai",
    model: "gpt-4o-mini",
    accept: "text/event-stream",
    requestHeaders: { "x-omniroute-no-cache": "true" },
    body: sharedBody,
    responseFormat: "openai",
    responseFactory() {
      upstreamHits += 1;
      return buildOpenAIResponse(true, "bypass-cache");
    },
  });

  await first.result.response.text();
  await waitForAsyncSideEffects();

  // Verify nothing was cached
  const sig = generateSignature("gpt-4o-mini", sharedBody.messages, 0, 1);
  const cached = await getCachedResponse(sig);
  assert.equal(cached, null, "response should not be cached when no-cache header is set");

  const second = await invokeChatCore({
    provider: "openai",
    model: "gpt-4o-mini",
    accept: "text/event-stream",
    requestHeaders: { "x-omniroute-no-cache": "true" },
    body: sharedBody,
    responseFormat: "openai",
    responseFactory() {
      upstreamHits += 1;
      return buildOpenAIResponse(true, "bypass-again");
    },
  });

  await second.result.response.text();
  assert.equal(upstreamHits, 2, "both requests should hit upstream with no-cache");
});

test("chatCore returns cache HIT as JSON even when client requests SSE", async () => {
  const sharedBody = {
    model: "gpt-4o-mini",
    stream: false,
    temperature: 0,
    messages: [{ role: "user", content: "json-then-sse-cache" }],
  };

  // First: non-streaming request populates cache
  await invokeChatCore({
    provider: "openai",
    model: "gpt-4o-mini",
    body: sharedBody,
    responseFormat: "openai",
    responseFactory() {
      return buildOpenAIResponse(false, "cached-json");
    },
  });

  // Second: streaming request should still get cache HIT as JSON
  const second = await invokeChatCore({
    provider: "openai",
    model: "gpt-4o-mini",
    accept: "text/event-stream",
    body: { ...sharedBody, stream: true },
    responseFormat: "openai",
    responseFactory() {
      return buildOpenAIResponse(true, "should-not-stream");
    },
  });

  assert.equal(second.calls.length, 0, "cached response should prevent upstream call");
  assert.equal(second.result.response.headers.get("X-OmniRoute-Cache"), "HIT");
  assert.equal(
    second.result.response.headers.get("Content-Type"),
    "application/json",
    "cache HIT should return JSON regardless of stream flag"
  );

  const payload = (await second.result.response.json()) as any;
  assert.equal(payload.choices[0].message.content, "cached-json");
});

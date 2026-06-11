import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-chat-pipeline-"));
(process.env as Record<string, string>).NODE_ENV = process.env.NODE_ENV || "test";
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.REQUIRE_API_KEY = "false";
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "test-chat-pipeline-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const combosDb = await import("../../src/lib/db/combos.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const callLogsDb = await import("../../src/lib/usage/callLogs.ts");
const readCacheDb = await import("../../src/lib/db/readCache.ts");
const { invalidateMemorySettingsCache } = await import("../../src/lib/memory/settings.ts");
const { handleChat } = await import("../../src/sse/handlers/chat.ts");
const { initTranslators } = await import("../../open-sse/translator/index.ts");
const { clearInflight } = await import("../../open-sse/services/requestDedup.ts");
const { BaseExecutor } = await import("../../open-sse/executors/base.ts");
const { getCircuitBreaker, resetAllCircuitBreakers } =
  await import("../../src/shared/utils/circuitBreaker.ts");
const { clearProviderFailure, clearAllModelLockouts } = await import(
  "../../open-sse/services/accountFallback.ts"
);
const pgModule = await import("../../src/lib/db/postgres.ts");

const MUTABLE_TEST_TABLES = [
  "combos",
  "provider_connections",
  "provider_nodes",
  "api_keys",
  "call_logs",
  "memories",
  "memory",
  "key_value",
  "model_combo_mappings",
  "semantic_cache",
  "session_account_affinity",
  "routing_decisions",
];

async function purgePostgresTables() {
  const schema = pgModule.getSchema();
  const tables = MUTABLE_TEST_TABLES.map((table) => `${schema}.${table}`).join(", ");
  await pgModule.query(`TRUNCATE ${tables} CASCADE`);
}

const originalFetch = globalThis.fetch;
const originalRetryDelayMs = BaseExecutor.RETRY_CONFIG.delayMs;

type SeedConnectionOverrides = {
  name?: string;
  authType?: string;
  apiKey?: string;
  accessToken?: string;
  refreshToken?: string;
  tokenType?: string;
  expiresAt?: string;
  tokenExpiresAt?: string;
  isActive?: boolean;
  testStatus?: string;
  priority?: number;
  rateLimitedUntil?: string | number | null;
  providerSpecificData?: Record<string, unknown>;
};

type FetchCall = {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: Record<string, any> | null;
};

type SeedApiKeyOptions = {
  name?: string;
  noLog?: boolean;
  allowedConnections?: string[];
  allowedModels?: string[];
};

function toPlainHeaders(headers: HeadersInit | undefined | null) {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, value == null ? "" : String(value)])
  );
}

function buildRequest({
  url = "http://localhost/v1/chat/completions",
  body,
  authKey = null,
  headers = {},
}: {
  url?: string;
  body?: unknown;
  authKey?: string | null;
  headers?: Record<string, string>;
} = {}) {
  const requestHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...headers,
  };

  if (authKey) {
    requestHeaders.Authorization = `Bearer ${authKey}`;
  }

  return new Request(url, {
    method: "POST",
    headers: requestHeaders,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function buildOpenAIResponse(text = "ok", model = "gpt-4o-mini", usage = null) {
  return new Response(
    JSON.stringify({
      id: "chatcmpl_json",
      object: "chat.completion",
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: "stop",
        },
      ],
      usage: usage || {
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

function buildOpenAIToolCallResponse({
  model = "gpt-4o-mini",
  toolName = "lookupWeather@1.0.0",
  toolCallId = "call_weather",
  argumentsObject = { location: "Sao Paulo" },
} = {}) {
  return new Response(
    JSON.stringify({
      id: "chatcmpl_tool",
      object: "chat.completion",
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: toolCallId,
                type: "function",
                function: {
                  name: toolName,
                  arguments: JSON.stringify(argumentsObject),
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: {
        prompt_tokens: 6,
        completion_tokens: 4,
        total_tokens: 10,
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}

function buildClaudeResponse(text = "ok", model = "claude-3-5-sonnet-20241022") {
  return new Response(
    JSON.stringify({
      id: "msg_json",
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 10,
        output_tokens: 4,
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}

function buildClaudeStreamResponse(text = "streamed from claude", model = "claude-sonnet-4-6") {
  return new Response(
    [
      "event: message_start",
      `data: ${JSON.stringify({
        type: "message_start",
        message: {
          id: "msg_stream",
          type: "message",
          role: "assistant",
          model,
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

function buildGeminiResponse(text = "ok", model = "gemini-2.5-flash") {
  return new Response(
    JSON.stringify({
      responseId: "resp_gemini",
      modelVersion: model,
      createTime: "2026-04-05T12:00:00.000Z",
      candidates: [
        {
          content: {
            parts: [{ text }],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 5,
        candidatesTokenCount: 7,
        totalTokenCount: 12,
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}

function buildOpenAIStreamResponse(text = "streamed from openai") {
  return new Response(
    [
      `data: ${JSON.stringify({
        id: "chatcmpl_stream",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant", content: text } }],
      })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n"),
    {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }
  );
}

function buildOpenAIResponsesSSE({
  text = "responses streamed from upstream",
  model = "gpt-5.3",
  usage = null,
} = {}) {
  return new Response(
    [
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_stream",
          object: "response",
          status: "completed",
          model,
          output: [
            {
              id: "msg_stream",
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text, annotations: [] }],
            },
          ],
          usage: usage || {
            input_tokens: 120,
            output_tokens: 30,
            prompt_tokens_details: {
              cached_tokens: 40,
            },
            cache_creation_input_tokens: 11,
            completion_tokens_details: {
              reasoning_tokens: 13,
            },
          },
        },
      })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n"),
    {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }
  );
}

async function resetStorage() {
  globalThis.fetch = originalFetch;
  process.env.REQUIRE_API_KEY = "false";
  clearInflight();
  resetAllCircuitBreakers();
  clearAllModelLockouts();
  apiKeysDb.resetApiKeyState();
  readCacheDb.invalidateDbCache();
  invalidateMemorySettingsCache();
  await callLogsDb.drainCallLogWrites();
  await purgePostgresTables();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  initTranslators();
}

async function seedConnection(provider, overrides: SeedConnectionOverrides = {}) {
  return providersDb.createProviderConnection({
    provider,
    authType: overrides.authType || "apikey",
    name: overrides.name || `${provider}-primary`,
    email: overrides.email,
    apiKey: overrides.apiKey || `sk-${provider}-${Math.random().toString(16).slice(2, 10)}`,
    accessToken: overrides.accessToken,
    refreshToken: overrides.refreshToken,
    tokenType: overrides.tokenType,
    expiresAt: overrides.expiresAt,
    tokenExpiresAt: overrides.tokenExpiresAt,
    isActive: overrides.isActive ?? true,
    testStatus: overrides.testStatus || "active",
    priority: overrides.priority,
    rateLimitedUntil: overrides.rateLimitedUntil,
    providerSpecificData: overrides.providerSpecificData || {},
  });
}

async function seedApiKey({
  name = "chat-pipeline-key",
  noLog = false,
  allowedConnections,
  allowedModels,
}: SeedApiKeyOptions = {}) {
  const key = await apiKeysDb.createApiKey(name, "machine-test");
  const updates: Record<string, unknown> = {};
  if (noLog) updates.noLog = true;
  if (allowedConnections) updates.allowedConnections = allowedConnections;
  if (allowedModels) updates.allowedModels = allowedModels;
  if (Object.keys(updates).length > 0) {
    await apiKeysDb.updateApiKeyPermissions(key.id, updates);
  }
  return key;
}

async function ensureLegacyMemoryTable() {
  const db = core.getDbInstance();
  await db.exec(`
    CREATE TABLE IF NOT EXISTS memory (
      id TEXT PRIMARY KEY,
      apiKeyId TEXT NOT NULL,
      sessionId TEXT,
      type TEXT NOT NULL,
      key TEXT,
      content TEXT NOT NULL,
      metadata TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      expiresAt TEXT
    )
  `);
}

async function insertLegacyMemory(apiKeyId, content) {
  const db = core.getDbInstance();
  const now = new Date().toISOString();
  const hasModernTable = Boolean(
    await db
      .prepare("SELECT 1 FROM information_schema.tables WHERE table_name = $1")
      .get("memories")
  );

  if (hasModernTable) {
    await db.prepare(
      `
        INSERT INTO memories (
          id, api_key_id, session_id, type, key, content, metadata, created_at, updated_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      `mem_${Math.random().toString(16).slice(2, 10)}`,
      apiKeyId,
      "",
      "factual",
      "pref",
      content,
      "{}",
      now,
      now,
      null
    );
    return;
  }

  await ensureLegacyMemoryTable();
  await db.prepare(
    `
      INSERT INTO memory (
        id, apiKeyId, sessionId, type, key, content, metadata, createdAt, updatedAt, expiresAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    `mem_${Math.random().toString(16).slice(2, 10)}`,
    apiKeyId,
    "",
    "factual",
    "pref",
    content,
    "{}",
    now,
    now,
    null
  );
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

async function getLatestCallLog() {
  const rows = await callLogsDb.getCallLogs({ limit: 5 });
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return callLogsDb.getCallLogById(rows[0].id);
}

async function getResponsesCallLogs() {
  const rows = await callLogsDb.getCallLogs({ limit: 200 });
  if (!Array.isArray(rows) || rows.length === 0) return [];
  return rows.filter((row) => row.path === "/v1/responses");
}

test.beforeEach(async () => {
  BaseExecutor.RETRY_CONFIG.delayMs = 0;
  await resetStorage();
});

test.afterEach(async () => {
  BaseExecutor.RETRY_CONFIG.delayMs = originalRetryDelayMs;
  await resetStorage();
});

test.after(async () => {
  BaseExecutor.RETRY_CONFIG.delayMs = originalRetryDelayMs;
  globalThis.fetch = originalFetch;
  clearInflight();
  resetAllCircuitBreakers();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("chat pipeline handles OpenAI passthrough with valid API key auth", async () => {
  await seedConnection("openai-compatible-pipeline", { apiKey: "sk-openai-primary" });
  const apiKey = await seedApiKey();
  const fetchCalls: FetchCall[] = [];

  globalThis.fetch = async (url, init: RequestInit = {}) => {
    fetchCalls.push({
      url: String(url),
      method: init.method || "GET",
      headers: toPlainHeaders(init.headers),
      body: init.body ? JSON.parse(String(init.body)) : null,
    });
    return buildOpenAIResponse("OpenAI passthrough");
  };

  const response = await handleChat(
    buildRequest({
      authKey: apiKey.key,
      body: {
        model: "openai-compatible-pipeline/gpt-4o-mini",
        stream: false,
        messages: [{ role: "user", content: "Hello OpenAI" }],
      },
    })
  );

  const json = (await response.json()) as any;
  assert.equal(response.status, 200);
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0].url, /\/chat\/completions$/);
  assert.equal(fetchCalls[0].headers.Authorization, "Bearer sk-openai-primary");
  assert.equal(fetchCalls[0].body.messages[0].content, "Hello OpenAI");
  assert.equal(json.choices[0].message.content, "OpenAI passthrough");
});

test("chat pipeline serves repeated /v1/responses requests as MISS then HIT and logs cache hits separately", async () => {
  await seedConnection("openai-compatible-pipeline", {
    apiKey: "sk-openai-cache-seq",
    providerSpecificData: { apiType: "responses" },
  });
  const fetchCalls = [];

  globalThis.fetch = async (url, init: RequestInit = {}) => {
    fetchCalls.push({
      url: String(url),
      headers: toPlainHeaders(init.headers),
      body: init.body ? JSON.parse(String(init.body)) : null,
    });
    return buildOpenAIResponsesSSE({
      text: "cached semantic response",
      usage: {
        input_tokens: 21,
        output_tokens: 7,
        prompt_tokens_details: {
          cached_tokens: 5,
        },
        cache_creation_input_tokens: 2,
        completion_tokens_details: {
          reasoning_tokens: 3,
        },
      },
    });
  };

  const uniquePrompt = `semantic-cache-seq-${Math.random().toString(16).slice(2)}`;
  const requestBody = {
    model: "openai-compatible-pipeline/gpt-5.3",
    stream: false,
    temperature: 0,
    input: [{ role: "user", content: [{ type: "input_text", text: uniquePrompt }] }],
  };

  const beforeCount = (await getResponsesCallLogs()).length;

  const firstResponse = await handleChat(
    buildRequest({
      url: "http://localhost/v1/responses",
      body: requestBody,
    })
  );

  const secondResponse = await handleChat(
    buildRequest({
      url: "http://localhost/v1/responses",
      body: requestBody,
    })
  );

  const thirdResponse = await handleChat(
    buildRequest({
      url: "http://localhost/v1/responses",
      body: requestBody,
    })
  );

  await firstResponse.json();
  await secondResponse.json();
  await thirdResponse.json();

  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 200);
  assert.equal(thirdResponse.status, 200);

  assert.equal(firstResponse.headers.get("X-OmniRoute-Cache"), "MISS");
  assert.equal(secondResponse.headers.get("X-OmniRoute-Cache"), "HIT");
  assert.equal(thirdResponse.headers.get("X-OmniRoute-Cache"), "HIT");

  assert.equal(fetchCalls.length, 1, "expected upstream to be called only once for MISS");
  assert.match(fetchCalls[0].url, /\/responses$/);

  const callLogs = await waitFor(async () => {
    const rows = await getResponsesCallLogs();
    return rows.length === beforeCount + 3 ? rows : null;
  }, 2000);

  assert.ok(callLogs, "expected /v1/responses call logs to be recorded");
  assert.equal(callLogs.length, beforeCount + 3, "expected MISS plus two HIT call logs");

  const newLogs = callLogs.slice(0, 3);
  assert.equal(newLogs.filter((row) => row.cacheSource === "upstream").length, 1);
  assert.equal(newLogs.filter((row) => row.cacheSource === "semantic").length, 2);

  const callLog = await waitFor(() => getLatestCallLog());
  assert.ok(callLog, "expected a call log row to exist");
  assert.equal(callLog.path, "/v1/responses");
  assert.equal(callLog.status, 200);
});

test("chat pipeline rejects invalid API keys and malformed JSON bodies", async () => {
  await seedConnection("openai-compatible-pipeline", { apiKey: "sk-openai-invalid-key-path" });

  const invalidKeyResponse = await handleChat(
    buildRequest({
      authKey: "does-not-exist",
      body: {
        model: "openai-compatible-pipeline/gpt-4o-mini",
        messages: [{ role: "user", content: "Hello" }],
      },
    })
  );
  const invalidKeyJson = (await invalidKeyResponse.json()) as any;

  const invalidJsonResponse = await handleChat(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{bad-json",
    })
  );
  const invalidJson = (await invalidJsonResponse.json()) as any;

  assert.equal(invalidKeyResponse.status, 401);
  assert.match(invalidKeyJson.error.message, /Invalid API key|Incorrect API key/i);
  assert.equal(invalidJsonResponse.status, 400);
  assert.match(invalidJson.error.message, /Invalid JSON body/i);
});

test("chat pipeline allows unauthenticated requests through to provider resolution when called directly (authz pipeline enforces REQUIRE_API_KEY at route level)", async () => {
  process.env.REQUIRE_API_KEY = "true";

  const response = await handleChat(
    buildRequest({
      body: {
        model: "openai-compatible-pipeline/gpt-4o-mini",
        stream: false,
        messages: [{ role: "user", content: "Missing auth" }],
      },
    })
  );
  const json = (await response.json()) as any;

  // handleChat does not enforce REQUIRE_API_KEY — that's the authz pipeline's job.
  // Without provider credentials seeded, the request falls through to the "no credentials" path.
  assert.equal(response.status, 400);
  assert.match(json.error.message, /No credentials for provider/i);
});

test("chat pipeline returns 400 when the model field is omitted", async () => {
  const response = await handleChat(
    buildRequest({
      body: {
        stream: false,
        messages: [{ role: "user", content: "No model selected" }],
      },
    })
  );
  const json = (await response.json()) as any;

  assert.equal(response.status, 400);
  assert.match(json.error.message, /Missing model/i);
});

test("chat pipeline treats Accept text/event-stream as streaming mode and returns a session header", async () => {
  await seedConnection("openai-compatible-pipeline", { apiKey: "sk-openai-accept-stream" });

  globalThis.fetch = async () => buildOpenAIStreamResponse("Accept header stream");

  const response = await handleChat(
    buildRequest({
      headers: { Accept: "application/json, text/event-stream" },
      body: {
        model: "openai-compatible-pipeline/gpt-4o-mini",
        messages: [{ role: "user", content: "Stream via Accept" }],
      },
    })
  );

  const raw = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "text/event-stream");
  assert.ok(response.headers.get("X-OmniRoute-Session-Id"));
  assert.match(raw, /Accept header stream/);
  assert.match(raw, /\[DONE\]/);
});

test("chat pipeline supports local mode without Authorization on explicit combos", async () => {
  await seedConnection("openai-compatible-pipeline", { apiKey: "sk-openai-local-combo" });
  await combosDb.createCombo({
    name: "local-router",
    strategy: "priority",
    models: ["openai-compatible-pipeline/gpt-4o-mini"],
  });
  const fetchCalls = [];

  globalThis.fetch = async (url, init: RequestInit = {}) => {
    fetchCalls.push({
      url: String(url),
      headers: toPlainHeaders(init.headers),
    });
    return buildOpenAIResponse("Local combo route");
  };

  const response = await handleChat(
    buildRequest({
      body: {
        model: "local-router",
        stream: false,
        messages: [{ role: "user", content: "No auth header here" }],
      },
    })
  );

  const json = (await response.json()) as any;
  assert.equal(response.status, 200);
  assert.equal(fetchCalls.length, 1);
  assert.equal(json.choices[0].message.content, "Local combo route");
});

test("chat pipeline honors noLog by redacting persisted call log payloads", async () => {
  await seedConnection("openai-compatible-pipeline", { apiKey: "sk-openai-no-log" });
  const apiKey = await seedApiKey({ noLog: true });

  globalThis.fetch = async () => buildOpenAIResponse("No-log reply");

  const response = await handleChat(
    buildRequest({
      authKey: apiKey.key,
      body: {
        model: "openai-compatible-pipeline/gpt-4o-mini",
        stream: false,
        messages: [{ role: "user", content: "Do not persist payloads" }],
      },
    })
  );

  assert.equal(response.status, 200);

  const callLog = await waitFor(() => getLatestCallLog());
  assert.ok(callLog, "expected a call log row to be created");
  assert.equal(callLog.apiKeyId, apiKey.id);
  assert.equal(callLog.requestBody, null);
  assert.equal(callLog.responseBody, null);
  assert.equal(callLog.artifactRelPath, null);
});

test("chat pipeline returns current no-credentials contract when no provider connection exists", async () => {
  const response = await handleChat(
    buildRequest({
      body: {
        model: "openai-compatible-pipeline/gpt-4o-mini",
        stream: false,
        messages: [{ role: "user", content: "Hello" }],
      },
    })
  );

  const json = (await response.json()) as any;
  assert.equal(response.status, 400);
  assert.match(json.error.message, /No credentials for provider: openai/);
});

test("chat pipeline surfaces upstream 500 responses as structured errors", async () => {
  await seedConnection("openai-compatible-pipeline", { apiKey: "sk-openai-500" });

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: "provider exploded" } }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });

  const response = await handleChat(
    buildRequest({
      body: {
        model: "openai-compatible-pipeline/gpt-4o-mini",
        stream: false,
        messages: [{ role: "user", content: "Trigger 500" }],
      },
    })
  );

  const json = (await response.json()) as any;
  assert.equal(response.status, 500);
  assert.match(json.error.message, /\[500\]: provider exploded/);
});

test("chat pipeline returns 429 with Retry-After when the upstream rate-limits the only account", async () => {
  await seedConnection("openai-compatible-pipeline", { apiKey: "sk-openai-429" });
  await settingsDb.updateSettings({
    requestRetry: 0,
    maxRetryIntervalSec: 0,
  });
  let attempts = 0;

  globalThis.fetch = async () => {
    attempts += 1;
    return new Response(
      JSON.stringify({
        error: {
          message: "Rate limit exceeded. Your quota will reset after 30s.",
        },
      }),
      {
        status: 429,
        headers: { "Content-Type": "application/json" },
      }
    );
  };

  const response = await handleChat(
    buildRequest({
      body: {
        model: "openai-compatible-pipeline/gpt-4o-mini",
        stream: false,
        messages: [{ role: "user", content: "Trigger 429" }],
      },
    })
  );

  const json = (await response.json()) as any;
  assert.equal(response.status, 429);
  assert.ok(attempts >= 1, "expected at least one upstream attempt");
  assert.ok(Number(response.headers.get("Retry-After")) >= 1);
  assert.match(json.error.message, /All credentials for model gpt-4o-mini are cooling down/);
  assert.equal(json.error.code, "model_cooldown");
});

test("chat pipeline keeps provider breaker closed for repeated connection-scoped 429s", async () => {
  await seedConnection("openai-compatible-pipeline", { apiKey: "sk-openai-429-breaker" });
  await settingsDb.updateSettings({
    requestRetry: 0,
    maxRetryIntervalSec: 0,
  });

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        error: {
          message: "Rate limit exceeded. Your quota will reset after 30s.",
        },
      }),
      {
        status: 429,
        headers: { "Content-Type": "application/json" },
      }
    );

  for (let i = 0; i < 3; i += 1) {
    const response = await handleChat(
      buildRequest({
        body: {
          model: "openai-compatible-pipeline/gpt-4o-mini",
          stream: false,
          messages: [{ role: "user", content: `Trigger 429 #${i + 1}` }],
        },
      })
    );
    assert.equal(response.status, 429);
  }

  const breaker = getCircuitBreaker("openai-compatible-pipeline");
  const status = breaker.getStatus();

  assert.equal(status.state, "CLOSED");
  assert.equal(status.failureCount, 0);
});

test("chat pipeline maps upstream timeouts to 504 responses", async () => {
  await seedConnection("openai-compatible-pipeline", { apiKey: "sk-openai-timeout" });

  globalThis.fetch = async () => {
    const error = new Error("upstream timed out");
    error.name = "TimeoutError";
    throw error;
  };

  const response = await handleChat(
    buildRequest({
      body: {
        model: "openai-compatible-pipeline/gpt-4o-mini",
        stream: false,
        messages: [{ role: "user", content: "Trigger timeout" }],
      },
    })
  );

  const json = (await response.json()) as any;
  assert.equal(response.status, 504);
  assert.match(json.error.message, /\[504\]: upstream timed out/);
});

test("chat pipeline injects memory context before sending the upstream request", async () => {
  // Reset provider failure state to avoid circuit breaker interference
  clearProviderFailure("openai-compatible-pipeline");
  await seedConnection("openai-compatible-pipeline", { apiKey: "sk-openai-memory" });
  const apiKey = await seedApiKey();
  await settingsDb.updateSettings({
    memoryEnabled: true,
    memoryMaxTokens: 400,
    memoryRetentionDays: 30,
    memoryStrategy: "recent",
  });
  invalidateMemorySettingsCache();
  await insertLegacyMemory(apiKey.id, "User prefers concise answers.");

  const fetchCalls = [];
  globalThis.fetch = async (url, init: RequestInit = {}) => {
    fetchCalls.push({
      url: String(url),
      body: init.body ? JSON.parse(String(init.body)) : null,
    });
    return buildOpenAIResponse("Memory-aware reply");
  };

  const response = await handleChat(
    buildRequest({
      authKey: apiKey.key,
      body: {
        model: "openai-compatible-pipeline/gpt-4o-mini",
        stream: false,
        messages: [{ role: "user", content: "Summarize my preference" }],
      },
    })
  );

  const json = (await response.json()) as any;
  assert.equal(response.status, 200);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].body.messages[0].role, "system");
  assert.match(fetchCalls[0].body.messages[0].content, /User prefers concise answers/);
  assert.equal(json.choices[0].message.content, "Memory-aware reply");
});

test("chat pipeline falls back to the next account after a provider failure", async () => {
  // Reset provider failure state to avoid circuit breaker interference
  clearProviderFailure("openai-compatible-pipeline");
  await seedConnection("openai-compatible-pipeline", {
    name: "openai-primary",
    apiKey: "sk-openai-primary-fallback",
    priority: 1,
  });
  await seedConnection("openai-compatible-pipeline", {
    name: "openai-secondary",
    apiKey: "sk-openai-secondary-fallback",
    priority: 2,
  });
  const seenAuthHeaders = [];

  globalThis.fetch = async (url, init: RequestInit = {}) => {
    const headers = toPlainHeaders(init.headers);
    seenAuthHeaders.push(headers.Authorization);
    if (seenAuthHeaders.length === 1) {
      return new Response(JSON.stringify({ error: { message: "first account failed" } }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
    return buildOpenAIResponse("Second account succeeded");
  };

  const response = await handleChat(
    buildRequest({
      body: {
        model: "openai-compatible-pipeline/gpt-4o-mini",
        stream: false,
        messages: [{ role: "user", content: "Use account fallback" }],
      },
    })
  );

  const json = (await response.json()) as any;
  assert.equal(response.status, 200);
  assert.deepEqual(seenAuthHeaders, [
    "Bearer sk-openai-primary-fallback",
    "Bearer sk-openai-secondary-fallback",
  ]);
  assert.equal(json.choices[0].message.content, "Second account succeeded");
});

test("chat pipeline falls back across combo models when the first provider fails", async () => {
  // Reset provider failure state to avoid circuit breaker interference
  clearProviderFailure("openai-compatible-pipeline");
  clearProviderFailure("openai-compatible-fallback2");
  await seedConnection("openai-compatible-pipeline", { apiKey: "sk-openai-combo-fail" });
  await seedConnection("openai-compatible-fallback2", {
    apiKey: "sk-fallback2-combo",
    providerSpecificData: { baseUrl: "https://fallback2.example.com/v1" },
  });
  await combosDb.createCombo({
    name: "combo-fallback",
    strategy: "priority",
    config: { maxRetries: 0, retryDelayMs: 0 },
    models: ["openai-compatible-pipeline/gpt-4o-mini", "openai-compatible-fallback2/gpt-4o-mini"],
  });
  const attempts = [];

  globalThis.fetch = async (url, init: RequestInit = {}) => {
    const call = {
      url: String(url),
      headers: toPlainHeaders(init.headers),
    };
    attempts.push(call);
    if (attempts.length === 1) {
      return new Response(JSON.stringify({ error: { message: "openai combo miss" } }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }
    return buildOpenAIResponse("Fallback combo response");
  };

  const response = await handleChat(
    buildRequest({
      body: {
        model: "combo-fallback",
        stream: false,
        messages: [{ role: "user", content: "Use combo fallback" }],
      },
    })
  );

  const json = (await response.json()) as any;
  assert.equal(response.status, 200);
  assert.equal(attempts.length, 2);
  assert.match(attempts[0].url, /api\.openai\.com\/v1\/chat\/completions$/);
  assert.match(attempts[1].url, /fallback2\.example\.com\/v1\/chat\/completions$/);
  assert.equal(json.choices[0].message.content, "Fallback combo response");
});

test("chat pipeline deduplicates concurrent identical non-stream requests", async () => {
  // Reset provider failure state to avoid circuit breaker interference
  clearProviderFailure("openai-compatible-pipeline");
  await seedConnection("openai-compatible-pipeline", { apiKey: "sk-openai-dedup" });
  let fetchCount = 0;

  globalThis.fetch = async () => {
    fetchCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 250));
    return buildOpenAIResponse("Deduplicated response");
  };

  const requestA = buildRequest({
    body: {
      model: "openai-compatible-pipeline/gpt-4o-mini",
      stream: false,
      temperature: 0,
      messages: [{ role: "user", content: "Deduplicate this request" }],
    },
  });
  const requestB = buildRequest({
    body: {
      model: "openai-compatible-pipeline/gpt-4o-mini",
      stream: false,
      temperature: 0,
      messages: [{ role: "user", content: "Deduplicate this request" }],
    },
  });

  const [responseA, responseB] = await Promise.all([handleChat(requestA), handleChat(requestB)]);
  const [jsonA, jsonB] = await Promise.all([responseA.json(), responseB.json()]);

  assert.equal(responseA.status, 200);
  assert.equal(responseB.status, 200);
  assert.equal(fetchCount, 1);
  assert.equal(jsonA.choices[0].message.content, "Deduplicated response");
  assert.equal(jsonB.choices[0].message.content, "Deduplicated response");
});

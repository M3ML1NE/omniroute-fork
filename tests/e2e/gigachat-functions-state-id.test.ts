/**
 * E2E (T4.2): functions_state_id raw-JSON extension passthrough through the REAL
 * /v1/chat/completions route (handleChat), against a mock GigaChat upstream in
 * true wire mode.
 *
 * Contract under test (route-level, non-streaming):
 *   1. GigaChat returns message.functions_state_id -> it appears on the OpenAI
 *      response message as a non-standard extension field.
 *   2. A second turn whose assistant history carries functions_state_id -> the
 *      intercepted upstream body forwards it on the assistant message.
 *   3. A second turn WITHOUT functions_state_id -> the request still succeeds
 *      (graceful degradation; GigaChat works without it).
 *
 * Run:
 *   DATABASE_URL="postgres://omniroute:omniroute@localhost:5432/omniroute_test" \
 *     node --import tsx/esm --test tests/e2e/gigachat-functions-state-id.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

process.env.REQUIRE_API_KEY = "false";
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "test-functions-state-id-secret";

const { startMockGigachat } = await import("../fixtures/mock-gigachat-server.ts");
const coreDb = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const { runMigrations } = await import("../../src/lib/db/migrationRunner.ts");
const { getPool } = await import("../../src/lib/db/postgres.ts");
const { handleChat } = await import("../../src/sse/handlers/chat.ts");
const { initTranslators } = await import("../../open-sse/translator/index.ts");

const PROVIDER_ID = "gigachat-compatible-fsid-e2e";
const MODEL = `${PROVIDER_ID}/GigaChat`;
const CONNECTION_NAME = "gigachat-fsid-e2e";
const MOCK_STATE_ID = "0e2a1b3c-4d5e-6f70-8a9b-mockstate0001";

type MockServer = Awaited<ReturnType<typeof startMockGigachat>>;
type JsonRecord = Record<string, unknown>;

let mock: MockServer;

function patchAdapterRunForFireAndForget() {
  const db = coreDb.getDbInstance() as {
    prepare: (sql: string) => { run: (...args: unknown[]) => unknown };
  };
  const originalPrepare = db.prepare.bind(db);
  db.prepare = (sql: string) => {
    const stmt = originalPrepare(sql);
    const originalRun = stmt.run.bind(stmt);
    stmt.run = (...args: unknown[]) => {
      const result = originalRun(...args) as unknown;
      if (result && typeof (result as Promise<unknown>).catch === "function") {
        (result as Promise<unknown>).catch(() => {});
      }
      return result;
    };
    return stmt;
  };
}

function buildRequest(body: unknown) {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const WEATHER_TOOL = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the weather",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
};

async function cleanupSeededRows() {
  await (await getPool()).query("DELETE FROM call_logs WHERE provider = $1", [PROVIDER_ID]);
  await (await getPool()).query(
    "DELETE FROM provider_connections WHERE provider = $1 AND name = $2",
    [PROVIDER_ID, CONNECTION_NAME]
  );
}

before(async () => {
  patchAdapterRunForFireAndForget();
  initTranslators();
  await runMigrations();

  mock = await startMockGigachat({ wire: "gigachat" });

  await cleanupSeededRows();

  const connection = await providersDb.createProviderConnection({
    provider: PROVIDER_ID,
    authType: "apikey",
    name: CONNECTION_NAME,
    apiKey: "test-key",
    isActive: true,
    testStatus: "active",
    providerSpecificData: {
      baseUrl: `${mock.url}/api/v1`,
      mtls: { cert: "test-cert", key: "test-key" },
    },
  });
  assert.ok(String((connection as JsonRecord).id), "expected a seeded gigachat connection id");
});

after(async () => {
  if (mock) await mock.close();
  await cleanupSeededRows();
});

describe("T4.2 functions_state_id raw-JSON extension passthrough (route-level)", () => {
  it("returns functions_state_id on the OpenAI response message", async () => {
    mock.lastRequest = null;

    const response = await handleChat(
      buildRequest({
        model: MODEL,
        stream: false,
        messages: [{ role: "user", content: "weather in Moscow?" }],
        tools: [WEATHER_TOOL],
      })
    );

    const json = (await response.json()) as JsonRecord;
    assert.equal(response.status, 200, `expected 200, got ${response.status}: ${JSON.stringify(json)}`);

    const message = (json.choices as JsonRecord[])?.[0]?.message as JsonRecord;
    assert.ok(message, "expected a response message");
    assert.equal(
      message.functions_state_id,
      MOCK_STATE_ID,
      "functions_state_id passed through onto the OpenAI response message"
    );
  });

  it("forwards a functions_state_id from assistant history to the upstream body", async () => {
    mock.lastRequest = null;

    const response = await handleChat(
      buildRequest({
        model: MODEL,
        stream: false,
        messages: [
          { role: "user", content: "weather in Moscow?" },
          {
            role: "assistant",
            content: "",
            functions_state_id: MOCK_STATE_ID,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"Moscow"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: '{"temp":"25C"}' },
          { role: "user", content: "and tomorrow?" },
        ],
        tools: [WEATHER_TOOL],
      })
    );

    assert.equal(response.status, 200, `expected 200, got ${response.status}`);

    const sent = mock.lastRequest?.body as JsonRecord;
    assert.ok(sent, "expected the mock to capture the request");
    const sentMessages = sent.messages as JsonRecord[];
    const assistantMsg = sentMessages.find((m) => m.role === "assistant");
    assert.ok(assistantMsg, "assistant message forwarded to GigaChat");
    assert.equal(
      assistantMsg?.functions_state_id,
      MOCK_STATE_ID,
      "functions_state_id forwarded on the upstream assistant message"
    );
  });

  it("does not fail when a second turn omits functions_state_id", async () => {
    mock.lastRequest = null;

    const response = await handleChat(
      buildRequest({
        model: MODEL,
        stream: false,
        messages: [
          { role: "user", content: "weather in Moscow?" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_2",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"Moscow"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_2", content: '{"temp":"25C"}' },
          { role: "user", content: "and tomorrow?" },
        ],
        tools: [WEATHER_TOOL],
      })
    );

    assert.equal(response.status, 200, "request without functions_state_id still succeeds");

    const sent = mock.lastRequest?.body as JsonRecord;
    const sentMessages = sent.messages as JsonRecord[];
    const assistantMsg = sentMessages.find((m) => m.role === "assistant");
    assert.ok(assistantMsg, "assistant message forwarded");
    assert.equal(
      assistantMsg?.functions_state_id,
      undefined,
      "no functions_state_id fabricated when history omits it"
    );
  });
});

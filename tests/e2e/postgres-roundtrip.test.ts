/**
 * E2E: GigaChat (openai-compat) chat round-trip through the OmniRoute pipeline
 * with usage logging verified against the live Postgres `call_logs` table.
 *
 * Unlike tests/integration/chat-pipeline.test.ts (which resets a SQLite DATA_DIR),
 * this suite runs against the real Postgres test database selected by core.ts when
 * DATABASE_URL is set. It exercises the REAL pipeline (handleChat) and the REAL
 * async call-log writer, then asserts the persisted row both via the callLogs db
 * module AND a raw getPool() query so we prove the row really landed in Postgres.
 *
 * Run:
 *   DATABASE_URL="postgres://omniroute:omniroute@localhost:5432/omniroute_test" \
 *     node --import tsx/esm --test tests/e2e/postgres-roundtrip.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

// Must be set BEFORE importing the pipeline/db modules.
process.env.REQUIRE_API_KEY = "false";
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "test-postgres-roundtrip-secret";

const { startMockGigachat } = await import("../fixtures/mock-gigachat-server.ts");
const coreDb = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const callLogsDb = await import("../../src/lib/usage/callLogs.ts");
const { getPool } = await import("../../src/lib/db/postgres.ts");
const { handleChat } = await import("../../src/sse/handlers/chat.ts");
const { initTranslators } = await import("../../open-sse/translator/index.ts");

// Unique sentinels so cleanup never touches unrelated rows in the shared test DB.
const CONNECTION_NAME = "gigachat-e2e-roundtrip";
const API_KEY_NAME = "roundtrip-e2e-key";

// Non-critical background writers (proxy_logs, etc.) still do fire-and-forget
// `db.prepare(sql).run(...)` written for the old synchronous better-sqlite3
// driver. The in-progress core.ts pg-adapter shim makes `.run()` async, so the
// discarded promise rejects unhandled and node:test blames the running test.
// Restore the original best-effort semantic by attaching a no-op catch to each
// run() promise; `await`ing callers still see rejections via their own await.
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

type MockServer = Awaited<ReturnType<typeof startMockGigachat>>;

let mock: MockServer;
let connectionId: string;
let apiKeyId: string;
let apiKeyValue: string;

function buildRequest(body: unknown, authKey?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authKey) headers.Authorization = `Bearer ${authKey}`;
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function waitFor<T>(fn: () => Promise<T> | T, timeoutMs = 1500): Promise<T | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await fn();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

async function getLatestGigachatCallLog() {
  const rows = await callLogsDb.getCallLogs({ provider: "gigachat", limit: 10 });
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return callLogsDb.getCallLogById(rows[0].id);
}

/** Raw Postgres assertion — proves the row is really persisted, not just in-memory. */
async function getLatestGigachatRowRaw() {
  const result = await getPool().query(
    "SELECT id, provider, status, model FROM call_logs WHERE provider = $1 ORDER BY timestamp DESC LIMIT 1",
    ["gigachat"]
  );
  return result.rows[0] ?? null;
}

async function cleanupSeededRows() {
  // call_logs first (FK-free, sentinel = provider), then the seeded connection + key.
  await getPool().query("DELETE FROM call_logs WHERE provider = $1", ["gigachat"]);
  await getPool().query("DELETE FROM provider_connections WHERE provider = $1 AND name = $2", [
    "gigachat",
    CONNECTION_NAME,
  ]);
  await getPool().query("DELETE FROM api_keys WHERE name = $1", [API_KEY_NAME]);
}

before(async () => {
  patchAdapterRunForFireAndForget();
  initTranslators();

  mock = await startMockGigachat();

  // Idempotency: clear any leftovers from a prior crashed run before seeding.
  await cleanupSeededRows();

  // Seed the gigachat connection.
  //   buildUrl(gigachat) -> normalizeGigachatChatUrl(baseUrl): strips a trailing
  //   /chat/completions then re-appends it, so baseUrl="${mock.url}/api/v1"
  //   yields the final URL "${mock.url}/api/v1/chat/completions" — a real mock route.
  //   authUrl points gigachat's OAuth token exchange at the mock /oauth/token so
  //   the refreshCredentials path resolves an access_token and the request reaches
  //   the mock with a Bearer token.
  const connection = await providersDb.createProviderConnection({
    provider: "gigachat",
    authType: "apikey",
    name: CONNECTION_NAME,
    apiKey: "test-key",
    isActive: true,
    testStatus: "active",
    providerSpecificData: {
      baseUrl: `${mock.url}/api/v1`,
      authUrl: `${mock.url}/oauth/token`,
    },
  });
  connectionId = String((connection as Record<string, unknown>).id);
  assert.ok(connectionId, "expected a seeded gigachat connection id");

  const apiKey = await apiKeysDb.createApiKey(API_KEY_NAME, "machine-test");
  apiKeyId = apiKey.id;
  apiKeyValue = apiKey.key;
  assert.ok(apiKeyValue, "expected a seeded api key value");
});

after(async () => {
  if (mock) await mock.close();
  try {
    if (apiKeyId) await apiKeysDb.deleteApiKey(apiKeyId);
  } catch {
    /* fall through to raw cleanup */
  }
  try {
    if (connectionId) await providersDb.deleteProviderConnection(connectionId);
  } catch {
    /* fall through to raw cleanup */
  }
  // Idempotent: remove anything left behind by name/provider sentinels.
  await cleanupSeededRows();
});

describe("GigaChat round-trip with Postgres usage logging", () => {
  it("non-streaming: completes a chat round-trip and logs usage to Postgres call_logs", async () => {
    mock.lastRequest = null;

    const response = await handleChat(
      buildRequest({
        model: "gigachat/GigaChat",
        stream: false,
        messages: [{ role: "user", content: "Hello GigaChat" }],
      })
    );

    const json = (await response.json()) as any;

    // 1. Pipeline succeeded with content from the mock upstream.
    assert.equal(response.status, 200, `expected 200, got ${response.status}: ${JSON.stringify(json)}`);
    assert.equal(json.object, "chat.completion");
    assert.equal(json.choices?.[0]?.message?.content, "mock-reply");

    // 2. The request actually reached the mock at the expected route.
    assert.ok(mock.lastRequest, "expected the mock to capture a request");
    assert.equal(
      mock.lastRequest?.path,
      "/api/v1/chat/completions",
      `unexpected upstream path: ${mock.lastRequest?.path}`
    );

    // 3. A call_logs row exists (poll for the fire-and-forget async write).
    const callLog = await waitFor(() => getLatestGigachatCallLog());
    assert.ok(callLog, "expected a gigachat call_logs row via callLogs db module");
    assert.equal(callLog.provider, "gigachat");
    assert.equal(callLog.path, "/v1/chat/completions");
    assert.equal(callLog.status, 200);

    // 4. Prove the row is REALLY in Postgres via a raw pool query.
    const rawRow = await waitFor(() => getLatestGigachatRowRaw());
    assert.ok(rawRow, "expected a gigachat call_logs row via raw getPool() query");
    assert.equal(rawRow.provider, "gigachat");
    assert.equal(rawRow.status, 200);
  });

  it("streaming: streams an SSE chat response and logs usage to Postgres call_logs", async () => {
    mock.lastRequest = null;

    // Snapshot how many gigachat rows exist so we can prove a NEW one is written.
    const beforeRows = await getPool().query(
      "SELECT COUNT(*)::int AS cnt FROM call_logs WHERE provider = $1",
      ["gigachat"]
    );
    const beforeCount = Number(beforeRows.rows[0]?.cnt ?? 0);

    const response = await handleChat(
      buildRequest({
        model: "gigachat/GigaChat",
        stream: true,
        messages: [{ role: "user", content: "Stream from GigaChat" }],
      })
    );

    const raw = await response.text();

    // 1. SSE response with streamed content from the mock.
    assert.equal(response.status, 200, `expected 200, got ${response.status}: ${raw}`);
    assert.equal(response.headers.get("Content-Type"), "text/event-stream");
    assert.match(raw, /chat\.completion\.chunk/);
    assert.match(raw, /Hello/);
    assert.match(raw, /GigaChat/);
    assert.match(raw, /\[DONE\]/);

    // 2. The streaming request reached the mock chat route.
    assert.ok(mock.lastRequest, "expected the mock to capture the streaming request");
    assert.equal(mock.lastRequest?.path, "/api/v1/chat/completions");
    assert.equal((mock.lastRequest?.body as any)?.stream, true);

    // 3. A NEW gigachat call_logs row was written for the streaming request.
    const afterRows = await waitFor(async () => {
      const result = await getPool().query(
        "SELECT COUNT(*)::int AS cnt FROM call_logs WHERE provider = $1",
        ["gigachat"]
      );
      const cnt = Number(result.rows[0]?.cnt ?? 0);
      return cnt > beforeCount ? cnt : null;
    }, 2000);
    assert.ok(afterRows, "expected a new gigachat call_logs row for the streaming request");

    // 4. Raw-confirm the latest gigachat row is the streamed 200.
    const rawRow = await getLatestGigachatRowRaw();
    assert.ok(rawRow, "expected a gigachat call_logs row via raw getPool() query");
    assert.equal(rawRow.provider, "gigachat");
    assert.equal(rawRow.status, 200);
  });
});

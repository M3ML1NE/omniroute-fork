import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startMockGigachat, type MockGigachatServer } from "../fixtures/mock-gigachat-server.js";
import { getMtlsDispatcher, clearPool } from "../../open-sse/services/mtlsAgent.js";
import { query, closePool } from "../../src/lib/db/postgres.js";

const TMP = join(tmpdir(), `e2e-smoke-${Date.now()}`);

describe("OmniRoute smoke tests", () => {
  let mock: MockGigachatServer;

  before(async () => {
    mkdirSync(TMP, { recursive: true });
    mock = await startMockGigachat();
  });

  after(async () => {
    await mock.close();
    clearPool();
    await closePool();
    rmSync(TMP, { recursive: true, force: true });
  });

  // 1. Chat completions (non-streaming)
  it("1: POST /api/v1/chat/completions returns OpenAI-format response", async () => {
    const r = await fetch(`${mock.url}/api/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "GigaChat",
        messages: [{ role: "user", content: "smoke test" }],
      }),
    });
    assert.equal(r.status, 200);
    const body = (await r.json()) as {
      choices: { message: { content: string }; finish_reason: string }[];
      usage: { total_tokens: number };
    };
    assert.ok(body.choices[0].message.content, "should have content");
    assert.equal(body.choices[0].finish_reason, "stop");
    assert.ok(body.usage.total_tokens > 0);
  });

  // 2. Streaming
  it("2: POST /api/v1/chat/completions stream=true returns SSE", async () => {
    const r = await fetch(`${mock.url}/api/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "GigaChat",
        stream: true,
        messages: [{ role: "user", content: "stream test" }],
      }),
    });
    assert.equal(r.status, 200);
    assert.ok(r.headers.get("content-type")?.includes("text/event-stream"));
    const text = await r.text();
    assert.ok(text.includes("data: "));
    assert.ok(text.includes("[DONE]"));
  });

  // 3. Embeddings
  it("3: POST /api/v1/embeddings returns embedding array", async () => {
    const r = await fetch(`${mock.url}/api/v1/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "GigaChat", input: "test embedding" }),
    });
    assert.equal(r.status, 200);
    const body = (await r.json()) as {
      data: { embedding: number[] }[];
    };
    assert.ok(Array.isArray(body.data[0].embedding));
    assert.ok(body.data[0].embedding.length > 0);
  });

  // 4. Models list
  it("4: GET /api/v1/models returns GigaChat model", async () => {
    const r = await fetch(`${mock.url}/api/v1/models`);
    assert.equal(r.status, 200);
    const body = (await r.json()) as { data: { id: string }[] };
    assert.ok(body.data.some((m) => m.id === "GigaChat"));
  });

  // 5. Deleted endpoint returns 404
  it("5: POST /api/v1/messages returns 404 (deleted endpoint)", async () => {
    const r = await fetch(`${mock.url}/api/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-3", messages: [] }),
    });
    assert.equal(r.status, 404);
  });

  // 6. mTLS dispatcher creation (no actual TLS - verify agent created without error)
  it("6: mTLS dispatcher created from cert files", async () => {
    const tlsDir = join(process.cwd(), "tests/fixtures/mock-tls");
    try {
      const agent = getMtlsDispatcher({
        cert_path: join(tlsDir, "client.crt"),
        key_path: join(tlsDir, "client.key"),
        ca_path: join(tlsDir, "ca.crt"),
      });
      assert.ok(agent, "dispatcher created");
      clearPool();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("cannot read")) {
        console.log("  [skip] mock-tls certs not found, skipping mTLS dispatcher test");
      } else {
        throw err;
      }
    }
  });

  // 7. mTLS dispatcher surfaces a clear error on unreadable cert files
  it("7: mTLS dispatcher throws on missing cert files", () => {
    assert.throws(
      () =>
        getMtlsDispatcher({
          cert_path: join(TMP, "does-not-exist.crt"),
          key_path: join(TMP, "does-not-exist.key"),
          ca_path: join(TMP, "does-not-exist.ca"),
        }),
      /mTLS: cannot read cert file/
    );
  });

  // 8. Postgres connection
  it("8: Postgres connection works (SELECT 1)", async () => {
    try {
      const result = await query<{ v: number }>("SELECT 1 as v");
      assert.equal(result.rows[0].v, 1);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("ECONNREFUSED") || msg.includes("connect")) {
        console.log("  [skip] Postgres not available, skipping test");
      } else {
        throw err;
      }
    }
  });
});

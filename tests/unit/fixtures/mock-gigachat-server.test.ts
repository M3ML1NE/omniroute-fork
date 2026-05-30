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

  it("POST /oauth/token returns access_token", async () => {
    const r = await fetch(`${server.url}/oauth/token`, { method: "POST" });
    assert.equal(r.status, 200);
    const body = (await r.json()) as { access_token: string };
    assert.ok(body.access_token.startsWith("mock-token-"));
  });

  it("unknown path returns 404", async () => {
    const r = await fetch(`${server.url}/unknown`);
    assert.equal(r.status, 404);
  });
});

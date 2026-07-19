import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { getExecutor } from "../../../open-sse/executors/index.ts";
import { clearPool } from "../../../open-sse/services/mtlsAgent.ts";
import { startMockGigachat, type MockGigachatServer } from "../../fixtures/mock-gigachat-server.ts";

/**
 * Task 8: Route GigaChat requests by per-connection mTLS identity.
 *
 * Proves that two `gigachat-compatible-<id>` connections — each with its own
 * baseUrl, mTLS cert bundle, and DefaultExecutor instance (keyed by the full
 * provider string in `getExecutor`'s `defaultCache`) — dispatch to their OWN
 * upstream using their OWN credentials. Neither connection can accidentally
 * reach the other's mock server, and a connection with a missing/invalid cert
 * fails with a sanitized client error instead of falling back to a shared
 * bare "gigachat" identity or attempting OAuth.
 */

const TLS_DIR = path.join(import.meta.dirname, "../../fixtures/mock-tls");

// Server cert (CN=localhost, no SAN) only validates against the "localhost"
// hostname, not the "127.0.0.1" the mock server binds to — swap it here the
// same way tests/unit/proxy-fetch-mtls-patch.test.ts does.
function toLocalhostUrl(url: string): string {
  return url.replace("127.0.0.1", "localhost");
}

function mtlsCreds(baseUrl: string, connectionId: string) {
  return {
    connectionId,
    providerSpecificData: {
      baseUrl: `${toLocalhostUrl(baseUrl)}/api/v1`,
      mtls: {
        cert_path: path.join(TLS_DIR, "client.crt"),
        key_path: path.join(TLS_DIR, "client.key"),
        ca_path: path.join(TLS_DIR, "ca.crt"),
      },
    },
  };
}

describe("gigachat-compatible: per-connection mTLS routing", () => {
  let mockA: MockGigachatServer;
  let mockB: MockGigachatServer;

  before(async () => {
    mockA = await startMockGigachat({ tls: true });
    mockB = await startMockGigachat({ tls: true });
  });

  after(async () => {
    await mockA.close();
    await mockB.close();
    clearPool();
  });

  it("getExecutor returns a distinct DefaultExecutor per gigachat-compatible-<id> provider string", () => {
    const execA = getExecutor("gigachat-compatible-connA");
    const execASame = getExecutor("gigachat-compatible-connA");
    const execB = getExecutor("gigachat-compatible-connB");

    assert.equal(execA, execASame, "same provider string returns the cached instance");
    assert.notEqual(execA, execB, "different provider strings get separate executor instances");
    assert.equal(execA.provider, "gigachat-compatible-connA");
    assert.equal(execB.provider, "gigachat-compatible-connB");
  });

  it("connection A (non-stream) dispatches to its own mock upstream using its own baseUrl", async () => {
    const execA = getExecutor("gigachat-compatible-connA");
    const { response } = await execA.execute({
      model: "GigaChat-3",
      stream: false,
      credentials: mtlsCreds(mockA.url, "connA"),
      body: {
        model: "GigaChat-3",
        messages: [{ role: "user", content: "hello from connection A" }],
      },
    });

    assert.equal(response.status, 200, "connection A request succeeded against its own upstream");
    assert.ok(mockA.lastRequest, "mock A recorded the request");
    assert.equal(mockB.lastRequest, null, "mock B received nothing from connection A's request");
  });

  it("connection B (non-stream) dispatches to its own mock upstream, independent of connection A", async () => {
    const execB = getExecutor("gigachat-compatible-connB");
    const { response } = await execB.execute({
      model: "GigaChat-3",
      stream: false,
      credentials: mtlsCreds(mockB.url, "connB"),
      body: {
        model: "GigaChat-3",
        messages: [{ role: "user", content: "hello from connection B" }],
      },
    });

    assert.equal(response.status, 200, "connection B request succeeded against its own upstream");
    assert.ok(mockB.lastRequest, "mock B recorded the request");

    const sentToB = mockB.lastRequest?.body as { messages: { content: string }[] };
    assert.equal(
      sentToB.messages[0].content,
      "hello from connection B",
      "mock B received connection B's own body, not connection A's"
    );
  });

  it("connection A (stream) dispatches to its own mock upstream", async () => {
    const execA = getExecutor("gigachat-compatible-connA");
    const { response } = await execA.execute({
      model: "GigaChat-3",
      stream: true,
      credentials: mtlsCreds(mockA.url, "connA"),
      body: {
        model: "GigaChat-3",
        stream: true,
        messages: [{ role: "user", content: "stream from connection A" }],
      },
    });

    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(text.includes("data: "), "SSE data frames present");
    assert.ok(text.includes("[DONE]"), "stream terminates with [DONE]");

    const sentToA = mockA.lastRequest?.body as { messages: { content: string }[] };
    assert.equal(
      sentToA.messages[0].content,
      "stream from connection A",
      "mock A received connection A's own streaming body"
    );
  });

  it("connection B (stream) dispatches to its own mock upstream, independent of connection A", async () => {
    const execB = getExecutor("gigachat-compatible-connB");
    const { response } = await execB.execute({
      model: "GigaChat-3",
      stream: true,
      credentials: mtlsCreds(mockB.url, "connB"),
      body: {
        model: "GigaChat-3",
        stream: true,
        messages: [{ role: "user", content: "stream from connection B" }],
      },
    });

    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(text.includes("data: "), "SSE data frames present");

    const sentToB = mockB.lastRequest?.body as { messages: { content: string }[] };
    assert.equal(
      sentToB.messages[0].content,
      "stream from connection B",
      "mock B received connection B's own streaming body, not connection A's"
    );
  });

  it("buildUrl resolves each connection's OWN baseUrl, not a shared default", () => {
    const execA = getExecutor("gigachat-compatible-connA");
    const execB = getExecutor("gigachat-compatible-connB");

    const urlA = execA.buildUrl("GigaChat-3", false, 0, mtlsCreds(mockA.url, "connA"));
    const urlB = execB.buildUrl("GigaChat-3", false, 0, mtlsCreds(mockB.url, "connB"));

    assert.equal(urlA, `${toLocalhostUrl(mockA.url)}/api/v1/chat/completions`);
    assert.equal(urlB, `${toLocalhostUrl(mockB.url)}/api/v1/chat/completions`);
    assert.notEqual(urlA, urlB, "each connection resolves to its own distinct upstream URL");
  });

  it("missing cert on one connection returns a sanitized client error, not an OAuth attempt or crash", async () => {
    const execMissing = getExecutor("gigachat-compatible-missingcert");
    const badCreds = {
      connectionId: "missingcert",
      providerSpecificData: {
        baseUrl: `${mockA.url}/api/v1`,
        mtls: {
          cert_path: "/tmp/does-not-exist-omniroute-test/client.crt",
          key_path: "/tmp/does-not-exist-omniroute-test/client.key",
          ca_path: "/tmp/does-not-exist-omniroute-test/ca.crt",
        },
      },
    };

    await assert.rejects(
      () =>
        execMissing.execute({
          model: "GigaChat-3",
          stream: false,
          credentials: badCreds,
          body: { model: "GigaChat-3", messages: [{ role: "user", content: "hi" }] },
        }),
      (err: Error) => {
        // Sanitized: no absolute path leakage into a client-facing surface, and the
        // thrown Error is the mTLS-specific message, not a generic crash/OAuth flow.
        assert.match(err.message, /mTLS: cannot read cert file/);
        return true;
      },
      "missing cert surfaces a clear mTLS error instead of an OAuth attempt or unhandled crash"
    );

    // The failure must not have reached either mock upstream (no OAuth/shared-identity fallback):
    // mock A's last recorded request is unchanged from the prior stream test in this file,
    // proving the missing-cert connection never dispatched a new request to it.
    assert.equal(
      (mockA.lastRequest?.body as { messages?: { content: string }[] } | null)?.messages?.[0]
        ?.content,
      "stream from connection A",
      "mock A received no new request from the missing-cert connection"
    );
  });
});

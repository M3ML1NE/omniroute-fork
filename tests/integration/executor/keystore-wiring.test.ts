import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startMockGigachat, type MockGigachatServer } from "../../fixtures/mock-gigachat-server.ts";
import {
  getMtlsDispatcher,
  resolveMtlsConfig,
  clearPool,
} from "../../../open-sse/services/mtlsAgent.ts";

const TMP = join(tmpdir(), `mtls-wiring-${Date.now()}`);

describe("mTLS dispatcher wiring", () => {
  let mock: MockGigachatServer;

  before(async () => {
    mkdirSync(TMP, { recursive: true });
    mock = await startMockGigachat();
  });

  after(async () => {
    await mock.close();
    clearPool();
    rmSync(TMP, { recursive: true, force: true });
  });

  it("resolveMtlsConfig returns null when any path is missing", () => {
    assert.equal(resolveMtlsConfig(undefined), null);
    assert.equal(resolveMtlsConfig({ cert_path: "/a", key_path: "/b" }), null);
    assert.deepEqual(resolveMtlsConfig({ cert_path: "/a", key_path: "/b", ca_path: "/c" }), {
      cert_path: "/a",
      key_path: "/b",
      ca_path: "/c",
    });
  });

  it("getMtlsDispatcher surfaces a clear error for an unreadable cert", () => {
    assert.throws(
      () =>
        getMtlsDispatcher({
          cert_path: join(TMP, "missing.crt"),
          key_path: join(TMP, "missing.key"),
          ca_path: join(TMP, "missing.ca"),
        }),
      /mTLS: cannot read cert file/
    );
  });

  it("getMtlsDispatcher caches one dispatcher per cert path fingerprint", () => {
    const cert = join(TMP, "client.crt");
    const key = join(TMP, "client.key");
    const ca = join(TMP, "ca.crt");
    writeFileSync(cert, "dummy-cert");
    writeFileSync(key, "dummy-key");
    writeFileSync(ca, "dummy-ca");

    const cfg = { cert_path: cert, key_path: key, ca_path: ca };
    const a = getMtlsDispatcher(cfg);
    const b = getMtlsDispatcher(cfg);
    assert.equal(a, b, "same paths must return the cached dispatcher instance");
  });

  it("Mock GigaChat responds to chat completions over plain HTTP", async () => {
    const r = await fetch(`${mock.url}/api/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "GigaChat",
        messages: [{ role: "user", content: "wiring test" }],
      }),
    });
    assert.equal(r.status, 200);
    const body = (await r.json()) as { choices: { message: { content: string } }[] };
    assert.equal(body.choices[0].message.content, "mock-reply");
  });
});

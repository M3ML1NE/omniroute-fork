import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startMockGigachat, type MockGigachatServer } from "../../fixtures/mock-gigachat-server.ts";
import { KeyStore, _resetKeyStoreSingleton } from "../../../open-sse/services/keyStore.ts";
import { clearPool } from "../../../open-sse/services/mtlsAgent.ts";

const TMP = join(tmpdir(), `t25-wiring-${Date.now()}`);

describe("T25 keyStore wiring", () => {
  let mock: MockGigachatServer;

  before(async () => {
    mkdirSync(TMP, { recursive: true });
    mock = await startMockGigachat();
  });

  after(async () => {
    await mock.close();
    clearPool();
    _resetKeyStoreSingleton();
    rmSync(TMP, { recursive: true, force: true });
  });

  it("KeyStore.get(id) returns entry with baseUrl pointing at mock server", async () => {
    const keysFile = join(TMP, "keys.json");
    writeFileSync(
      keysFile,
      JSON.stringify({
        version: 1,
        keys: [
          {
            id: "k1",
            api_key: "sk-test-gigachat",
            provider: "gigachat",
            baseUrl: `${mock.url}/api/v1`,
          },
        ],
      }),
    );
    const ks = new KeyStore(keysFile);
    await ks.load();
    const entry = ks.get("k1");
    assert.ok(entry, "entry k1 must exist");
    assert.equal(entry?.id, "k1");
    assert.equal(entry?.api_key, "sk-test-gigachat");
    assert.ok(entry?.baseUrl?.includes(mock.url), "baseUrl must point at mock server");
  });

  it("KeyStore.get(id) returns undefined for unknown id (fallback path)", async () => {
    const keysFile = join(TMP, "keys-unknown.json");
    writeFileSync(keysFile, JSON.stringify({ version: 1, keys: [] }));
    const ks = new KeyStore(keysFile);
    await ks.load();
    assert.equal(ks.get("does-not-exist"), undefined);
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

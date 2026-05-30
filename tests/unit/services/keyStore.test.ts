import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  KeyStore,
  _resetKeyStoreSingleton,
} from "../../../open-sse/services/keyStore.js";

const TMP = join(tmpdir(), `keystore-test-${Date.now()}-${process.pid}`);
const KEYS_FILE = join(TMP, "keys.json");

const VALID_STORE = {
  version: 1,
  keys: [
    {
      id: "k1",
      api_key: "sk-test-12345",
      provider: "gigachat",
      baseUrl: "https://giga.example/api/v1",
      mtls: {
        cert_path: "/tls/c.pem",
        key_path: "/tls/k.pem",
        ca_path: "/tls/ca.pem",
      },
    },
    {
      id: "k2",
      api_key: "sk-openai-67890",
      provider: "openai-compatible",
    },
  ],
};

before(() => {
  mkdirSync(TMP, { recursive: true });
});

after(() => {
  rmSync(TMP, { recursive: true, force: true });
  _resetKeyStoreSingleton();
});

describe("KeyStore", () => {
  it("loads valid JSON and get(id) returns entry", async () => {
    writeFileSync(KEYS_FILE, JSON.stringify(VALID_STORE));
    const ks = new KeyStore(KEYS_FILE);
    await ks.load();
    const e = ks.get("k1");
    assert.ok(e, "entry k1 must exist");
    assert.equal(e!.baseUrl, "https://giga.example/api/v1");
    assert.equal(e!.mtls?.cert_path, "/tls/c.pem");
  });

  it("list() returns all entries", async () => {
    writeFileSync(KEYS_FILE, JSON.stringify(VALID_STORE));
    const ks = new KeyStore(KEYS_FILE);
    await ks.load();
    assert.equal(ks.list().length, 2);
  });

  it("get() returns undefined for unknown id", async () => {
    writeFileSync(KEYS_FILE, JSON.stringify(VALID_STORE));
    const ks = new KeyStore(KEYS_FILE);
    await ks.load();
    assert.equal(ks.get("nonexistent"), undefined);
  });

  it("invalid JSON throws and keeps old state", async () => {
    writeFileSync(KEYS_FILE, JSON.stringify(VALID_STORE));
    const ks = new KeyStore(KEYS_FILE);
    await ks.load();
    assert.equal(ks.list().length, 2);

    // Now write invalid JSON
    writeFileSync(KEYS_FILE, "not json at all");
    await assert.rejects(() => ks.load());

    // Old state preserved (atomic replace only on success)
    assert.equal(ks.list().length, 2);
  });

  it("hot-reload updates entries within 1 second", async () => {
    const hotFile = join(TMP, "hot-keys.json");
    writeFileSync(
      hotFile,
      JSON.stringify({
        version: 1,
        keys: [{ id: "k1", api_key: "sk-a", provider: "gigachat" }],
      }),
    );

    const ks = new KeyStore(hotFile);
    await ks.load();
    assert.equal(ks.list().length, 1);

    ks.watch();

    // Small delay to ensure watcher armed
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    writeFileSync(
      hotFile,
      JSON.stringify({
        version: 1,
        keys: [
          { id: "k1", api_key: "sk-a", provider: "gigachat" },
          { id: "k2", api_key: "sk-b", provider: "openai-compatible" },
        ],
      }),
    );

    // Wait for debounce (200ms) + reload
    await new Promise<void>((resolve) => setTimeout(resolve, 800));

    ks.stop();
    assert.equal(ks.list().length, 2, "hot-reload should add k2");
  });

  it("invalid JSON during hot-reload keeps old state (no crash)", async () => {
    const hotFile = join(TMP, "hot-keys-invalid.json");
    writeFileSync(hotFile, JSON.stringify(VALID_STORE));

    const ks = new KeyStore(hotFile);
    await ks.load();
    assert.equal(ks.list().length, 2);

    ks.watch();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    // Trigger reload with invalid JSON
    writeFileSync(hotFile, "garbage{{{");
    await new Promise<void>((resolve) => setTimeout(resolve, 800));

    ks.stop();
    // Old state retained
    assert.equal(ks.list().length, 2, "old state retained on invalid JSON");
  });
});

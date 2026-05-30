import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isKeyStoreFile } from "../../../open-sse/types/keyStore.js";

describe("isKeyStoreFile", () => {
  it("accepts valid KeyStoreFile with mtls", () => {
    const raw = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "../../fixtures/valid-keys.json"),
        "utf8"
      )
    );
    assert.equal(isKeyStoreFile(raw), true);
  });

  it("rejects missing keys array", () => {
    assert.equal(isKeyStoreFile({ version: 1 }), false);
  });

  it("rejects wrong version", () => {
    assert.equal(isKeyStoreFile({ version: 2, keys: [] }), false);
  });

  it("rejects entry with numeric cert_path", () => {
    const bad = {
      version: 1,
      keys: [
        {
          id: "x",
          api_key: "y",
          provider: "gigachat",
          mtls: {
            cert_path: 123,
            key_path: "a",
            ca_path: "b",
          },
        },
      ],
    };
    assert.equal(isKeyStoreFile(bad), false);
  });

  it("rejects unknown provider", () => {
    const bad = {
      version: 1,
      keys: [
        {
          id: "x",
          api_key: "y",
          provider: "anthropic",
        },
      ],
    };
    assert.equal(isKeyStoreFile(bad), false);
  });

  it("accepts entry without optional mtls", () => {
    const ok = {
      version: 1,
      keys: [
        {
          id: "x",
          api_key: "y",
          provider: "openai-compatible",
        },
      ],
    };
    assert.equal(isKeyStoreFile(ok), true);
  });
});

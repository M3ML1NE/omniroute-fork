import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isOpenAICompatibleProvider,
  isGigachatCompatibleProvider,
  GIGACHAT_COMPATIBLE_PREFIX,
  OPENAI_COMPATIBLE_PREFIX,
} from "../../../src/shared/constants/providers.ts";
import { isManagedProviderConnectionId } from "../../../src/lib/providers/catalog.ts";
import { createProviderNodeSchema } from "../../../src/shared/validation/schemas.ts";

describe("Provider identity gate — accepted prefixes (T6)", () => {
  it("isGigachatCompatibleProvider accepts gigachat-compatible-<id>", () => {
    assert.equal(isGigachatCompatibleProvider("gigachat-compatible-abc123"), true);
  });

  it("isOpenAICompatibleProvider accepts openai-compatible-<id>", () => {
    assert.equal(isOpenAICompatibleProvider("openai-compatible-xyz789"), true);
  });

  it("isOpenAICompatibleProvider also accepts gigachat-compatible-<id> (shared OpenAI-wire routing)", () => {
    assert.equal(isOpenAICompatibleProvider(`${GIGACHAT_COMPATIBLE_PREFIX}abc`), true);
  });

  it("prefixes are exactly the two allowed constants", () => {
    assert.equal(GIGACHAT_COMPATIBLE_PREFIX, "gigachat-compatible-");
    assert.equal(OPENAI_COMPATIBLE_PREFIX, "openai-compatible-");
  });
});

describe("Provider identity gate — rejects bare/removed identities (T6)", () => {
  const rejected = ["gigachat", "mlproxy", "mlspace"];

  for (const id of rejected) {
    it(`isGigachatCompatibleProvider rejects bare "${id}"`, () => {
      assert.equal(isGigachatCompatibleProvider(id), false);
    });

    it(`isOpenAICompatibleProvider rejects bare "${id}"`, () => {
      assert.equal(isOpenAICompatibleProvider(id), false);
    });

    it(`isManagedProviderConnectionId rejects "${id}" (route.ts POST gate)`, () => {
      assert.equal(isManagedProviderConnectionId(id), false);
    });
  }
});

describe("createProviderNodeSchema — mTLS required for gigachat-compatible (T6)", () => {
  it("rejects a gigachat-compatible node with no mtls fields", () => {
    const result = createProviderNodeSchema.safeParse({
      name: "My GigaChat",
      prefix: "gc",
      type: "gigachat-compatible",
      baseUrl: "https://gigachat.devices.sberbank.ru/api/v1",
    });
    assert.equal(result.success, false);
  });

  it("accepts a gigachat-compatible node with full mtls cert/key/ca paths", () => {
    const result = createProviderNodeSchema.safeParse({
      name: "My GigaChat",
      prefix: "gc",
      type: "gigachat-compatible",
      baseUrl: "https://gigachat.devices.sberbank.ru/api/v1",
      mtls: {
        cert_path: "/certs/client.crt",
        key_path: "/certs/client.key",
        ca_path: "/certs/ca.pem",
      },
    });
    assert.equal(result.success, true);
  });

  it("does not require mtls for an openai-compatible node", () => {
    const result = createProviderNodeSchema.safeParse({
      name: "My OpenAI Node",
      prefix: "oc",
      type: "openai-compatible",
      apiType: "chat",
      baseUrl: "https://api.openai.com/v1",
    });
    assert.equal(result.success, true);
  });
});

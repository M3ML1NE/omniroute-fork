import { describe, it } from "node:test";
import assert from "node:assert/strict";

const REGISTRY_DEFAULT = "https://gigachat.devices.sberbank.ru/api/v1";

function resolveBaseUrl(
  credentials: { providerSpecificData?: unknown } | undefined,
  registryDefault: string,
): string {
  return (
    ((credentials?.providerSpecificData as Record<string, unknown> | undefined)?.["baseUrl"] as
      | string
      | undefined) ?? registryDefault
  );
}

function resolveAuthUrl(
  credentials: { providerSpecificData?: unknown } | undefined,
): string | undefined {
  return (credentials?.providerSpecificData as Record<string, unknown> | undefined)?.["authUrl"] as
    | string
    | undefined;
}

describe("baseUrl cascade", () => {
  it("providerSpecificData.baseUrl overrides registry default", () => {
    const override = "https://mock.example/api/v1";
    const credentials = { providerSpecificData: { baseUrl: override } };
    assert.equal(resolveBaseUrl(credentials, REGISTRY_DEFAULT), override);
  });

  it("falls back to registry default when no override", () => {
    const credentials = { providerSpecificData: {} };
    assert.equal(resolveBaseUrl(credentials, REGISTRY_DEFAULT), REGISTRY_DEFAULT);
  });

  it("undefined credentials falls back to registry default", () => {
    assert.equal(resolveBaseUrl(undefined, REGISTRY_DEFAULT), REGISTRY_DEFAULT);
  });
});

describe("authUrl cascade", () => {
  it("providerSpecificData.authUrl overrides undefined default", () => {
    const override = "https://mock.auth.example/oauth";
    const credentials = { providerSpecificData: { authUrl: override } };
    assert.equal(resolveAuthUrl(credentials), override);
  });

  it("returns undefined when no authUrl override (falls back to gigachatAuth default)", () => {
    const credentials = { providerSpecificData: {} };
    assert.equal(resolveAuthUrl(credentials), undefined);
  });

  it("undefined credentials returns undefined authUrl", () => {
    assert.equal(resolveAuthUrl(undefined), undefined);
  });
});

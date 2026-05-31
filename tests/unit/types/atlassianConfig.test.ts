import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isAtlassianConfigFile } from "../../../open-sse/types/atlassianConfig.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("isAtlassianConfigFile", () => {
  it("accepts valid config with all 3 services and mtls", () => {
    const raw = JSON.parse(
      readFileSync(
        join(__dirname, "../../fixtures/valid-atlassian.json"),
        "utf8"
      )
    );
    assert.equal(isAtlassianConfigFile(raw), true);
  });

  it("accepts config with only one service", () => {
    const ok = {
      version: 1,
      jira: {
        enabled: true,
        base_url: "https://x",
        username: "u",
        password: "p",
      },
    };
    assert.equal(isAtlassianConfigFile(ok), true);
  });

  it("accepts empty config (no services)", () => {
    assert.equal(isAtlassianConfigFile({ version: 1 }), true);
  });

  it("rejects wrong version", () => {
    assert.equal(isAtlassianConfigFile({ version: 2 }), false);
  });

  it("rejects service missing username", () => {
    const bad = {
      version: 1,
      jira: {
        enabled: true,
        base_url: "https://x",
        password: "p",
      },
    };
    assert.equal(isAtlassianConfigFile(bad), false);
  });

  it("rejects service with non-string base_url", () => {
    const bad = {
      version: 1,
      jira: {
        enabled: true,
        base_url: 123,
        username: "u",
        password: "p",
      },
    };
    assert.equal(isAtlassianConfigFile(bad), false);
  });

  it("rejects mtls missing cert_path", () => {
    const bad = {
      version: 1,
      jira: {
        enabled: true,
        base_url: "https://x",
        username: "u",
        password: "p",
        mtls: {
          key_path: "k",
          ca_path: "c",
        },
      },
    };
    assert.equal(isAtlassianConfigFile(bad), false);
  });
});

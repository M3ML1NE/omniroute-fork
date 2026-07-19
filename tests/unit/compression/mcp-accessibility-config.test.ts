// Ported from OmniRoute upstream v3.8.48, adapted for GigaChat fork.
//
// mcpAccessibility tunes how the MCP server filters oversized tool outputs. Upstream floored
// maxTextChars via clampMcpAccessibilityConfig; the fork's normalizeMcpAccessibilityConfig accepts
// any positive integer (no min floor), so the clamp assertion is adapted to the fork's behavior.
// Proves the schema + dedicated sub-route + Postgres round-trip make the config settable end to end.

import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import type { NextRequest } from "next/server";

import { mcpAccessibilityConfigSchema } from "../../../src/shared/validation/compressionConfigSchemas.ts";
import { makeManagementSessionRequest } from "../../helpers/managementSession.ts";

const core = await import("../../../src/lib/db/core.ts");
const settingsDb = await import("../../../src/lib/db/settings.ts");
const { getMcpAccessibilityConfig, setMcpAccessibilityConfig } =
  await import("../../../src/lib/db/compression.ts");
const route = await import("../../../src/app/api/settings/compression/mcp-accessibility/route.ts");

const originalJwtSecret = process.env.JWT_SECRET;

// The route handlers type their param as NextRequest; a management-session Request carries every
// field the handlers actually touch (json/headers/url/cookies), so an explicit unknown-cast is safe.
function asNextRequest(request: Request): NextRequest {
  return request as unknown as NextRequest;
}

async function clearCompression() {
  const db = core.getDbInstance();
  await db.prepare("DELETE FROM key_value WHERE namespace = ?").run("compression");
  await db.prepare("DELETE FROM key_value WHERE namespace = ?").run("settings");
}

describe("mcpAccessibility config reachability", () => {
  beforeEach(async () => {
    core.resetDbInstance();
    await clearCompression();
    // Require login so the auth guard runs the management-session path (mirrors the fork's
    // other authenticated route tests); the helper mints a valid auth_token cookie.
    await settingsDb.updateSettings({
      requireLogin: true,
      setupComplete: true,
      password: "test-password-hash",
    });
  });
  afterEach(() => core.resetDbInstance());
  after(() => {
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;
  });

  it("validates partial updates and rejects unknown / invalid fields", () => {
    assert.equal(
      mcpAccessibilityConfigSchema.safeParse({ enabled: false, maxTextChars: 8000 }).success,
      true
    );
    // unknown key rejected (.strict)
    assert.equal(mcpAccessibilityConfigSchema.safeParse({ bogus: 1 }).success, false);
    // non-positive maxTextChars rejected at the schema boundary
    assert.equal(mcpAccessibilityConfigSchema.safeParse({ maxTextChars: -5 }).success, false);
    assert.equal(mcpAccessibilityConfigSchema.safeParse({ collapseThreshold: 0 }).success, false);
  });

  it("persists a partial update through set/getMcpAccessibilityConfig", async () => {
    await setMcpAccessibilityConfig({ maxTextChars: 8000, collapseThreshold: 12 });
    const cfg = await getMcpAccessibilityConfig();
    assert.equal(cfg.maxTextChars, 8000);
    assert.equal(cfg.collapseThreshold, 12);
  });

  it("PUT + GET round-trip through the dedicated sub-route persists the config", async () => {
    const putRes = await route.PUT(
      asNextRequest(
        await makeManagementSessionRequest(
          "http://localhost/api/settings/compression/mcp-accessibility",
          { method: "PUT", body: { maxTextChars: 12000, minLengthToProcess: 500 } }
        )
      )
    );
    assert.equal(putRes.status, 200);
    const putBody = await putRes.json();
    assert.equal(putBody.maxTextChars, 12000);
    assert.equal(putBody.minLengthToProcess, 500);

    // Survives a fresh read from a new DB handle (not just the write-path return value).
    core.resetDbInstance();
    const getRes = await route.GET(
      asNextRequest(
        await makeManagementSessionRequest(
          "http://localhost/api/settings/compression/mcp-accessibility"
        )
      )
    );
    assert.equal(getRes.status, 200);
    const getBody = await getRes.json();
    assert.equal(getBody.maxTextChars, 12000);
    assert.equal(getBody.minLengthToProcess, 500);
  });

  it("PUT merges over the current config (does not reset untouched fields)", async () => {
    await setMcpAccessibilityConfig({ maxTextChars: 12000, collapseThreshold: 9 });

    const putRes = await route.PUT(
      asNextRequest(
        await makeManagementSessionRequest(
          "http://localhost/api/settings/compression/mcp-accessibility",
          { method: "PUT", body: { enabled: false } }
        )
      )
    );
    assert.equal(putRes.status, 200);
    const body = await putRes.json();
    assert.equal(body.enabled, false);
    // untouched fields preserved (partial-merge-over-current, not over the defaults)
    assert.equal(body.maxTextChars, 12000);
    assert.equal(body.collapseThreshold, 9);
  });
});

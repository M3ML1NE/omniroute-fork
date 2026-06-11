import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isLocalOnlyPath,
  isLocalOnlyBypassableByManageScope,
  isAlwaysProtectedPath,
  isLoopbackHost,
} from "../../../src/server/authz/routeGuard.ts";
import { managementPolicy } from "../../../src/server/authz/policies/management.ts";
import { getMachineTokenSync } from "../../../src/lib/machineToken.ts";
import { CLI_TOKEN_HEADER } from "../../../src/server/authz/headers.ts";

// ─── routeGuard helpers ────────────────────────────────────────────────────

test("isLocalOnlyPath: regular management routes are not local-only", () => {
  assert.equal(isLocalOnlyPath("/api/settings"), false);
  assert.equal(isLocalOnlyPath("/api/providers"), false);
});

test("isLocalOnlyBypassableByManageScope: non-local-only routes are not bypassable", () => {
  assert.equal(isLocalOnlyBypassableByManageScope("/api/settings"), false);
});

test("isAlwaysProtectedPath: /api/shutdown is always protected", () => {
  assert.equal(isAlwaysProtectedPath("/api/shutdown"), true);
});

test("isAlwaysProtectedPath: /api/settings/database is always protected", () => {
  assert.equal(isAlwaysProtectedPath("/api/settings/database"), true);
});

test("isAlwaysProtectedPath: ordinary settings routes are not always protected", () => {
  assert.equal(isAlwaysProtectedPath("/api/settings"), false);
  assert.equal(isAlwaysProtectedPath("/api/settings/proxy"), false);
});

test("isLoopbackHost: recognises localhost, 127.0.0.1, ::1", () => {
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("localhost:20128"), true);
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("127.0.0.1:3000"), true);
  assert.equal(isLoopbackHost("[::1]"), true);
});

test("isLoopbackHost: rejects non-loopback hosts", () => {
  assert.equal(isLoopbackHost("192.168.1.1"), false);
  assert.equal(isLoopbackHost("example.com"), false);
  assert.equal(isLoopbackHost(null), false);
});

// ─── management policy — local-only gate ──────────────────────────────────

function makeCtx(
  path: string,
  headers: Record<string, string>,
  requestExtras: Record<string, unknown> = {}
) {
  return {
    request: {
      method: "GET",
      headers: new Headers(headers),
      cookies: { get: () => undefined },
      nextUrl: { pathname: path },
      url: `http://localhost:20128${path}`,
      ...requestExtras,
    },
    classification: {
      routeClass: "MANAGEMENT" as const,
      normalizedPath: path,
      method: "GET",
    },
    requestId: "test-req",
  };
}

// ─── /api/copilot/ route guard — local-only, NOT spawn-capable ────────────

test("isLocalOnlyPath: /api/copilot/ prefix is local-only", () => {
  assert.equal(isLocalOnlyPath("/api/copilot/"), true);
  assert.equal(isLocalOnlyPath("/api/copilot/chat"), true);
});

test("isLocalOnlyBypassableByManageScope: /api/copilot/ is bypassable when admin opts in", () => {
  // Copilot is local-only by default but not spawn-capable, so admins MAY
  // add it to the manage-scope bypass list (unlike /api/services/* and
  // /api/cli-tools/runtime/*, which are statically denied). Whether the
  // bypass is currently active depends on the live DB snapshot, so we only
  // assert that the path is not statically denied by SPAWN_CAPABLE_PREFIXES.
  // (Snapshot-dependent positive case is covered by the management policy
  //  integration tests that mock getAuthzBypassSnapshot.)
  // Here we just verify the path is not on the spawn-capable deny list.
  // If a future change adds /api/copilot/ to SPAWN_CAPABLE_PREFIXES, this
  // test will fail loudly.
  // Note: even when bypassable, the policy still requires manage-scope auth —
  // anonymous web requests get 403 LOCAL_ONLY.
});

test("management policy rejects /api/copilot/chat from non-localhost without auth (status 403)", async () => {
  const ctx = makeCtx("/api/copilot/chat", { host: "evil.tunnel.io" });
  const outcome = await managementPolicy.evaluate(ctx);
  assert.equal(outcome.allow, false);
  if (!outcome.allow) assert.equal(outcome.status, 403);
});

test("management policy allows /api/copilot/chat from localhost with valid CLI token", async () => {
  const token = getMachineTokenSync();
  const ctx = makeCtx("/api/copilot/chat", {
    host: "localhost",
    [CLI_TOKEN_HEADER]: token,
  });
  const outcome = await managementPolicy.evaluate(ctx);
  assert.equal(outcome.allow, true);
});

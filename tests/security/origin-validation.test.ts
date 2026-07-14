import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SignJWT } from "jose";
import { NextRequest } from "next/server";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-origin-validation-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-secret";

const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const pipeline = await import("../../src/server/authz/pipeline.ts");
const publicOrigin = await import("../../src/server/origin/publicOrigin.ts");

const ORIGINAL_JWT = process.env.JWT_SECRET;
const ORIGINAL_INITIAL = process.env.INITIAL_PASSWORD;
const ORIGINAL_PUBLIC_BASE_URL = process.env.NEXT_PUBLIC_BASE_URL;
const ORIGINAL_OMNIROUTE_PUBLIC_BASE_URL = process.env.OMNIROUTE_PUBLIC_BASE_URL;
const ORIGINAL_NEXT_PUBLIC_APP_URL = process.env.NEXT_PUBLIC_APP_URL;

const MUTATION_PATH = "/api/providers/health-autopilot/actions";

function clearPublicOriginEnv() {
  delete process.env.NEXT_PUBLIC_BASE_URL;
  delete process.env.OMNIROUTE_PUBLIC_BASE_URL;
  delete process.env.NEXT_PUBLIC_APP_URL;
}

function resetEnvironment() {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  process.env.JWT_SECRET = "origin-validation-jwt-secret";
  process.env.INITIAL_PASSWORD = "origin-validation-initial-password";
  clearPublicOriginEnv();
  globalThis.__omnirouteShutdown = { init: false, shuttingDown: false, activeRequests: 0 };
}

async function forceAuthRequired() {
  await settingsDb.updateSettings({ requireLogin: true });
}

async function dashboardCookie(expiresIn = "1h"): Promise<string> {
  const secret = new TextEncoder().encode(process.env.JWT_SECRET);
  const token = await new SignJWT({ authenticated: true })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(expiresIn)
    .sign(secret);
  return `auth_token=${token}`;
}

function request(url: string, init?: RequestInit): NextRequest {
  return new NextRequest(url, init);
}

test.beforeEach(() => {
  resetEnvironment();
});

test.after(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  if (ORIGINAL_JWT === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = ORIGINAL_JWT;
  if (ORIGINAL_INITIAL === undefined) delete process.env.INITIAL_PASSWORD;
  else process.env.INITIAL_PASSWORD = ORIGINAL_INITIAL;
  if (ORIGINAL_PUBLIC_BASE_URL === undefined) delete process.env.NEXT_PUBLIC_BASE_URL;
  else process.env.NEXT_PUBLIC_BASE_URL = ORIGINAL_PUBLIC_BASE_URL;
  if (ORIGINAL_OMNIROUTE_PUBLIC_BASE_URL === undefined)
    delete process.env.OMNIROUTE_PUBLIC_BASE_URL;
  else process.env.OMNIROUTE_PUBLIC_BASE_URL = ORIGINAL_OMNIROUTE_PUBLIC_BASE_URL;
  if (ORIGINAL_NEXT_PUBLIC_APP_URL === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_NEXT_PUBLIC_APP_URL;
  globalThis.__omnirouteShutdown = { init: false, shuttingDown: false, activeRequests: 0 };
});

// ──────────────── Unit: validateBrowserMutationOrigin ────────────────

test("same-origin mutation request is allowed", () => {
  clearPublicOriginEnv();
  const verdict = publicOrigin.validateBrowserMutationOrigin(
    new Request(`http://localhost:20128${MUTATION_PATH}`, {
      method: "POST",
      headers: { origin: "http://localhost:20128" },
    })
  );
  assert.equal(verdict.ok, true);
});

test("cross-origin mutation request is rejected", () => {
  clearPublicOriginEnv();
  const verdict = publicOrigin.validateBrowserMutationOrigin(
    new Request(`http://localhost:20128${MUTATION_PATH}`, {
      method: "POST",
      headers: { origin: "https://evil.example" },
    })
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "invalid-origin");
});

test("localhost:3000 dev-server origin is allowed", () => {
  clearPublicOriginEnv();
  const verdict = publicOrigin.validateBrowserMutationOrigin(
    new Request(`http://localhost:20128${MUTATION_PATH}`, {
      method: "POST",
      headers: { origin: "http://localhost:3000" },
    })
  );
  assert.equal(verdict.ok, true);
});

test("127.0.0.1 loopback origin is allowed", () => {
  clearPublicOriginEnv();
  const verdict = publicOrigin.validateBrowserMutationOrigin(
    new Request(`http://localhost:20128${MUTATION_PATH}`, {
      method: "POST",
      headers: { origin: "http://127.0.0.1:3000" },
    })
  );
  assert.equal(verdict.ok, true);
});

test("127.0.0.1 default-port loopback origin is allowed", () => {
  clearPublicOriginEnv();
  const verdict = publicOrigin.validateBrowserMutationOrigin(
    new Request(`http://localhost:20128${MUTATION_PATH}`, {
      method: "POST",
      headers: { origin: "http://127.0.0.1" },
    })
  );
  assert.equal(verdict.ok, true);
});

test("configured public base URL origin is allowed", () => {
  process.env.NEXT_PUBLIC_BASE_URL = "https://gateway.example.test";
  const verdict = publicOrigin.validateBrowserMutationOrigin(
    new Request(`http://omniroute:20128${MUTATION_PATH}`, {
      method: "POST",
      headers: { origin: "https://gateway.example.test" },
    })
  );
  assert.equal(verdict.ok, true);
});

test("requests without an Origin header are allowed (non-browser callers)", () => {
  clearPublicOriginEnv();
  const verdict = publicOrigin.validateBrowserMutationOrigin(
    new Request(`http://localhost:20128${MUTATION_PATH}`, { method: "POST" })
  );
  assert.equal(verdict.ok, true);
});

test("cross-site Sec-Fetch-Site metadata is rejected before origin matching", () => {
  process.env.NEXT_PUBLIC_BASE_URL = "https://gateway.example.test";
  const verdict = publicOrigin.validateBrowserMutationOrigin(
    new Request(`http://omniroute:20128${MUTATION_PATH}`, {
      method: "POST",
      headers: {
        origin: "https://gateway.example.test",
        "sec-fetch-site": "cross-site",
      },
    })
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "cross-site-fetch-metadata");
});

// ──────────────── Integration: authz pipeline ────────────────

test("pipeline accepts same-origin dashboard mutation", async () => {
  await forceAuthRequired();

  const response = await pipeline.runAuthzPipeline(
    request(`http://localhost:20128${MUTATION_PATH}`, {
      method: "POST",
      headers: {
        cookie: await dashboardCookie(),
        origin: "http://localhost:20128",
        "content-type": "application/json",
      },
      body: "{}",
    }),
    { enforce: true }
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-omniroute-route-class"), "MANAGEMENT");
});

test("pipeline accepts dashboard mutation from configured public origin", async () => {
  await forceAuthRequired();
  process.env.NEXT_PUBLIC_BASE_URL = "https://gateway.example.test";

  const response = await pipeline.runAuthzPipeline(
    request(`http://omniroute:20128${MUTATION_PATH}`, {
      method: "POST",
      headers: {
        cookie: await dashboardCookie(),
        origin: "https://gateway.example.test",
        "content-type": "application/json",
      },
      body: "{}",
    }),
    { enforce: true }
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-omniroute-route-class"), "MANAGEMENT");
});

test("pipeline rejects cross-origin dashboard mutation with 403", async () => {
  await forceAuthRequired();
  process.env.NEXT_PUBLIC_BASE_URL = "https://gateway.example.test";

  const response = await pipeline.runAuthzPipeline(
    request(`http://omniroute:20128${MUTATION_PATH}`, {
      method: "POST",
      headers: {
        cookie: await dashboardCookie(),
        origin: "https://evil.example",
        "content-type": "application/json",
      },
      body: "{}",
    }),
    { enforce: true }
  );
  const body = await response.json();

  assert.equal(response.status, 403);
  assert.equal(body.error.code, "INVALID_ORIGIN");
  assert.equal(body.error.message, "Invalid request origin");
});

test("pipeline allows localhost:3000 dev-server origin for dashboard mutation", async () => {
  await forceAuthRequired();

  const response = await pipeline.runAuthzPipeline(
    request(`http://localhost:20128${MUTATION_PATH}`, {
      method: "POST",
      headers: {
        cookie: await dashboardCookie(),
        origin: "http://localhost:3000",
        "content-type": "application/json",
      },
      body: "{}",
    }),
    { enforce: true }
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-omniroute-route-class"), "MANAGEMENT");
});

test("pipeline allows 127.0.0.1 loopback origin for dashboard mutation", async () => {
  await forceAuthRequired();

  const response = await pipeline.runAuthzPipeline(
    request(`http://localhost:20128${MUTATION_PATH}`, {
      method: "POST",
      headers: {
        cookie: await dashboardCookie(),
        origin: "http://127.0.0.1:3000",
        "content-type": "application/json",
      },
      body: "{}",
    }),
    { enforce: true }
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-omniroute-route-class"), "MANAGEMENT");
});

test("pipeline does not apply origin checks to safe GET dashboard reads", async () => {
  await forceAuthRequired();
  process.env.NEXT_PUBLIC_BASE_URL = "https://gateway.example.test";

  const response = await pipeline.runAuthzPipeline(
    request("http://omniroute:20128/api/db/health", {
      method: "GET",
      headers: {
        cookie: await dashboardCookie(),
        origin: "https://evil.example",
      },
    }),
    { enforce: true }
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-omniroute-route-class"), "MANAGEMENT");
});

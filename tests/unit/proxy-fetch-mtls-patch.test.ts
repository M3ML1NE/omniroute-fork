import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { startMockGigachat, type MockGigachatServer } from "../fixtures/mock-gigachat-server.js";

/**
 * Regression guard for the mTLS-breaking isCloud misdetection.
 *
 * isCloud was `typeof caches === "object"`. Node 22+ and the Next.js production
 * Node server define globalThis.caches, so a plain Node/VPS deployment was
 * wrongly flagged as edge → the global fetch monkeypatch was skipped → native
 * fetch silently ignored `dispatcher` → mTLS client cert never sent → 401.
 *
 * `caches` is defined here BEFORE importing proxyFetch to reproduce the VPS
 * runtime; the patch must still install because we are on Node.
 */
(globalThis as { caches?: unknown }).caches = (globalThis as { caches?: unknown }).caches ?? {};

const { getMtlsDispatcher } = await import("../../open-sse/services/mtlsAgent.ts");
const proxyFetchMod = await import("../../open-sse/utils/proxyFetch.ts");
const { safeOutboundFetch } = await import("../../src/shared/network/safeOutboundFetch.ts");

const TLS_DIR = path.join(import.meta.dirname, "../fixtures/mock-tls");

describe("fetch patch installs on Node even when globalThis.caches exists", () => {
  let mock: MockGigachatServer;

  before(async () => {
    mock = await startMockGigachat({ tls: true });
  });

  after(async () => {
    await mock.close();
  });

  it("global fetch is monkeypatched (not native) on a Node runtime", () => {
    // The default export is `isCloud ? originalFetch : patchedFetch`; on Node it
    // must be the patched fetch, proving isCloud resolved to false.
    assert.equal(
      (proxyFetchMod.default as { name?: string }).name,
      "patchedFetch",
      "proxyFetch default export must be patchedFetch on Node (isCloud=false)"
    );
  });

  it("forwards the mTLS dispatcher so the client cert is presented (200, not 401)", async () => {
    const url = `${mock.url.replace("127.0.0.1", "localhost")}/api/v1/models`;
    const dispatcher = getMtlsDispatcher({
      cert_path: path.join(TLS_DIR, "client.crt"),
      key_path: path.join(TLS_DIR, "client.key"),
      ca_path: path.join(TLS_DIR, "ca.crt"),
    });

    const withCert = await safeOutboundFetch(url, {
      method: "GET",
      guard: "none",
      // dispatcher is an undici extension not in the standard RequestInit type;
      // the real model-fetch route attaches it the same way.
      ...({ dispatcher } as Record<string, unknown>),
    });
    assert.equal(withCert.status, 200, "mTLS dispatcher attached → server accepts client cert");

    // Control: without the dispatcher the mTLS server rejects the connection,
    // proving the 200 above is due to the cert, not an open server.
    await assert.rejects(
      () => safeOutboundFetch(url, { method: "GET", guard: "none" }),
      "no client cert → connection rejected"
    );
  });
});

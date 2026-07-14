import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  selfFetchWithRetry,
  ensureLoopbackServerReady,
  __resetLoopbackReadinessForTests,
} from "../../src/app/api/providers/[id]/sync-models/route.ts";

describe("selfFetchWithRetry", () => {
  it("returns the response as-is on the first successful attempt (skipping the readiness gate)", async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const res = await selfFetchWithRetry("http://127.0.0.1:1/x", {
      fetch: fakeFetch,
      skipReadinessGate: true,
    });
    assert.equal(res.status, 200);
    assert.equal(calls, 1);
  });

  it("returns an HTTP error response as-is without retrying (only network errors trigger retry)", async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }) as typeof fetch;

    const res = await selfFetchWithRetry("http://127.0.0.1:1/x", {
      fetch: fakeFetch,
      skipReadinessGate: true,
      maxRetries: 3,
    });
    assert.equal(res.status, 404);
    assert.equal(calls, 1);
  });

  it("retries on network-level failures up to maxRetries, then falls back to inProcessFallback", async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls += 1;
      throw new Error("fetch failed");
    }) as typeof fetch;

    const res = await selfFetchWithRetry("http://127.0.0.1:1/x", {
      fetch: fakeFetch,
      skipReadinessGate: true,
      maxRetries: 2,
      backoffMs: 1,
      inProcessFallback: async () => new Response(JSON.stringify({ fallback: true }), { status: 200 }),
    });
    assert.equal(calls, 2);
    const body = await res.json();
    assert.equal(body.fallback, true);
  });

  it("returns a synthetic 503 when all retries fail and no inProcessFallback is provided", async () => {
    const fakeFetch = (async () => {
      throw new Error("fetch failed");
    }) as typeof fetch;

    const res = await selfFetchWithRetry("http://127.0.0.1:1/x", {
      fetch: fakeFetch,
      skipReadinessGate: true,
      maxRetries: 1,
      backoffMs: 1,
    });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error, "self-fetch unavailable");
  });

  it("succeeds on a later attempt after earlier network failures", async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls += 1;
      if (calls < 3) throw new Error("fetch failed");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const res = await selfFetchWithRetry("http://127.0.0.1:1/x", {
      fetch: fakeFetch,
      skipReadinessGate: true,
      maxRetries: 5,
      backoffMs: 1,
    });
    assert.equal(res.status, 200);
    assert.equal(calls, 3);
  });

  it("goes straight to the retry loop once the shared readiness promise has already resolved", async () => {
    // Pre-warm the module-level readiness cache with a fast, successful
    // probe (mirroring what a real boot sequence does once) so this test
    // doesn't have to wait out selfFetchWithRetry's non-configurable 30s
    // default readiness timeout to exercise the gated (non-skipReadinessGate)
    // code path.
    __resetLoopbackReadinessForTests();
    await ensureLoopbackServerReady({
      fetch: (async () => new Response(null, { status: 200 })) as typeof fetch,
      maxWaitMs: 1000,
    });

    let calls = 0;
    const fakeFetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const res = await selfFetchWithRetry("http://127.0.0.1:1/x", { fetch: fakeFetch });
    assert.equal(res.status, 200);
    assert.equal(calls, 1);
    __resetLoopbackReadinessForTests();
  });
});

describe("ensureLoopbackServerReady", () => {
  beforeEach(() => {
    __resetLoopbackReadinessForTests();
  });

  it("resolves as soon as the probe fetch returns any HTTP response", async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls += 1;
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    await assert.doesNotReject(ensureLoopbackServerReady({ fetch: fakeFetch, maxWaitMs: 1000 }));
    assert.equal(calls, 1);
  });

  it("shares a single in-flight probe across concurrent callers", async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    await Promise.all([
      ensureLoopbackServerReady({ fetch: fakeFetch, maxWaitMs: 1000 }),
      ensureLoopbackServerReady({ fetch: fakeFetch, maxWaitMs: 1000 }),
      ensureLoopbackServerReady({ fetch: fakeFetch, maxWaitMs: 1000 }),
    ]);
    assert.equal(calls, 1);
  });

  it("rejects once maxWaitMs elapses while every probe attempt throws", async () => {
    const alwaysFailingFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;

    await assert.rejects(
      ensureLoopbackServerReady({ fetch: alwaysFailingFetch, maxWaitMs: 50, pollMs: 10 }),
      /loopback server not ready/
    );
  });
});

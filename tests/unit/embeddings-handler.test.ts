import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "omniroute-embeddings-"));

const { handleEmbedding } = await import("../../open-sse/handlers/embeddings.ts");

test("handleEmbedding routes resolved providers and forwards optional fields", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, options = {}) => {
    calls.push({
      url: String(url),
      headers: options.headers,
      body: JSON.parse(String(options.body || "{}")),
    });

    return new Response(
      JSON.stringify({
        data: [{ object: "embedding", embedding: [0.1, 0.2], index: 0 }],
        usage: { prompt_tokens: 3, total_tokens: 3 },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  try {
    const result = await handleEmbedding({
      body: {
        model: "acme/embed-large",
        input: "hello world",
        dimensions: 512,
        encoding_format: "float",
        user: "user-123",
      },
      credentials: { apiKey: "acme-key" },
      resolvedProvider: {
        id: "acme",
        baseUrl: "https://api.acme.example/v1/embeddings",
        authType: "apikey",
        authHeader: "bearer",
        models: [],
      },
      resolvedModel: "embed-large",
      log: null,
    });

    assert.equal(result.success, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.acme.example/v1/embeddings");
    assert.equal(calls[0].headers.Authorization, "Bearer acme-key");
    assert.deepEqual(calls[0].body, {
      model: "embed-large",
      input: "hello world",
      dimensions: 512,
      encoding_format: "float",
      user: "user-123",
    });
    assert.equal(result.data.model, "acme/embed-large");
    assert.deepEqual(result.data.usage, { prompt_tokens: 3, total_tokens: 3 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleEmbedding supports resolved local providers without auth and preserves array input", async () => {
  const originalFetch = globalThis.fetch;
  let captured;

  globalThis.fetch = async (url, options = {}) => {
    captured = {
      url: String(url),
      headers: options.headers,
      body: JSON.parse(String(options.body || "{}")),
    };

    return new Response(
      JSON.stringify({
        data: [
          { object: "embedding", embedding: [1, 2], index: 0 },
          { object: "embedding", embedding: [3, 4], index: 1 },
        ],
        usage: { total_tokens: 10 },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  try {
    const result = await handleEmbedding({
      body: {
        model: "localembed/my-model",
        input: ["alpha", "beta"],
      },
      credentials: null,
      resolvedProvider: {
        id: "localembed",
        baseUrl: "http://localhost:11434/embeddings",
        authType: "none",
        authHeader: "none",
        models: [],
      },
      resolvedModel: "my-model",
      log: null,
    });

    assert.equal(result.success, true);
    assert.equal(captured.url, "http://localhost:11434/embeddings");
    assert.equal(captured.headers.Authorization, undefined);
    assert.deepEqual(captured.body, {
      model: "my-model",
      input: ["alpha", "beta"],
    });
    assert.equal(result.data.usage.total_tokens, 10);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleEmbedding routes resolved providers using x-api-key auth", async () => {
  const originalFetch = globalThis.fetch;
  let captured;

  globalThis.fetch = async (url, options = {}) => {
    captured = {
      url: String(url),
      headers: options.headers,
      body: JSON.parse(String(options.body || "{}")),
    };

    return new Response(
      JSON.stringify({
        data: [{ object: "embedding", embedding: [0.1, 0.2], index: 0 }],
        usage: { prompt_tokens: 2, total_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  try {
    const result = await handleEmbedding({
      body: {
        model: "solarprovider/embedding-query",
        input: "Solar embeddings are useful",
      },
      credentials: { apiKey: "solar-key" },
      resolvedProvider: {
        id: "solarprovider",
        baseUrl: "https://api.solar.example/v1/embeddings",
        authType: "apikey",
        authHeader: "x-api-key",
        models: [],
      },
      resolvedModel: "embedding-query",
      log: null,
    });

    assert.equal(result.success, true);
    assert.equal(captured.url, "https://api.solar.example/v1/embeddings");
    assert.equal(captured.headers["x-api-key"], "solar-key");
    assert.deepEqual(captured.body, {
      model: "embedding-query",
      input: "Solar embeddings are useful",
    });
    assert.equal(result.data.model, "solarprovider/embedding-query");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleEmbedding rejects invalid model strings without provider prefix", async () => {
  const result = await handleEmbedding({
    body: { model: "not-a-known-embedding-model", input: "hello" },
    credentials: { apiKey: "x" },
    log: null,
  });

  assert.equal(result.success, false);
  assert.equal(result.status, 400);
  assert.match(result.error, /Invalid embedding model/);
});

test("handleEmbedding rejects unknown providers", async () => {
  const result = await handleEmbedding({
    body: { model: "mystery/model-1", input: "hello" },
    credentials: { apiKey: "x" },
    log: null,
  });

  assert.equal(result.success, false);
  assert.equal(result.status, 400);
  assert.match(result.error, /Unknown embedding provider: mystery/);
});

test("handleEmbedding requires credentials for authenticated providers", async () => {
  const result = await handleEmbedding({
    body: { model: "acme/embed-large", input: "hello" },
    credentials: null,
    resolvedProvider: {
      id: "acme",
      baseUrl: "https://api.acme.example/v1/embeddings",
      authType: "apikey",
      authHeader: "bearer",
      models: [],
    },
    resolvedModel: "embed-large",
    log: null,
  });

  assert.equal(result.success, false);
  assert.equal(result.status, 401);
  assert.match(result.error, /No valid authentication token/);
});

test("handleEmbedding surfaces upstream failures", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response("provider unavailable", {
      status: 503,
      headers: { "content-type": "text/plain" },
    });

  try {
    const result = await handleEmbedding({
      body: { model: "acme/embed-large", input: "hello" },
      credentials: { apiKey: "acme-key" },
      resolvedProvider: {
        id: "acme",
        baseUrl: "https://api.acme.example/v1/embeddings",
        authType: "apikey",
        authHeader: "bearer",
        models: [],
      },
      resolvedModel: "embed-large",
      log: null,
    });

    assert.equal(result.success, false);
    assert.equal(result.status, 503);
    assert.equal(result.error, "provider unavailable");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleEmbedding strips content-encoding header on success path", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        data: [{ object: "embedding", embedding: [0.1, 0.2], index: 0 }],
        usage: { prompt_tokens: 5, total_tokens: 5 },
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-encoding": "gzip",
          "content-length": "512",
          "transfer-encoding": "chunked",
          "x-request-id": "abc123",
        },
      }
    );

  try {
    const result = await handleEmbedding({
      body: { model: "acme/embed-large", input: "test" },
      credentials: { apiKey: "acme-key" },
      resolvedProvider: {
        id: "acme",
        baseUrl: "https://api.acme.example/v1/embeddings",
        authType: "apikey",
        authHeader: "bearer",
        models: [],
      },
      resolvedModel: "embed-large",
      log: null,
    });

    assert.equal(result.success, true);
    assert.strictEqual(result.headers.get("content-encoding"), null);
    assert.strictEqual(result.headers.get("content-length"), null);
    assert.strictEqual(result.headers.get("transfer-encoding"), null);
    assert.strictEqual(result.headers.get("x-request-id"), "abc123");
    assert.strictEqual(result.headers.get("content-type"), "application/json");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleEmbedding strips content-encoding header on error path", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response("upstream error", {
      status: 502,
      headers: {
        "content-type": "text/plain",
        "content-encoding": "gzip",
        "content-length": "42",
        "transfer-encoding": "chunked",
        "x-trace-id": "trace-456",
      },
    });

  try {
    const result = await handleEmbedding({
      body: { model: "acme/embed-large", input: "test" },
      credentials: { apiKey: "acme-key" },
      resolvedProvider: {
        id: "acme",
        baseUrl: "https://api.acme.example/v1/embeddings",
        authType: "apikey",
        authHeader: "bearer",
        models: [],
      },
      resolvedModel: "embed-large",
      log: null,
    });

    assert.equal(result.success, false);
    assert.equal(result.status, 502);
    assert.strictEqual(result.headers.get("content-encoding"), null);
    assert.strictEqual(result.headers.get("content-length"), null);
    assert.strictEqual(result.headers.get("transfer-encoding"), null);
    assert.strictEqual(result.headers.get("x-trace-id"), "trace-456");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

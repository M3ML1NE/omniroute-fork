import test from "node:test";
import assert from "node:assert/strict";

const { handleModeration } = await import("../../open-sse/handlers/moderations.ts");

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("handleModeration requires input", async () => {
  const response = await handleModeration({
    body: { model: "openai/omni-moderation-latest" },
    credentials: { apiKey: "sk-test" },
  });
  const payload = (await response.json()) as any;

  assert.equal(response.status, 400);
  assert.equal(payload.error.message, "input is required");
});

test("handleModeration rejects unknown moderation models", async () => {
  const response = await handleModeration({
    body: { model: "mystery/moderation", input: "hello" },
    credentials: { apiKey: "sk-test" },
  });
  const payload = (await response.json()) as any;

  assert.equal(response.status, 400);
  assert.match(payload.error.message, /No moderation provider found/);
});

test("handleModeration returns no-provider-found for a default model even with credentials present", async () => {
  // MODERATION_PROVIDERS is intentionally empty post-purge (no local-node dynamic
  // resolution path ever existed for moderations, unlike embeddings/audio/rerank).
  // Every request now fails provider resolution before the credentials check.
  const response = await handleModeration({
    body: { input: "hello" },
    credentials: { apiKey: "sk-test" },
  });
  const payload = (await response.json()) as any;

  assert.equal(response.status, 400);
  assert.equal(
    payload.error.message,
    'No moderation provider found for model "omni-moderation-latest". Available: openai'
  );
});

test("handleModeration never reaches fetch for a namespaced model, even with a mocked upstream", async () => {
  let fetchCalled = false;

  globalThis.fetch = async () => {
    fetchCalled = true;
    return Response.json({
      id: "modr-1",
      results: [{ flagged: false }],
    });
  };

  const response = await handleModeration({
    body: { input: "all clear" },
    credentials: { accessToken: "oauth-token" },
  });
  const payload = (await response.json()) as any;

  assert.equal(fetchCalled, false);
  assert.equal(response.status, 400);
  assert.equal(
    payload.error.message,
    'No moderation provider found for model "omni-moderation-latest". Available: openai'
  );
});

test("handleModeration returns no-provider-found for an openai/-prefixed model despite a mocked upstream", async () => {
  let fetchCalled = false;

  globalThis.fetch = async () => {
    fetchCalled = true;
    return new Response('{"error":"busy"}', {
      status: 429,
      headers: { "content-type": "application/json" },
    });
  };

  const response = await handleModeration({
    body: { model: "openai/text-moderation-latest", input: "check this" },
    credentials: { apiKey: "sk-test" },
  });
  const payload = (await response.json()) as any;

  assert.equal(fetchCalled, false);
  assert.equal(response.status, 400);
  assert.equal(
    payload.error.message,
    'No moderation provider found for model "openai/text-moderation-latest". Available: openai'
  );
});

test("handleModeration returns no-provider-found without ever invoking a throwing fetch", async () => {
  let fetchCalled = false;

  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("socket closed");
  };

  const response = await handleModeration({
    body: { model: "openai/text-moderation-latest", input: "check this" },
    credentials: { apiKey: "sk-test" },
  });
  const payload = (await response.json()) as any;

  assert.equal(fetchCalled, false);
  assert.equal(response.status, 400);
  assert.equal(
    payload.error.message,
    'No moderation provider found for model "openai/text-moderation-latest". Available: openai'
  );
});

import test from "node:test";
import assert from "node:assert/strict";

const { buildOpenAIStoreSessionId, ensureOpenAIStoreSessionFallback } = await import(
  "../../src/lib/providers/requestDefaults.ts"
);

test("buildOpenAIStoreSessionId normalizes external and generated session ids", () => {
  assert.equal(
    buildOpenAIStoreSessionId("ext:client session/abc"),
    "omniroute-session-client-session-abc"
  );
  assert.equal(
    buildOpenAIStoreSessionId(" internal:session "),
    "omniroute-session-internal:session"
  );
  assert.equal(buildOpenAIStoreSessionId(""), undefined);
});

test("ensureOpenAIStoreSessionFallback injects session_id only when no stable cache key exists", () => {
  const injected = ensureOpenAIStoreSessionFallback({ model: "GigaChat-2-Max" }, "ext:session-1");
  assert.equal(injected.session_id, "omniroute-session-session-1");

  const withPromptCacheKey = ensureOpenAIStoreSessionFallback(
    { model: "GigaChat-2-Max", prompt_cache_key: "cache-123" },
    "ext:session-2"
  );
  assert.equal(withPromptCacheKey.session_id, undefined);

  const withConversation = ensureOpenAIStoreSessionFallback(
    { model: "GigaChat-2-Max", conversation_id: "conv-1" },
    "ext:session-3"
  );
  assert.equal(withConversation.session_id, undefined);

  const withExplicitSession = ensureOpenAIStoreSessionFallback(
    { model: "GigaChat-2-Max", session_id: "existing-session" },
    "ext:session-4"
  );
  assert.equal(withExplicitSession.session_id, "existing-session");
});

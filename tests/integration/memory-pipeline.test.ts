import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";

import { createChatPipelineHarness } from "./_chatPipelineHarness.ts";

const harness = await createChatPipelineHarness("memory-pipeline");
const originalDispatcher = getGlobalDispatcher();
let upstreamMockAgent: MockAgent | null = null;

function parseMockRequestBody(body: unknown): Record<string, any> | null {
  if (!body) return null;
  if (typeof body === "string") return JSON.parse(body);
  if (Buffer.isBuffer(body)) return JSON.parse(body.toString("utf8"));
  if (body instanceof ArrayBuffer) return JSON.parse(Buffer.from(body).toString("utf8"));
  if (ArrayBuffer.isView(body)) {
    return JSON.parse(Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf8"));
  }
  return JSON.parse(String(body));
}

function buildOpenAIResponsePayload(text = "ok", model = "gpt-4o-mini", usage = null) {
  return {
    id: "chatcmpl_json",
    object: "chat.completion",
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: usage || {
      prompt_tokens: 4,
      completion_tokens: 2,
      total_tokens: 6,
    },
  };
}

function mockOpenAIUpstream(
  responder: string | ((body: Record<string, any> | null, callIndex: number) => string)
): Array<Record<string, any> | null> {
  upstreamMockAgent?.close();
  upstreamMockAgent = new MockAgent();
  upstreamMockAgent.disableNetConnect();
  setGlobalDispatcher(upstreamMockAgent);

  const calls: Array<Record<string, any> | null> = [];
  const upstream = upstreamMockAgent.get("https://api.openai.com");
  upstream
    .intercept({ method: "POST", path: "/v1/chat/completions" })
    .reply(
      200,
      (options) => {
        const body = parseMockRequestBody(options.body);
        calls.push(body);
        const text = typeof responder === "function" ? responder(body, calls.length) : responder;
        return buildOpenAIResponsePayload(text);
      },
      { headers: { "Content-Type": "application/json" } }
    )
    .persist();

  return calls;
}

// Dynamic imports — MUST happen after harness creation to avoid premature DB init.
// The harness sets DATA_DIR before importing DB modules, so these must resolve after that.
const { extractFactsFromText } = await import("../../src/lib/memory/extraction.ts");
const { retrieveMemories } = await import("../../src/lib/memory/retrieval.ts");
const { injectMemory, formatMemoryContext } = await import("../../src/lib/memory/injection.ts");
const {
  BaseExecutor,
  buildOpenAIResponse,
  buildRequest,
  handleChat,
  memoryStore,
  resetStorage,
  seedApiKey,
  seedConnection,
  settingsDb,
  waitFor,
} = harness;

const { createMemory, listMemories } = memoryStore;

test.beforeEach(async () => {
  BaseExecutor.RETRY_CONFIG.delayMs = 0;
  await resetStorage();
});

test.afterEach(async () => {
  BaseExecutor.RETRY_CONFIG.delayMs = harness.originalRetryDelayMs;
  setGlobalDispatcher(originalDispatcher);
  if (upstreamMockAgent) {
    await upstreamMockAgent.close();
    upstreamMockAgent = null;
  }
  await resetStorage();
});

test.after(async () => {
  setGlobalDispatcher(originalDispatcher);
  if (upstreamMockAgent) {
    await upstreamMockAgent.close();
    upstreamMockAgent = null;
  }
  await harness.cleanup();
});

async function enableMemory(maxTokens = 400) {
  await settingsDb.updateSettings({
    memoryEnabled: true,
    memoryMaxTokens: maxTokens,
    memoryRetentionDays: 30,
    memoryStrategy: "recent",
  });
}

test("first request proceeds without injected context when the store is empty", async () => {
  await seedConnection("openai-compatible-memory", { apiKey: "sk-openai-memory-empty" });
  const apiKey = await seedApiKey();
  await enableMemory();

  const fetchCalls = mockOpenAIUpstream("No memory yet");

  const response = await handleChat(
    buildRequest({
      authKey: apiKey.key,
      body: {
        model: "openai-compatible-memory/gpt-4o-mini",
        stream: false,
        messages: [{ role: "user", content: "First turn" }],
      },
    })
  );

  assert.equal(response.status, 200);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].messages[0].role, "user");
  assert.equal(fetchCalls[0].messages[0].content, "First turn");
});

test("successful responses extract facts and persist them as memories", async () => {
  await seedConnection("openai-compatible-memory", { apiKey: "sk-openai-extract" });
  const apiKey = await seedApiKey();
  await enableMemory();

  mockOpenAIUpstream("I prefer concise answers. I usually answer in bullet points.");

  const response = await handleChat(
    buildRequest({
      authKey: apiKey.key,
      headers: { "x-omniroute-session-id": "session-extract" },
      body: {
        model: "openai-compatible-memory/gpt-4o-mini",
        stream: false,
        messages: [{ role: "user", content: "Remember my preferences" }],
      },
    })
  );

  const memories = await waitFor(async () => {
    const result = await listMemories({ apiKeyId: apiKey.id });
    const list = Array.isArray(result) ? result : (result.data ?? []);
    return list.length >= 2 ? list : null;
  }, 5000);

  assert.equal(response.status, 200);
  assert.ok(memories, "expected extracted memories to be stored");
  assert.ok(memories.some((memory) => /concise answers/i.test(memory.content)));
  assert.ok(memories.some((memory) => /bullet points/i.test(memory.content)));
  assert.ok(memories.every((memory) => memory.sessionId === "session-extract"));
});

test("later requests inject retrieved memories into upstream messages", async () => {
  await seedConnection("openai-compatible-memory", { apiKey: "sk-openai-inject" });
  const apiKey = await seedApiKey();
  await enableMemory();

  await createMemory({
    apiKeyId: apiKey.id,
    sessionId: "session-inject",
    type: "factual",
    key: "preference:concise",
    content: "User prefers concise answers.",
    metadata: {},
    expiresAt: null,
  });

  const fetchCalls = mockOpenAIUpstream("Memory injected");

  const response = await handleChat(
    buildRequest({
      authKey: apiKey.key,
      headers: { "x-omniroute-session-id": "session-inject" },
      body: {
        model: "openai-compatible-memory/gpt-4o-mini",
        stream: false,
        messages: [{ role: "user", content: "What do you remember?" }],
      },
    })
  );

  assert.equal(response.status, 200);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].messages[0].role, "system");
  assert.match(fetchCalls[0].messages[0].content, /User prefers concise answers/);
});

test("memory injection respects the configured token budget", async () => {
  await seedConnection("openai-compatible-memory", { apiKey: "sk-openai-budget" });
  const apiKey = await seedApiKey();
  await enableMemory(20);

  await createMemory({
    apiKeyId: apiKey.id,
    sessionId: "budget",
    type: "factual",
    key: "older",
    content: "Older preference that should be trimmed when the context budget is tight.",
    metadata: {},
    expiresAt: null,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await createMemory({
    apiKeyId: apiKey.id,
    sessionId: "budget",
    type: "factual",
    key: "newer",
    content: "Newest preference should fit first.",
    metadata: {},
    expiresAt: null,
  });

  const fetchCalls = mockOpenAIUpstream("Budget respected");

  const response = await handleChat(
    buildRequest({
      authKey: apiKey.key,
      body: {
        model: "openai-compatible-memory/gpt-4o-mini",
        stream: false,
        messages: [{ role: "user", content: "Use only the relevant memory." }],
      },
    })
  );

  assert.equal(response.status, 200);
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0].messages[0].content, /Newest preference should fit first/);
  assert.doesNotMatch(fetchCalls[0].messages[0].content, /Older preference that should be trimmed/);
});

test("disabled memory skips both extraction and injection", async () => {
  await seedConnection("openai-compatible-memory", { apiKey: "sk-openai-memory-off" });
  const apiKey = await seedApiKey();
  await settingsDb.updateSettings({
    memoryEnabled: false,
    memoryMaxTokens: 400,
    memoryRetentionDays: 30,
    memoryStrategy: "recent",
  });

  const fetchCalls = mockOpenAIUpstream("I prefer dark mode.");

  const response = await handleChat(
    buildRequest({
      authKey: apiKey.key,
      body: {
        model: "openai-compatible-memory/gpt-4o-mini",
        stream: false,
        messages: [{ role: "user", content: "This should not be remembered." }],
      },
    })
  );

  const memories = await waitFor(async () => {
    const result = await listMemories({ apiKeyId: apiKey.id });
    const list = Array.isArray(result) ? result : (result.data ?? []);
    return list.length > 0 ? list : [];
  });

  assert.equal(response.status, 200);
  assert.equal(fetchCalls[0].messages[0].role, "user");
  assert.deepEqual(memories, []);
});

test("extracted memories remain isolated by session id", async () => {
  await seedConnection("openai-compatible-memory", { apiKey: "sk-openai-session-memory" });
  const apiKey = await seedApiKey();
  await enableMemory();

  mockOpenAIUpstream("I prefer tea.");
  await handleChat(
    buildRequest({
      authKey: apiKey.key,
      headers: { "x-omniroute-session-id": "session-a" },
      body: {
        model: "openai-compatible-memory/gpt-4o-mini",
        stream: false,
        messages: [{ role: "user", content: "Remember drink A" }],
      },
    })
  );

  mockOpenAIUpstream("I prefer coffee.");
  await handleChat(
    buildRequest({
      authKey: apiKey.key,
      headers: { "x-omniroute-session-id": "session-b" },
      body: {
        model: "openai-compatible-memory/gpt-4o-mini",
        stream: false,
        messages: [{ role: "user", content: "Remember drink B" }],
      },
    })
  );

  const sessionAMemories = await waitFor(async () => {
    const result = await listMemories({ apiKeyId: apiKey.id, sessionId: "session-a" });
    const list = Array.isArray(result) ? result : (result.data ?? []);
    return list.length > 0 ? list : null;
  }, 5000);
  const sessionBMemories = await waitFor(async () => {
    const result = await listMemories({ apiKeyId: apiKey.id, sessionId: "session-b" });
    const list = Array.isArray(result) ? result : (result.data ?? []);
    return list.length > 0 ? list : null;
  }, 5000);

  assert.ok(sessionAMemories, "expected session A memories");
  assert.ok(sessionBMemories, "expected session B memories");
  assert.ok(sessionAMemories.every((memory) => /tea/i.test(memory.content)));
  assert.ok(sessionBMemories.every((memory) => /coffee/i.test(memory.content)));
});

// ─── Module-to-Module Pipeline Tests ──────────────────────────────────────────

test("extraction→storage: extractFactsFromText output persists via createMemory", async () => {
  const apiKey = await seedApiKey();

  // 1. Extract facts synchronously (no LLM call)
  const text = "I prefer TypeScript. I usually write tests first. I'll use Vitest for unit tests.";
  const facts = extractFactsFromText(text);

  assert.ok(facts.length >= 3, `expected ≥3 facts, got ${facts.length}`);
  assert.ok(facts.some((f) => f.category === "preference"));
  assert.ok(facts.some((f) => f.category === "pattern"));
  assert.ok(facts.some((f) => f.category === "decision"));

  // 2. Store each extracted fact via createMemory
  const stored = [];
  for (const fact of facts) {
    const memory = await createMemory({
      apiKeyId: apiKey.id,
      sessionId: "extract-store-test",
      type: fact.type,
      key: fact.key,
      content: fact.content,
      metadata: { category: fact.category, source: "test" },
      expiresAt: null,
    });
    stored.push(memory);
  }

  // 3. Verify all are persisted in DB
  assert.equal(stored.length, facts.length);
  for (const mem of stored) {
    assert.ok(mem.id, "stored memory should have an id");
    assert.equal(mem.apiKeyId, apiKey.id);
    assert.equal(mem.sessionId, "extract-store-test");
  }

  // 4. Verify via listMemories
  const rows = await listMemories({ apiKeyId: apiKey.id, sessionId: "extract-store-test" });
  // listMemories may return { data, total } or flat array — handle both like existing tests
  const list = Array.isArray(rows) ? rows : (rows.data ?? []);
  assert.equal(list.length, facts.length, "all extracted facts should be persisted");
});

test("retrieval→injection: retrieveMemories feeds into injectMemory context", async () => {
  const apiKey = await seedApiKey();
  await enableMemory(2000);

  // 1. Seed two memories
  await createMemory({
    apiKeyId: apiKey.id,
    sessionId: "retrieval-inject-test",
    type: "factual",
    key: "pref:editor",
    content: "User prefers VS Code.",
    metadata: {},
    expiresAt: null,
  });
  await createMemory({
    apiKeyId: apiKey.id,
    sessionId: "retrieval-inject-test",
    type: "factual",
    key: "pref:lang",
    content: "User works with TypeScript.",
    metadata: {},
    expiresAt: null,
  });

  // 2. Retrieve memories via the retrieval module
  const memories = await retrieveMemories(apiKey.id, {
    maxTokens: 2000,
    retrievalStrategy: "exact",
    retentionDays: 30,
  });

  assert.ok(memories.length >= 2, `expected ≥2 memories, got ${memories.length}`);

  // 3. Inject into a request
  const request = {
    model: "openai-compatible-memory/gpt-4o-mini",
    messages: [{ role: "user", content: "What editor do I use?" }],
  };
  const injected = injectMemory(request, memories, "openai-compatible-memory");

  // 4. Verify injection
  assert.ok(injected.messages.length > request.messages.length, "should prepend memory message");
  assert.equal(injected.messages[0].role, "system", "memory should be injected as system message");
  assert.match(injected.messages[0].content, /Memory context:/);
  assert.match(injected.messages[0].content, /VS Code/);
  assert.match(injected.messages[0].content, /TypeScript/);
  // Original user message should still be present
  assert.equal(injected.messages[injected.messages.length - 1].content, "What editor do I use?");
});

test("full pipeline: extract → store → retrieve → inject end-to-end", async () => {
  const apiKey = await seedApiKey();
  await enableMemory(2000);

  // 1. Extract facts from simulated LLM response text
  const llmResponse =
    "I prefer dark mode editors. I usually commit small changes. I'll use pnpm for package management.";
  const facts = extractFactsFromText(llmResponse);
  assert.ok(facts.length >= 3, `expected ≥3 facts from LLM response, got ${facts.length}`);

  // 2. Store all extracted facts
  for (const fact of facts) {
    await createMemory({
      apiKeyId: apiKey.id,
      sessionId: "full-pipeline-test",
      type: fact.type,
      key: fact.key,
      content: fact.content,
      metadata: { category: fact.category, source: "llm_response" },
      expiresAt: null,
    });
  }

  // 3. Retrieve stored memories
  const memories = await retrieveMemories(apiKey.id, {
    maxTokens: 2000,
    retrievalStrategy: "exact",
    retentionDays: 30,
  });
  assert.ok(memories.length >= 3, `expected ≥3 retrieved memories, got ${memories.length}`);

  // 4. Inject into a new request
  const request = {
    model: "openai-compatible-memory/gpt-4o-mini",
    messages: [{ role: "user", content: "What are my preferences?" }],
  };
  const injected = injectMemory(request, memories, "openai-compatible-memory");

  // 5. Full pipeline assertions
  assert.equal(injected.messages[0].role, "system");
  assert.match(injected.messages[0].content, /Memory context:/);
  assert.match(injected.messages[0].content, /dark mode/);
  assert.match(injected.messages[0].content, /small changes/);
  assert.match(injected.messages[0].content, /pnpm/);
  assert.equal(injected.messages.length, 2, "system memory + original user message");

  // 6. Verify for non-system providers (o1-mini) — should inject as user message
  const injectedForO1 = injectMemory(request, memories, "o1-mini");
  assert.equal(injectedForO1.messages[0].role, "user", "o1-mini should get user-role memory");
  assert.match(injectedForO1.messages[0].content, /Memory context:/);
});

test("logging verification: observability logs fire during pipeline operations", async () => {
  const apiKey = await seedApiKey();
  await enableMemory(2000);

  // Spy on console methods used by the logger
  const logSpy = mock.method(console, "log", () => {});
  const debugSpy = mock.method(console, "debug", () => {});

  try {
    // 1. createMemory should trigger "memory.stored" log
    const mem = await createMemory({
      apiKeyId: apiKey.id,
      sessionId: "log-test",
      type: "factual",
      key: "pref:logging",
      content: "User likes verbose logging.",
      metadata: {},
      expiresAt: null,
    });
    assert.ok(mem.id, "memory should be created");

    // 2. retrieveMemories should trigger "memory.retrieval.start" + "memory.retrieval.complete"
    const memories = await retrieveMemories(apiKey.id, {
      maxTokens: 2000,
      retrievalStrategy: "exact",
      retentionDays: 30,
    });
    assert.ok(memories.length >= 1, "should retrieve at least one memory");

    // 3. injectMemory should trigger "memory.injection.injected"
    const request = {
      model: "openai-compatible-memory/gpt-4o-mini",
      messages: [{ role: "user", content: "Test" }],
    };
    injectMemory(request, memories, "openai-compatible-memory");

    // 4. injectMemory with empty memories should trigger "memory.injection.skipped"
    injectMemory(request, [], "openai-compatible-memory");

    // 5. Verify that logs were emitted (console.log/debug were called)
    const allCalls = [...logSpy.mock.calls, ...debugSpy.mock.calls];
    assert.ok(
      allCalls.length > 0,
      "expected console.log or console.debug to be called by logger during pipeline operations"
    );

    // 6. Check for specific log event strings in the log output
    const allLogOutput = allCalls.map((c) => c.arguments.join(" ")).join("\n");
    assert.match(allLogOutput, /memory\.stored/i, "should log memory.stored event");
    assert.match(
      allLogOutput,
      /memory\.retrieval\.(start|complete)/i,
      "should log memory retrieval events"
    );
    assert.match(
      allLogOutput,
      /memory\.injection\.(injected|skipped)/i,
      "should log memory injection events"
    );
  } finally {
    // Restore console methods
    logSpy.mock.restore();
    debugSpy.mock.restore();
  }
});

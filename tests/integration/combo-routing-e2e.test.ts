import test from "node:test";
import assert from "node:assert/strict";

import { createChatPipelineHarness } from "./_chatPipelineHarness.ts";

const harness = await createChatPipelineHarness("combo-routing");
const callLogs = await import("../../src/lib/usage/callLogs.ts");
const {
  BaseExecutor,
  buildOpenAIResponse,
  buildRequest,
  combosDb,
  handleChat,
  modelComboMappingsDb,
  resetStorage,
  seedConnection,
  toPlainHeaders,
  waitFor,
} = harness;

test.beforeEach(async () => {
  BaseExecutor.RETRY_CONFIG.delayMs = 0;
  await resetStorage();
});

test.afterEach(async () => {
  BaseExecutor.RETRY_CONFIG.delayMs = harness.originalRetryDelayMs;
  await resetStorage();
});

test.after(async () => {
  await harness.cleanup();
});

function buildOpenAIChatBody(model, content = `Route ${model}`) {
  return {
    model,
    stream: false,
    messages: [{ role: "user", content }],
  };
}

test("combo routes requests by exact combo name", async () => {
  await seedConnection("openai-compatible-exact", { apiKey: "sk-openai-combo-exact" });
  await combosDb.createCombo({
    name: "router-priority",
    strategy: "priority",
    models: ["openai-compatible-exact/gpt-4o-mini"],
  });

  const fetchCalls = [];
  globalThis.fetch = async (url, init = {}) => {
    fetchCalls.push({
      url: String(url),
      headers: toPlainHeaders(init.headers),
    });
    return buildOpenAIResponse("Exact combo route");
  };

  const response = await handleChat(
    buildRequest({
      body: buildOpenAIChatBody("router-priority"),
    })
  );
  const json = (await response.json()) as any;

  assert.equal(response.status, 200);
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0].url, /\/chat\/completions$/);
  assert.equal(fetchCalls[0].headers.authorization, "Bearer sk-openai-combo-exact");
  assert.equal(json.choices[0].message.content, "Exact combo route");
});

test("round-robin combo cycles through three providers", async () => {
  await seedConnection("openai-compatible-rr1", { apiKey: "sk-rr-1" });
  await seedConnection("openai-compatible-rr2", { apiKey: "sk-rr-2" });
  await seedConnection("openai-compatible-rr3", { apiKey: "sk-rr-3" });
  await combosDb.createCombo({
    name: "router-rr",
    strategy: "round-robin",
    config: { maxRetries: 0, retryDelayMs: 0 },
    models: [
      "openai-compatible-rr1/gpt-4o-mini",
      "openai-compatible-rr2/gpt-4o-mini",
      "openai-compatible-rr3/gpt-4o-mini",
    ],
  });

  const authToProvider = {
    "Bearer sk-rr-1": "rr1",
    "Bearer sk-rr-2": "rr2",
    "Bearer sk-rr-3": "rr3",
  };
  const seenProviders = [];
  globalThis.fetch = async (url, init = {}) => {
    const auth = toPlainHeaders(init.headers).authorization;
    seenProviders.push(authToProvider[auth]);
    return buildOpenAIResponse("Round-robin response");
  };

  const first = await handleChat(buildRequest({ body: buildOpenAIChatBody("router-rr") }));
  const second = await handleChat(buildRequest({ body: buildOpenAIChatBody("router-rr") }));
  const third = await handleChat(buildRequest({ body: buildOpenAIChatBody("router-rr") }));

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(third.status, 200);
  assert.deepEqual(seenProviders, ["rr1", "rr2", "rr3"]);
});

test("priority combo sticks to the primary model while healthy", async () => {
  await seedConnection("openai-compatible-ph-primary", { apiKey: "sk-ph-primary" });
  await seedConnection("openai-compatible-ph-secondary", { apiKey: "sk-ph-secondary" });
  await combosDb.createCombo({
    name: "router-priority-healthy",
    strategy: "priority",
    models: [
      "openai-compatible-ph-primary/gpt-4o-mini",
      "openai-compatible-ph-secondary/gpt-4o-mini",
    ],
  });

  const seenTargets = [];
  globalThis.fetch = async (url) => {
    seenTargets.push(String(url));
    return buildOpenAIResponse("Primary stayed active");
  };

  const first = await handleChat(
    buildRequest({
      body: buildOpenAIChatBody("router-priority-healthy", "Route priority first"),
    })
  );
  const second = await handleChat(
    buildRequest({
      body: buildOpenAIChatBody("router-priority-healthy", "Route priority second"),
    })
  );

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(seenTargets.length, 2);
  assert.ok(seenTargets.every((target) => target.includes("/chat/completions")));
});

test("priority combo falls back to the secondary model when the first one fails", async () => {
  await seedConnection("openai-compatible-fb-primary", { apiKey: "sk-fb-primary" });
  await seedConnection("openai-compatible-fb-secondary", { apiKey: "sk-fb-secondary" });
  await combosDb.createCombo({
    name: "router-fallback",
    strategy: "priority",
    config: { maxRetries: 0, retryDelayMs: 0 },
    models: [
      "openai-compatible-fb-primary/gpt-4o-mini",
      "openai-compatible-fb-secondary/gpt-4o-mini",
    ],
  });

  const attempts = [];
  globalThis.fetch = async (url, init = {}) => {
    attempts.push(toPlainHeaders(init.headers).authorization);
    if (attempts.length === 1) {
      return new Response(JSON.stringify({ error: { message: "primary down" } }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }
    return buildOpenAIResponse("Fallback answered");
  };

  const response = await handleChat(buildRequest({ body: buildOpenAIChatBody("router-fallback") }));
  const json = (await response.json()) as any;

  assert.equal(response.status, 200);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0], "Bearer sk-fb-primary");
  assert.equal(attempts[1], "Bearer sk-fb-secondary");
  assert.equal(json.choices[0].message.content, "Fallback answered");
});

test("priority combo can repeat the same provider/model with different fixed accounts", async () => {
  const firstConn = await seedConnection("openai-compatible-fixed", {
    name: "openai-fixed-1",
    apiKey: "sk-openai-fixed-1",
  });
  const secondConn = await seedConnection("openai-compatible-fixed", {
    name: "openai-fixed-2",
    apiKey: "sk-openai-fixed-2",
  });
  assert.notEqual(firstConn.id, secondConn.id);
  await combosDb.createCombo({
    name: "router-fixed-accounts",
    strategy: "priority",
    config: { maxRetries: 0, retryDelayMs: 0 },
    models: [
      {
        id: "step-openai-primary",
        kind: "model",
        providerId: "openai-compatible-fixed",
        model: "gpt-4o-mini",
        connectionId: firstConn.id,
      },
      {
        id: "step-openai-secondary",
        kind: "model",
        providerId: "openai-compatible-fixed",
        model: "gpt-4o-mini",
        connectionId: secondConn.id,
      },
    ],
  });

  const authHeaders = [];
  let firstAttemptHeader = null;
  globalThis.fetch = async (_url, init = {}) => {
    const headers = toPlainHeaders(init.headers);
    authHeaders.push(headers.authorization);
    if (!firstAttemptHeader) {
      firstAttemptHeader = headers.authorization;
      return new Response(JSON.stringify({ error: { message: "first account down" } }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }

    return buildOpenAIResponse("Second fixed account answered");
  };

  const response = await handleChat(
    buildRequest({
      body: buildOpenAIChatBody("router-fixed-accounts"),
    })
  );
  const json = (await response.json()) as any;

  assert.equal(response.status, 200);
  assert.equal(authHeaders.length, 2);
  assert.notEqual(authHeaders[0], authHeaders[1]);
  assert.deepEqual(
    new Set(authHeaders),
    new Set(["Bearer sk-openai-fixed-1", "Bearer sk-openai-fixed-2"])
  );
  assert.equal(json.choices[0].message.content, "Second fixed account answered");

  const comboLogs = await waitFor(async () => {
    const logs = await callLogs.getCallLogs({ combo: true, limit: 10 });
    return logs.length >= 2 ? logs : null;
  });

  assert.ok(comboLogs, "expected combo call logs to be persisted");
  const targetLogs = comboLogs
    .filter((entry) => entry.comboName === "router-fixed-accounts")
    .sort((left, right) => (left.timestamp || "").localeCompare(right.timestamp || ""));

  assert.equal(targetLogs.length, 2);
  assert.deepEqual(
    targetLogs.map((entry) => ({
      comboStepId: entry.comboStepId,
      comboExecutionKey: entry.comboExecutionKey,
      status: entry.status,
    })),
    [
      {
        comboStepId: "step-openai-primary",
        comboExecutionKey: "step-openai-primary",
        status: 503,
      },
      {
        comboStepId: "step-openai-secondary",
        comboExecutionKey: "step-openai-secondary",
        status: 200,
      },
    ]
  );
});

test("model combo mappings route explicit model ids through the configured combo", async () => {
  await seedConnection("openai-compatible-mapped", { apiKey: "sk-openai-mapped" });
  const combo = await combosDb.createCombo({
    name: "mapped-router",
    strategy: "priority",
    models: ["openai-compatible-mapped/gpt-4o-mini"],
  });
  await modelComboMappingsDb.createModelComboMapping({
    pattern: "tenant/mapped-model",
    comboId: combo.id,
    priority: 100,
  });

  const fetchCalls = [];
  globalThis.fetch = async (url, init = {}) => {
    fetchCalls.push({
      url: String(url),
      headers: toPlainHeaders(init.headers),
    });
    return buildOpenAIResponse("Mapped combo route");
  };

  const response = await handleChat(
    buildRequest({
      body: buildOpenAIChatBody("tenant/mapped-model"),
    })
  );
  const json = (await response.json()) as any;

  assert.equal(response.status, 200);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].headers.authorization, "Bearer sk-openai-mapped");
  assert.equal(json.choices[0].message.content, "Mapped combo route");
});

test("wildcard model combo mappings resolve arbitrary matching models", async () => {
  await seedConnection("openai-compatible-wild", { apiKey: "sk-wild" });
  const combo = await combosDb.createCombo({
    name: "wild-router",
    strategy: "priority",
    models: ["openai-compatible-wild/gpt-4o-mini"],
  });
  await modelComboMappingsDb.createModelComboMapping({
    pattern: "tenant/*",
    comboId: combo.id,
    priority: 10,
  });

  const fetchCalls = [];
  globalThis.fetch = async (url, init = {}) => {
    fetchCalls.push({
      url: String(url),
      headers: toPlainHeaders(init.headers),
    });
    return buildOpenAIResponse("Wildcard combo route");
  };

  const response = await handleChat(
    buildRequest({
      body: buildOpenAIChatBody("tenant/any-model-name"),
    })
  );
  const json = (await response.json()) as any;

  assert.equal(response.status, 200);
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0].url, /\/chat\/completions$/);
  assert.equal(fetchCalls[0].headers.authorization, "Bearer sk-wild");
  assert.equal(json.choices[0].message.content, "Wildcard combo route");
});

test("unmapped custom model requests fail after combo resolution falls through", async () => {
  const response = await handleChat(
    buildRequest({
      body: buildOpenAIChatBody("tenant/unmapped-model"),
    })
  );
  const json = (await response.json()) as any;

  assert.equal(response.status, 400);
  assert.match(json.error.message, /No credentials for provider: tenant/);
});

test("strategy updates take effect for later requests on the same combo name", async () => {
  await seedConnection("openai-compatible-dyn-primary", { apiKey: "sk-dyn-primary" });
  await seedConnection("openai-compatible-dyn-secondary", { apiKey: "sk-dyn-secondary" });
  const combo = await combosDb.createCombo({
    name: "router-dynamic",
    strategy: "priority",
    models: [
      "openai-compatible-dyn-primary/gpt-4o-mini",
      "openai-compatible-dyn-secondary/gpt-4o-mini",
    ],
  });

  const seenProviders = [];
  globalThis.fetch = async (url, init = {}) => {
    const auth = toPlainHeaders(init.headers).authorization;
    if (auth === "Bearer sk-dyn-secondary") {
      seenProviders.push("secondary");
      return buildOpenAIResponse("Secondary after update");
    }
    seenProviders.push("primary");
    return buildOpenAIResponse("Primary before update");
  };

  const initial = await handleChat(
    buildRequest({
      body: buildOpenAIChatBody("router-dynamic", "Route dynamic initial"),
    })
  );
  await combosDb.updateCombo((combo as any).id, {
    strategy: "round-robin",
    config: { maxRetries: 0, retryDelayMs: 0 },
  });
  const second = await handleChat(
    buildRequest({
      body: buildOpenAIChatBody("router-dynamic", "Route dynamic second"),
    })
  );
  const third = await handleChat(
    buildRequest({
      body: buildOpenAIChatBody("router-dynamic", "Route dynamic third"),
    })
  );

  assert.equal(initial.status, 200);
  assert.equal(second.status, 200);
  assert.equal(third.status, 200);
  assert.deepEqual(seenProviders, ["primary", "primary", "secondary"]);
});

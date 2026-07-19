/**
 * Combo routing e2e — session-sticky round-robin (upstream #5248) and
 * advance-on-400 "model not supported" (upstream #5249).
 *
 * Drives the REAL handleComboChat so the round-robin dispatch, the
 * sessionManager stickiness wiring, and the #2101 anti-loop 400 branch are all
 * exercised end-to-end. Fixtures use only whitelist provider prefixes
 * (openai-compatible-*), matching the decloud fork's supported providers.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { handleComboChat, type SingleModelTarget } from "../../open-sse/services/combo.ts";
import { clearSessions } from "../../open-sse/services/sessionManager.ts";

const mockLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function rrCombo(name: string) {
  return {
    name,
    strategy: "round-robin",
    config: { maxRetries: 0 },
    models: [
      {
        kind: "model",
        provider: "openai-compatible",
        providerId: "openai-compatible",
        model: "m-a",
        connectionId: "conn-A",
        id: `${name}-0`,
      },
      {
        kind: "model",
        provider: "openai-compatible",
        providerId: "openai-compatible",
        model: "m-b",
        connectionId: "conn-B",
        id: `${name}-1`,
      },
      {
        kind: "model",
        provider: "openai-compatible",
        providerId: "openai-compatible",
        model: "m-c",
        connectionId: "conn-C",
        id: `${name}-2`,
      },
    ],
  };
}

function okResponse(modelStr: string): Response {
  return Response.json({ choices: [{ message: { role: "assistant", content: modelStr } }] });
}

async function dispatchConnection(
  combo: ReturnType<typeof rrCombo>,
  firstMessage: string,
  opts: {
    unavailableConnection?: string;
  } = {}
): Promise<string> {
  let conn = "?";
  await handleComboChat({
    body: {
      model: combo.name,
      messages: [{ role: "user", content: firstMessage }],
      stream: false,
    },
    combo,
    allCombos: [combo],
    isModelAvailable: async (_modelStr: string, target?: { connectionId?: string | null }) => {
      if (opts.unavailableConnection && target?.connectionId === opts.unavailableConnection) {
        return false;
      }
      return true;
    },
    relayOptions: undefined,
    signal: undefined,
    settings: {},
    log: mockLog,
    handleSingleModel: async (
      _body: unknown,
      modelStr: string,
      target?: SingleModelTarget
    ) => {
      conn = (target as { connectionId?: string | null })?.connectionId ?? "?";
      return okResponse(modelStr);
    },
  });
  return conn;
}

test.beforeEach(() => {
  clearSessions();
});

test("round-robin: a sessionless conversation re-pins to its turn-1 connection across turns (#5248)", async () => {
  const combo = rrCombo("rr-stick");
  const conns: string[] = [];
  for (let turn = 0; turn < 5; turn++) {
    conns.push(await dispatchConnection(combo, "Refactor the streaming handler for combos."));
  }
  assert.equal(
    new Set(conns.slice(1)).size,
    1,
    `turns 2..5 must stick to one connection, got: ${conns.join(", ")}`
  );
  assert.equal(conns[1], conns[0], "turn 2 must reuse turn 1's connection");
});

test("round-robin: sticky yields to fallback when the sticky target is unavailable (#5248 negative path)", async () => {
  const combo = rrCombo("rr-stick-fallover");
  // Turn 1 establishes a sticky binding to whichever connection the round-robin
  // rotation lands on.
  const stuckConn = await dispatchConnection(combo, "Explain the fallback ordering.");
  assert.ok(stuckConn !== "?", "turn 1 must resolve to a real connection");

  // Turn 2: the sticky connection is now unavailable (circuit-broken). Stickiness
  // MUST yield to fallback rather than pinning the request onto the dead target.
  const fallbackConn = await dispatchConnection(combo, "Explain the fallback ordering.", {
    unavailableConnection: stuckConn,
  });
  assert.ok(fallbackConn !== "?", "turn 2 must still resolve via a fallback connection");
  assert.notEqual(
    fallbackConn,
    stuckConn,
    "sticky must yield to fallback when the sticky target is unavailable"
  );
});

test("round-robin: distinct conversations still spread across connections on turn 1 (#5248 spreading guard)", async () => {
  const combo = rrCombo("rr-spread");
  const hist: Record<string, number> = {};
  for (let i = 0; i < 6; i++) {
    const conn = await dispatchConnection(combo, `conversation number ${i} — distinct first message`);
    hist[conn] = (hist[conn] || 0) + 1;
  }
  assert.ok(
    Object.keys(hist).length > 1,
    `distinct conversations must spread across connections, got: ${JSON.stringify(hist)}`
  );
});

test("priority combo advances to next model when first returns 400 'model not supported' (#5249)", async () => {
  const combo = {
    name: `model-not-supported-${Date.now()}`,
    strategy: "priority",
    config: { maxRetries: 0 },
    models: [
      {
        kind: "model",
        provider: "openai-compatible",
        providerId: "openai-compatible",
        model: "m-a",
        connectionId: "conn-A",
        id: "mns-0",
      },
      {
        kind: "model",
        provider: "openai-compatible",
        providerId: "openai-compatible",
        model: "m-b",
        connectionId: "conn-B",
        id: "mns-1",
      },
    ],
  };

  const calls: string[] = [];
  const response = await handleComboChat({
    body: {
      model: combo.name,
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    },
    combo,
    allCombos: [combo],
    isModelAvailable: async () => true,
    relayOptions: undefined,
    signal: undefined,
    settings: {},
    log: mockLog,
    handleSingleModel: async (_body: unknown, modelStr: string) => {
      calls.push(modelStr);
      if (calls.length === 1) {
        return Response.json(
          { error: { message: "requested model is not supported" } },
          { status: 400 }
        );
      }
      return okResponse(modelStr);
    },
  });

  assert.equal(response.status, 200, "combo should advance to second model and return 200");
  assert.equal(calls.length, 2, "combo should have tried both models");
});

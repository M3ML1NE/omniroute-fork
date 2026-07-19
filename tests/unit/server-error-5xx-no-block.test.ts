import test from "node:test";
import assert from "node:assert/strict";

const { checkFallbackError, isProviderFailureCode } = await import(
  "../../open-sse/services/accountFallback.ts"
);

test("5xx checkFallbackError returns cooldownMs:0 + shouldFallback:true (no persistent state)", () => {
  for (const status of [500, 502, 503, 504]) {
    const result = checkFallbackError(status, `Error ${status}`, 0, null, "openai-compatible-x");
    assert.equal(result.shouldFallback, true, `status ${status} should fall over`);
    assert.equal(result.cooldownMs, 0, `status ${status} must not persist a cooldown`);
    assert.equal(result.reason, "server_error", `status ${status} reason`);
  }
});

test("5xx with high backoffLevel still returns cooldownMs:0 (backoff never scales for 5xx)", () => {
  const result = checkFallbackError(503, "Service Unavailable", 5, null, "openai-compatible-x");
  assert.equal(result.cooldownMs, 0);
  assert.equal(result.shouldFallback, true);
});

test("5xx body carrying account-deactivation is still honored as permanent (order preserved)", () => {
  const result = checkFallbackError(
    500,
    "account_deactivated: your account has been suspended",
    0,
    null,
    "openai-compatible-x"
  );
  assert.equal(result.permanent, true);
  assert.ok(result.cooldownMs > 0, "deactivation inside a 5xx body keeps its long cooldown");
});

test("isProviderFailureCode excludes 5xx and 429; keeps 408", () => {
  assert.equal(isProviderFailureCode(500), false);
  assert.equal(isProviderFailureCode(502), false);
  assert.equal(isProviderFailureCode(503), false);
  assert.equal(isProviderFailureCode(504), false);
  assert.equal(isProviderFailureCode(429), false);
  assert.equal(isProviderFailureCode(408), true);
});

test("429 behavior unchanged: shouldFallback with a non-zero cooldown", () => {
  const result = checkFallbackError(429, "Rate limit exceeded", 0, null, "openai-compatible-x");
  assert.equal(result.shouldFallback, true);
  assert.equal(result.reason, "rate_limit_exceeded");
  assert.ok(result.cooldownMs > 0, "429 must still produce a temporary cooldown");
});

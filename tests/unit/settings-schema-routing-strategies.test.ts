import test from "node:test";
import assert from "node:assert/strict";
import { SETTINGS_FALLBACK_STRATEGY_VALUES } from "@/shared/constants/routingStrategies";
import { updateSettingsSchema as settingsRouteSchema } from "@/shared/validation/settingsSchemas";
import { updateSettingsSchema as sharedSettingsSchema } from "@/shared/validation/schemas";

for (const strategy of SETTINGS_FALLBACK_STRATEGY_VALUES) {
  test(`settings route schema accepts fallbackStrategy=${strategy}`, () => {
    const parsed = settingsRouteSchema.parse({ fallbackStrategy: strategy });
    assert.equal(parsed.fallbackStrategy, strategy);
  });

  test(`shared settings schema accepts fallbackStrategy=${strategy}`, () => {
    const parsed = sharedSettingsSchema.parse({ fallbackStrategy: strategy });
    assert.equal(parsed.fallbackStrategy, strategy);
  });
}

test("settings schemas reject removed strategies as account fallback strategies", () => {
  for (const strategy of [
    "auto",
    "lkgp",
    "context-optimized",
    "fill-first",
    "strict-random",
    "cost-optimized",
    "context-relay",
    "reset-aware",
    "reset-window",
    "random",
  ]) {
    assert.equal(settingsRouteSchema.safeParse({ fallbackStrategy: strategy }).success, false);
    assert.equal(sharedSettingsSchema.safeParse({ fallbackStrategy: strategy }).success, false);
  }
});

test("SETTINGS_FALLBACK_STRATEGY_VALUES is exactly the 5 supported strategies", () => {
  assert.deepEqual(
    [...SETTINGS_FALLBACK_STRATEGY_VALUES],
    ["priority", "weighted", "round-robin", "p2c", "least-used"]
  );
});

test("settings schemas accept cooldown-aware retry knobs", () => {
  const payload = {
    requestRetry: 3,
    maxRetryIntervalSec: 30,
  };

  const routeParsed = settingsRouteSchema.parse(payload);
  const sharedParsed = sharedSettingsSchema.parse(payload);

  assert.equal(routeParsed.requestRetry, 3);
  assert.equal(routeParsed.maxRetryIntervalSec, 30);
  assert.equal(sharedParsed.requestRetry, 3);
  assert.equal(sharedParsed.maxRetryIntervalSec, 30);
});

test("settings schemas accept request body limit", () => {
  const routeParsed = settingsRouteSchema.parse({ maxBodySizeMb: 100 });
  const sharedParsed = sharedSettingsSchema.parse({ maxBodySizeMb: 100 });

  assert.equal(routeParsed.maxBodySizeMb, 100);
  assert.equal(sharedParsed.maxBodySizeMb, 100);
  assert.equal(settingsRouteSchema.safeParse({ maxBodySizeMb: 0 }).success, false);
  assert.equal(settingsRouteSchema.safeParse({ maxBodySizeMb: 501 }).success, false);
  assert.equal(sharedSettingsSchema.safeParse({ maxBodySizeMb: 0 }).success, false);
  assert.equal(sharedSettingsSchema.safeParse({ maxBodySizeMb: 501 }).success, false);
});

test("settings schemas accept wsAuth toggle", () => {
  const routeParsed = settingsRouteSchema.parse({ wsAuth: true });
  const sharedParsed = sharedSettingsSchema.parse({ wsAuth: false });

  assert.equal(routeParsed.wsAuth, true);
  assert.equal(sharedParsed.wsAuth, false);
});

test("settings schemas accept combo configuration modes", () => {
  const routeParsed = settingsRouteSchema.parse({ comboConfigMode: "expert" });
  const sharedParsed = sharedSettingsSchema.parse({ comboConfigMode: "guided" });

  assert.equal(routeParsed.comboConfigMode, "expert");
  assert.equal(sharedParsed.comboConfigMode, "guided");
  assert.equal(settingsRouteSchema.safeParse({ comboConfigMode: "compact" }).success, false);
  assert.equal(sharedSettingsSchema.safeParse({ comboConfigMode: "compact" }).success, false);
});

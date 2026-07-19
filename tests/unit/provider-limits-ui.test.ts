import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const providerLimitUtils =
  await import("../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.tsx");
const settingsSchemas = await import("../../src/shared/validation/settingsSchemas.ts");

test("provider plan fallbacks normalize to Unknown instead of repeating provider labels", () => {
  const tier = providerLimitUtils.normalizePlanTier("Claude Code");

  assert.equal(tier.key, "unknown");
  assert.equal(tier.label, "Unknown");
});

test("tier token matching avoids substring false positives", () => {
  assert.equal(providerLimitUtils.normalizePlanTier("MiniMax").key, "unknown");
  assert.equal(providerLimitUtils.normalizePlanTier("APPROVE").key, "unknown");
  assert.equal(providerLimitUtils.normalizePlanTier("Max").key, "ultra");
  assert.equal(providerLimitUtils.normalizePlanTier("Pro").key, "pro");
});

test("paid individual tiers use non-gray badge variants", () => {
  assert.equal(providerLimitUtils.normalizePlanTier("Plus").variant, "success");
  assert.equal(providerLimitUtils.normalizePlanTier("Pro").variant, "success");
  assert.equal(providerLimitUtils.normalizePlanTier("Student").variant, "success");
  assert.equal(providerLimitUtils.normalizePlanTier("Lite").key, "lite");
  assert.equal(providerLimitUtils.normalizePlanTier("Lite").label, "Lite");
  assert.notEqual(providerLimitUtils.normalizePlanTier("Lite").variant, "default");
  assert.equal(providerLimitUtils.normalizePlanTier("Free").variant, "default");
});

test("providerSpecificData plan is used when live plan is missing", () => {
  const resolvedPlan = providerLimitUtils.resolvePlanValue(null, {
    plan: "Pro",
  });

  assert.equal(resolvedPlan, "Pro");
  const tier = providerLimitUtils.normalizePlanTier(resolvedPlan);
  assert.equal(tier.key, "pro");
  assert.equal(tier.variant, "success");
});

test("generic rate limit tiers map to max badges", () => {
  const resolvedPlan = providerLimitUtils.resolvePlanValue(null, {
    organizationRateLimitTier: "default_max_20x",
  });

  assert.equal(resolvedPlan, "default_max_20x");
  const tier = providerLimitUtils.normalizePlanTier(resolvedPlan);
  assert.equal(tier.key, "ultra");
  assert.equal(tier.label, "Max");
});

test("organization type is used as a generic plan fallback", () => {
  const resolvedPlan = providerLimitUtils.resolvePlanValue(null, {
    organizationType: "enterprise",
  });

  assert.equal(resolvedPlan, "enterprise");
  const tier = providerLimitUtils.normalizePlanTier(resolvedPlan);
  assert.equal(tier.label, "Enterprise");
});

test("generic coding plan titles map to tier badges", () => {
  const proTier = providerLimitUtils.normalizePlanTier("Coding Plan Pro");
  assert.equal(proTier.key, "pro");
  assert.equal(proTier.label, "Pro");

  const starterTier = providerLimitUtils.normalizePlanTier("Starter");
  assert.equal(starterTier.key, "lite");
  assert.equal(starterTier.label, "Starter");

  const genericOnly = providerLimitUtils.normalizePlanTier("Coding Plan");
  assert.notEqual(genericOnly.key, "ultra");
});

test("tier token matching ignores embedded substrings", () => {
  assert.equal(providerLimitUtils.normalizePlanTier("APPROVE").key, "unknown");
  assert.equal(providerLimitUtils.normalizePlanTier("LITERAL").key, "unknown");
});

test("remaining percentage helpers reflect remaining quota and stale resets refill to 100", () => {
  assert.equal(providerLimitUtils.calculatePercentage(0, 100), 100);
  assert.equal(providerLimitUtils.calculatePercentage(17, 100), 83);
  assert.equal(providerLimitUtils.calculatePercentage(60, 100), 40);

  const past = new Date(Date.now() - 60_000).toISOString();
  const parsed = providerLimitUtils.parseQuotaData("codex", {
    quotas: {
      session: { used: 83, total: 100, resetAt: past },
    },
  });

  assert.equal(parsed.length, 1);
  assert.equal(providerLimitUtils.calculatePercentage(parsed[0].used, parsed[0].total), 100);
});

test("quota labels normalize session and weekly windows while preserving readable titles", () => {
  assert.equal(providerLimitUtils.formatQuotaLabel("session"), "Session");
  assert.equal(providerLimitUtils.formatQuotaLabel("session (5h)"), "Session");
  assert.equal(providerLimitUtils.formatQuotaLabel("weekly"), "Weekly");
  assert.equal(providerLimitUtils.formatQuotaLabel("weekly (7d)"), "Weekly");
  assert.equal(providerLimitUtils.formatQuotaLabel("weekly sonnet (7d)"), "Weekly Sonnet");
  assert.equal(providerLimitUtils.formatQuotaLabel("code_review"), "Code Review");
  assert.equal(providerLimitUtils.formatQuotaLabel("mcp_monthly"), "Monthly");
});

test("generic quota payloads use provider-agnostic parsing and stale resets still refill", () => {
  const future = new Date(Date.now() + 5 * 60_000).toISOString();
  const past = new Date(Date.now() - 5 * 60_000).toISOString();

  const parsed = providerLimitUtils.parseQuotaData("openai-compatible-demo", {
    quotas: {
      "session (5h)": {
        used: 400,
        total: 1500,
        remaining: 1100,
        remainingPercentage: 73.3,
        resetAt: future,
      },
      "weekly (7d)": {
        used: 1200,
        total: 15000,
        remaining: 13800,
        remainingPercentage: 92,
        resetAt: past,
      },
    },
  });

  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].name, "session (5h)");
  assert.equal(parsed[0].used, 400);
  assert.equal(parsed[0].total, 1500);
  assert.equal(parsed[1].name, "weekly (7d)");
  assert.equal(parsed[1].used, 0);
  assert.equal(parsed[1].remainingPercentage, 100);
  assert.equal(providerLimitUtils.formatQuotaLabel(parsed[0].name), "Session");
  assert.equal(providerLimitUtils.formatQuotaLabel(parsed[1].name), "Weekly");
});

test("generic quota rows preserve payload order", () => {
  const parsed = providerLimitUtils.parseQuotaData("openai-compatible-demo", {
    quotas: {
      mcp_monthly: { used: 10, total: 100, remainingPercentage: 90 },
      weekly: { used: 20, total: 100, remainingPercentage: 80 },
      session: { used: 30, total: 100, remainingPercentage: 70 },
    },
  });

  assert.deepEqual(
    parsed.map((quota) => quota.name),
    ["mcp_monthly", "weekly", "session"]
  );
});

test("dashboard i18n keys used by OrFallback helpers exist in ru.json", () => {
  const ruPath = path.resolve("src/i18n/messages/ru.json");
  const messages = JSON.parse(readFileSync(ruPath, "utf8"));

  const required: Array<[string, string]> = [
    ["combos", "emailVisibilityHint"],
    ["combos", "configOnlyStatus"],
    ["cache", "loadingCacheAria"],
    ["costs", "legacyFreeLabel"],
    ["contextCaveman", "inputCompressionTitle"],
    ["contextCaveman", "inputCompressionDesc"],
    ["providers", "tierFast"],
  ];

  for (const [ns, key] of required) {
    const value = messages[ns]?.[key];
    assert.equal(typeof value, "string", `${ns}.${key} should be defined in ru.json`);
    assert.ok(!value.startsWith("__MISSING__:"), `${ns}.${key} should not be a placeholder`);
  }
});

test("usage namespace includes Provider Limits UI translation keys", () => {
  const ruPath = path.resolve("src/i18n/messages/ru.json");
  const messages = JSON.parse(readFileSync(ruPath, "utf8"));
  const usage = messages.usage;

  for (const key of [
    "statTotal",
    "statCritical",
    "statAlert",
    "statHealthy",
    "filterPurchaseTypeLabel",
    "filterTierLabel",
    "purchaseAll",
    "purchaseOauthSub",
    "purchaseOauthFree",
    "purchaseApiKey",
    "tierLite",
    "resetsIn",
    "editCutoffs",
    "forceRefresh",
  ]) {
    assert.equal(typeof usage[key], "string", `usage.${key} should be defined in ru.json`);
    assert.ok(!usage[key].startsWith("__MISSING__:"), `usage.${key} should not be a placeholder`);
  }
});

test("provider quota auto-refresh settings are accepted by the settings schema", () => {
  const result = settingsSchemas.updateSettingsSchema.safeParse({
    autoRefreshProviderQuota: true,
    autoRefreshProviderQuotaInterval: 180,
  });

  assert.equal(result.success, true);
});

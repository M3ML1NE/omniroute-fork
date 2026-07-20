import test from "node:test";
import assert from "node:assert/strict";

// Regression coverage for the missing-`await` bug chain rooted in
// src/shared/utils/featureFlags.ts. The DB layer migrated to an async Postgres
// adapter, so getFeatureFlagOverride() returns a Promise. resolveFeatureFlag /
// resolveAllFeatureFlags / arePrivateProviderUrlsAllowed must await it and
// return the actual string value (not a Promise/object).

process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://omniroute:omniroute@localhost:5432/omniroute_test";
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "feature-flags-async-secret";

const PRIVATE_URLS_FLAG = "OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS";

const featureFlagsDb = await import("../../src/lib/db/featureFlags.ts");
const featureFlags = await import("../../src/shared/utils/featureFlags.ts");
const outboundUrlGuard = await import("../../src/shared/network/outboundUrlGuard.ts");

async function clearOverrides() {
  await featureFlagsDb.clearAllFeatureFlagOverrides();
}

test.beforeEach(async () => {
  await clearOverrides();
});

test.after(async () => {
  await clearOverrides();
  const core = await import("../../src/lib/db/core.ts");
  await core.closePool();
});

test("resolveFeatureFlag returns the actual DB override string, not a Promise", async () => {
  await featureFlagsDb.setFeatureFlagOverride(PRIVATE_URLS_FLAG, "true");

  const value = await featureFlags.resolveFeatureFlag(PRIVATE_URLS_FLAG);

  assert.equal(typeof value, "string");
  assert.equal(value, "true");
});

test("resolveAllFeatureFlags reports the DB override value and source", async () => {
  await featureFlagsDb.setFeatureFlagOverride(PRIVATE_URLS_FLAG, "true");

  const resolved = await featureFlags.resolveAllFeatureFlags();
  const flag = resolved.find((f) => f.key === PRIVATE_URLS_FLAG);

  assert.ok(flag, "expected the flag to be present in resolveAllFeatureFlags()");
  assert.equal(typeof flag.effectiveValue, "string");
  assert.equal(flag.effectiveValue, "true");
  assert.equal(flag.source, "db");
});

test("arePrivateProviderUrlsAllowed returns true when the DB override is set to true", async () => {
  const originalEnv = process.env[PRIVATE_URLS_FLAG];
  delete process.env[PRIVATE_URLS_FLAG];
  try {
    await featureFlagsDb.setFeatureFlagOverride(PRIVATE_URLS_FLAG, "true");

    const allowed = await outboundUrlGuard.arePrivateProviderUrlsAllowed();
    assert.equal(allowed, true);

    const guard = await outboundUrlGuard.getProviderOutboundGuard();
    assert.equal(guard, "none");
  } finally {
    if (originalEnv === undefined) {
      delete process.env[PRIVATE_URLS_FLAG];
    } else {
      process.env[PRIVATE_URLS_FLAG] = originalEnv;
    }
  }
});

test("arePrivateProviderUrlsAllowed defaults to false with no override or env opt-in", async () => {
  const originalEnv = process.env[PRIVATE_URLS_FLAG];
  const originalLegacy = process.env["OUTBOUND_SSRF_GUARD_ENABLED"];
  delete process.env[PRIVATE_URLS_FLAG];
  delete process.env["OUTBOUND_SSRF_GUARD_ENABLED"];
  try {
    const allowed = await outboundUrlGuard.arePrivateProviderUrlsAllowed();
    assert.equal(allowed, false);

    const guard = await outboundUrlGuard.getProviderOutboundGuard();
    assert.equal(guard, "public-only");
  } finally {
    if (originalEnv === undefined) delete process.env[PRIVATE_URLS_FLAG];
    else process.env[PRIVATE_URLS_FLAG] = originalEnv;
    if (originalLegacy === undefined) delete process.env["OUTBOUND_SSRF_GUARD_ENABLED"];
    else process.env["OUTBOUND_SSRF_GUARD_ENABLED"] = originalLegacy;
  }
});

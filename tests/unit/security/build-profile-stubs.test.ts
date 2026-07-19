/**
 * Regression: when OMNIROUTE_BUILD_PROFILE=minimal is the resolved build
 * profile, stub modules throw FeatureDisabledError instead of performing
 * their privileged operations.
 * See docs/security/SOCKET_DEV_FINDINGS.md.
 *
 * The mitm-cert, zed-oauth keychain-reader, and ninerouter installer stub
 * modules this test previously covered do not exist in this fork (their
 * owning subsystems — MITM proxy, Zed OAuth import, 9router — were removed
 * entirely). Only the shared featureDisabledError() helper remains live.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

test("featureDisabledError carries the featureName", async () => {
  const mod = await import("../../../src/lib/build-profile/featureDisabled.ts");
  const err = mod.featureDisabledError("my-feature");
  assert.equal(err.featureName, "my-feature");
  assert.match(err.message, /my-feature/);
  assert.match(err.message, /minimal/);
});

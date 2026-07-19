// Ported from OmniRoute upstream v3.8.48, adapted for GigaChat fork.
//
// Upstream used SQLite (INSERT OR REPLACE + DATA_DIR); the fork persists to Postgres, so the
// pre-panel install is simulated via the async pg key_value writes and the round-trip asserts
// against getCompressionSettings/updateCompressionSettings. Verifies the engines-map backfill
// (display-only, enginesExplicit=false) and the stored-row round-trip (enginesExplicit=true).

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const core = await import("../../../src/lib/db/core.ts");
const { getCompressionSettings, updateCompressionSettings } =
  await import("../../../src/lib/db/compression.ts");

async function clearCompression() {
  const db = core.getDbInstance();
  await db.prepare("DELETE FROM key_value WHERE namespace = ?").run("compression");
}

describe("compression engines map", () => {
  beforeEach(async () => {
    core.resetDbInstance();
    await clearCompression();
  });

  afterEach(() => core.resetDbInstance());

  it("backfills the engines map from legacy defaultMode + cavemanConfig (display-only)", async () => {
    const db = core.getDbInstance();
    await db
      .prepare("INSERT INTO key_value (namespace, key, value) VALUES (?, ?, ?)")
      .run("compression", "enabled", "true");
    await db
      .prepare("INSERT INTO key_value (namespace, key, value) VALUES (?, ?, ?)")
      .run("compression", "defaultMode", '"standard"');
    await db
      .prepare("INSERT INTO key_value (namespace, key, value) VALUES (?, ?, ?)")
      .run("compression", "cavemanConfig", '{"enabled":true}');

    const cfg = await getCompressionSettings();
    assert.equal(cfg.engines?.caveman.enabled, true);
    assert.equal(cfg.activeComboId, null);
    // No stored engines row → backfilled map is display-only; dispatch stays on the legacy path.
    assert.equal(cfg.enginesExplicit, false);
  });

  it("persists an engines map round-trip and marks it explicit", async () => {
    await updateCompressionSettings({
      enabled: true,
      engines: {
        rtk: { enabled: true, level: "standard" },
        caveman: { enabled: true, level: "full" },
      },
      activeComboId: null,
    });

    const cfg = await getCompressionSettings();
    assert.equal(cfg.engines?.rtk.enabled, true);
    assert.equal(cfg.engines?.rtk.level, "standard");
    assert.equal(cfg.engines?.caveman.level, "full");
    // A stored engines row exists → the panel configured engines; dispatch trusts the map.
    assert.equal(cfg.enginesExplicit, true);
  });

  it("sanitizes a malformed engines write (drops unknown ids and bad toggles)", async () => {
    // The write path validates against ENGINE_IDS; a mixed map exercises the sanitizer.
    const malformedEngines: Record<string, unknown> = {
      rtk: { enabled: true },
      llmlingua: { enabled: true },
      bogus: { enabled: true },
      caveman: { notAToggle: 1 },
    };
    await updateCompressionSettings({
      engines: malformedEngines as Record<string, { enabled: boolean; level?: string }>,
    });

    const cfg = await getCompressionSettings();
    assert.equal(cfg.engines?.rtk.enabled, true);
    // Unknown/unported ids never enter the stored row; a fresh read backfills them to false.
    assert.equal(cfg.engines?.caveman.enabled, false);
    assert.equal((cfg.engines as Record<string, unknown>).llmlingua, undefined);
    assert.equal((cfg.engines as Record<string, unknown>).bogus, undefined);
  });

  it("never persists the runtime-only enginesExplicit marker", async () => {
    await updateCompressionSettings({ enginesExplicit: true } as Partial<
      Awaited<ReturnType<typeof getCompressionSettings>>
    >);
    const db = core.getDbInstance();
    const row = (await db
      .prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
      .get("compression", "enginesExplicit")) as { value: string } | undefined;
    assert.equal(row, undefined);
  });
});

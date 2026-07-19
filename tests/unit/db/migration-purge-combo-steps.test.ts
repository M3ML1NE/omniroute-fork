import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-combo-steps-purge-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../../src/lib/db/core.ts");
const pgModule = await import("../../../src/lib/db/postgres.ts");

const RUN_PREFIX = `combo-steps-purge-${process.pid}`;

const MIGRATION_SQL = fs.readFileSync(
  path.join(process.cwd(), "db/migrations/postgres/0015_purge_combo_provider_steps.sql"),
  "utf8"
);

function serialTest(name: string, fn: () => Promise<void>) {
  test(name, { concurrency: false }, fn);
}

interface ComboStepLike {
  id: string;
  kind: "model" | "combo-ref";
  model?: string;
  providerId?: string;
  comboName?: string;
  weight?: number;
}

async function seedCombo(idSuffix: string, name: string, models: ComboStepLike[]) {
  const schema = pgModule.getSchema();
  const now = new Date().toISOString();
  const id = `${RUN_PREFIX}-${idSuffix}`;
  const data = JSON.stringify({
    name,
    strategy: "priority",
    models,
    id,
    config: {},
    isHidden: false,
    sortOrder: 1,
    createdAt: now,
    updatedAt: now,
    version: 2,
  });
  await pgModule.query(
    `INSERT INTO ${schema}.combos (id, name, data, sort_order, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO NOTHING`,
    [id, name, data, 1, now, now]
  );
  return id;
}

async function getComboModels(id: string): Promise<ComboStepLike[] | null> {
  const schema = pgModule.getSchema();
  const result = await pgModule.query(
    `SELECT data::jsonb->'models' AS models FROM ${schema}.combos WHERE id = $1`,
    [id]
  );
  if (result.rows.length === 0) return null;
  return result.rows[0].models as ComboStepLike[];
}

async function comboExists(id: string): Promise<boolean> {
  const schema = pgModule.getSchema();
  const result = await pgModule.query(
    `SELECT COUNT(*)::int AS cnt FROM ${schema}.combos WHERE id = $1`,
    [id]
  );
  return result.rows[0].cnt > 0;
}

async function runMigration() {
  const schema = pgModule.getSchema();
  // The migration SQL references the bare `combos` table; qualify it with the
  // active test schema, exactly like the mlproxy/gigachat migration tests.
  const qualifiedSql = MIGRATION_SQL.replace(/\bcombos\b/g, `${schema}.combos`);
  await pgModule.query(qualifiedSql);
}

async function cleanup() {
  const schema = pgModule.getSchema();
  await pgModule.query(`DELETE FROM ${schema}.combos WHERE id LIKE $1`, [`${RUN_PREFIX}-%`]);
  core.resetDbInstance();
}

test.beforeEach(async () => {
  await cleanup();
});

test.after(async () => {
  await cleanup();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

serialTest(
  "(a) mixed combo: only non-compatible model steps removed; compatible + combo-ref survive",
  async () => {
    const id = await seedCombo("mixed", `${RUN_PREFIX}-mixed`, [
      { id: "s-openai", kind: "model", model: "m1", providerId: "openai-compatible-x", weight: 0 },
      { id: "s-deepseek", kind: "model", model: "m2", providerId: "deepseek", weight: 0 },
      { id: "s-giga", kind: "model", model: "m3", providerId: "gigachat-compatible-y", weight: 0 },
      { id: "s-ref", kind: "combo-ref", comboName: "other-combo", weight: 0 },
    ]);

    await runMigration();

    assert.equal(await comboExists(id), true, "mixed combo must survive");
    const models = await getComboModels(id);
    assert.ok(models, "models array must be present");
    const ids = models!.map((m) => m.id).sort();
    assert.deepEqual(
      ids,
      ["s-giga", "s-openai", "s-ref"],
      "only the non-compatible model step (deepseek) is dropped; compatible model steps and the combo-ref survive"
    );
    // combo-ref element is untouched (still has its comboName).
    const ref = models!.find((m) => m.id === "s-ref");
    assert.equal(ref?.kind, "combo-ref");
    assert.equal(ref?.comboName, "other-combo", "combo-ref content is preserved verbatim");
  }
);

serialTest(
  "(b) combo with ONLY non-compatible model steps: entire combo row deleted",
  async () => {
    const id = await seedCombo("allbad", `${RUN_PREFIX}-allbad`, [
      { id: "b1", kind: "model", model: "m1", providerId: "openai", weight: 0 },
      { id: "b2", kind: "model", model: "m2", providerId: "xai", weight: 0 },
    ]);

    await runMigration();

    assert.equal(
      await comboExists(id),
      false,
      "combo with zero remaining steps after filtering must be deleted"
    );
  }
);

serialTest(
  "(c) one non-compatible model step + one combo-ref: combo survives with only the combo-ref",
  async () => {
    const id = await seedCombo("oneref", `${RUN_PREFIX}-oneref`, [
      { id: "c-model", kind: "model", model: "m1", providerId: "groq", weight: 0 },
      { id: "c-ref", kind: "combo-ref", comboName: "downstream-combo", weight: 0 },
    ]);

    await runMigration();

    assert.equal(await comboExists(id), true, "combo with a surviving combo-ref must NOT be deleted");
    const models = await getComboModels(id);
    assert.ok(models, "models array must be present");
    assert.equal(models!.length, 1, "only the combo-ref step remains");
    assert.equal(models![0].id, "c-ref");
    assert.equal(models![0].kind, "combo-ref");
    assert.equal(models![0].comboName, "downstream-combo");
  }
);

serialTest("migration is idempotent — second run makes no further changes", async () => {
  const mixedId = await seedCombo("idem-mixed", `${RUN_PREFIX}-idem-mixed`, [
    { id: "i-openai", kind: "model", model: "m1", providerId: "openai-compatible-x", weight: 0 },
    { id: "i-bad", kind: "model", model: "m2", providerId: "deepseek", weight: 0 },
    { id: "i-ref", kind: "combo-ref", comboName: "other", weight: 0 },
  ]);
  const allBadId = await seedCombo("idem-allbad", `${RUN_PREFIX}-idem-allbad`, [
    { id: "j-bad", kind: "model", model: "m1", providerId: "openai", weight: 0 },
  ]);

  await runMigration();
  const afterFirst = await getComboModels(mixedId);
  assert.equal(await comboExists(allBadId), false, "all-bad combo deleted on first run");

  await runMigration();
  const afterSecond = await getComboModels(mixedId);
  assert.deepEqual(afterSecond, afterFirst, "second run leaves the surviving combo unchanged");
  assert.equal(await comboExists(allBadId), false, "all-bad combo stays deleted after second run");
});

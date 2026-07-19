import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-evals-history-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const pgModule = await import("../../src/lib/db/postgres.ts");
const evalsDb = await import("../../src/lib/db/evals.ts");

const RUN_PREFIX = `evals-history-${process.pid}`;
const HISTORY_SUITE_ID = `${RUN_PREFIX}-golden-set`;
const ROUTING_SUITE_ID = `${RUN_PREFIX}-routing-quality`;
const OTHER_SUITE_ID = `${RUN_PREFIX}-other-suite`;

async function resetDb() {
  const schema = pgModule.getSchema();
  await pgModule.query(`DELETE FROM ${schema}.eval_runs WHERE suite_id LIKE $1`, [`${RUN_PREFIX}-%`]);
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(async () => {
  await resetDb();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("eval run history persists target metadata and newest-first ordering", async () => {
  const older = await evalsDb.saveEvalRun({
    suiteId: HISTORY_SUITE_ID,
    suiteName: "Golden Set",
    target: { type: "model", id: "gpt-4o", label: "Model: gpt-4o" },
    summary: { total: 2, passed: 2, failed: 0, passRate: 100 },
    avgLatencyMs: 120,
    results: [{ caseId: "c1", caseName: "Case 1", passed: true, durationMs: 120 }],
    outputs: { c1: "ok" },
    createdAt: "2026-04-23T10:00:00.000Z",
  });

  const newer = await evalsDb.saveEvalRun({
    suiteId: HISTORY_SUITE_ID,
    suiteName: "Golden Set",
    target: { type: "combo", id: "cost-optimized", label: "Combo: cost-optimized" },
    summary: { total: 2, passed: 1, failed: 1, passRate: 50 },
    avgLatencyMs: 240,
    results: [{ caseId: "c1", caseName: "Case 1", passed: false, durationMs: 240 }],
    outputs: { c1: "[ERROR] upstream failed" },
    createdAt: "2026-04-23T11:00:00.000Z",
  });

  const runs = await evalsDb.listEvalRuns({ suiteId: HISTORY_SUITE_ID, limit: 10 });

  assert.equal(runs.length, 2);
  assert.equal(runs[0].id, newer.id);
  assert.equal(runs[1].id, older.id);
  assert.equal(runs[0].target.key, "combo:cost-optimized");
  assert.equal(runs[1].target.key, "model:gpt-4o");
  assert.equal(runs[0].summary.passRate, 50);
  assert.equal(runs[1].outputs.c1, "ok");
});

test("scorecard keeps only the latest run per suite and target scope", async () => {
  await evalsDb.saveEvalRun({
    suiteId: HISTORY_SUITE_ID,
    suiteName: "Golden Set",
    target: { type: "model", id: "gpt-4o", label: "Model: gpt-4o" },
    summary: { total: 2, passed: 1, failed: 1, passRate: 50 },
    avgLatencyMs: 150,
    results: [],
    createdAt: "2026-04-23T09:00:00.000Z",
  });

  await evalsDb.saveEvalRun({
    suiteId: HISTORY_SUITE_ID,
    suiteName: "Golden Set",
    target: { type: "model", id: "gpt-4o", label: "Model: gpt-4o" },
    summary: { total: 2, passed: 2, failed: 0, passRate: 100 },
    avgLatencyMs: 100,
    results: [],
    createdAt: "2026-04-23T10:00:00.000Z",
  });

  await evalsDb.saveEvalRun({
    suiteId: HISTORY_SUITE_ID,
    suiteName: "Golden Set",
    target: { type: "combo", id: "balanced", label: "Combo: balanced" },
    summary: { total: 2, passed: 1, failed: 1, passRate: 50 },
    avgLatencyMs: 220,
    results: [],
    createdAt: "2026-04-23T10:30:00.000Z",
  });

  const scorecard = await evalsDb.getEvalScorecard({ suiteId: HISTORY_SUITE_ID, limit: 10 });

  assert.ok(scorecard);
  assert.equal(scorecard.suites, 2);
  assert.equal(scorecard.totalCases, 4);
  assert.equal(scorecard.totalPassed, 3);
  assert.equal(scorecard.overallPassRate, 75);
});

test("routing eval run query returns recent model runs for requested targets", async () => {
  await evalsDb.saveEvalRun({
    suiteId: ROUTING_SUITE_ID,
    suiteName: "Routing Quality",
    target: { type: "model", id: "openai/good", label: "Model: openai/good" },
    summary: { total: 4, passed: 4, failed: 0, passRate: 100 },
    avgLatencyMs: 100,
    results: [],
    createdAt: "2026-04-23T10:00:00.000Z",
  });
  await evalsDb.saveEvalRun({
    suiteId: ROUTING_SUITE_ID,
    suiteName: "Routing Quality",
    target: { type: "combo", id: "openai/good", label: "Combo: openai/good" },
    summary: { total: 4, passed: 1, failed: 3, passRate: 25 },
    avgLatencyMs: 500,
    results: [],
    createdAt: "2026-04-23T10:30:00.000Z",
  });
  await evalsDb.saveEvalRun({
    suiteId: OTHER_SUITE_ID,
    suiteName: "Other Suite",
    target: { type: "model", id: "openai/good", label: "Model: openai/good" },
    summary: { total: 4, passed: 2, failed: 2, passRate: 50 },
    avgLatencyMs: 200,
    results: [],
    createdAt: "2026-04-23T11:00:00.000Z",
  });

  const runs = await evalsDb.listModelEvalRunsForRouting({
    targetIds: ["openai/good", "openai/missing"],
    suiteIds: [ROUTING_SUITE_ID],
    maxAgeHours: 24 * 365 * 10,
    limit: 10,
  });

  assert.equal(runs.length, 1);
  assert.equal(runs[0].target.type, "model");
  assert.equal(runs[0].target.id, "openai/good");
  assert.equal(runs[0].suiteId, ROUTING_SUITE_ID);
});

test("custom eval suites persist cases and support update/delete", async () => {
  const created = await evalsDb.saveCustomEvalSuite({
    name: "Support Regression",
    description: "Checks refund phrasing",
    cases: [
      {
        name: "Refund policy",
        model: "gpt-4o-mini",
        input: {
          messages: [{ role: "user", content: "Explain the refund policy" }],
        },
        expected: {
          strategy: "contains",
          value: "refund",
        },
        tags: ["support", "billing"],
      },
    ],
  });

  assert.ok(created.id);
  assert.equal(created.source, "custom");
  assert.equal(created.caseCount, 1);
  assert.equal(created.cases[0]?.expected.strategy, "contains");
  assert.deepEqual(created.cases[0]?.tags, ["support", "billing"]);

  const updated = await evalsDb.saveCustomEvalSuite({
    id: created.id,
    name: "Support Regression v2",
    description: "Checks refund and escalation phrasing",
    cases: [
      {
        id: created.cases[0]?.id,
        name: "Refund policy",
        model: "gpt-4o-mini",
        input: {
          messages: [{ role: "user", content: "Explain the refund policy" }],
        },
        expected: {
          strategy: "contains",
          value: "refund",
        },
        tags: ["support"],
      },
      {
        name: "Escalation path",
        model: "gpt-4o-mini",
        input: {
          messages: [{ role: "user", content: "How do I escalate a billing issue?" }],
        },
        expected: {
          strategy: "regex",
          value: "support|billing",
        },
        tags: ["billing"],
      },
    ],
  });

  assert.equal(updated.id, created.id);
  assert.equal(updated.name, "Support Regression v2");
  assert.equal(updated.caseCount, 2);
  assert.equal(updated.cases[1]?.expected.strategy, "regex");

  const listed = await evalsDb.listCustomEvalSuites();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, created.id);
  assert.equal((await evalsDb.getCustomEvalSuite(created.id))?.cases.length, 2);

  assert.equal(await evalsDb.deleteCustomEvalSuite(created.id), true);
  assert.equal(await evalsDb.getCustomEvalSuite(created.id), null);
});

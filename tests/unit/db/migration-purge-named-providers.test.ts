import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-purge-named-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../../src/lib/db/core.ts");
const pgModule = await import("../../../src/lib/db/postgres.ts");

const RUN_PREFIX = `purge-named-${process.pid}`;

const MIGRATION_SQL = fs.readFileSync(
  path.join(process.cwd(), "db/migrations/postgres/0014_purge_named_provider_data.sql"),
  "utf8"
);

function serialTest(name: string, fn: () => Promise<void>) {
  test(name, { concurrency: false }, fn);
}

/**
 * Run the migration exactly as the runner does — raw, unrewritten SQL. The
 * pool's session applies `SET search_path TO <schema>, public`, so the file's
 * unqualified table names resolve to the OmniRoute schema. String literals in
 * the file (json_build_object keys, the audit target/resource_type values) must
 * therefore NOT be schema-rewritten, so no naive regex qualification is used.
 */
async function runMigration() {
  await pgModule.query(MIGRATION_SQL);
}

async function scalar(sql: string, params: unknown[] = []): Promise<number> {
  const schema = pgModule.getSchema();
  const result = await pgModule.query<{ cnt: number }>(sql.replace(/__S__/g, schema), params);
  return result.rows[0].cnt;
}

// -------------------------------------------------------------------------
// Seed helpers — one per affected table. Every seeded row id is prefixed with
// RUN_PREFIX so the fixture is fully isolated from any real / concurrent data.
// -------------------------------------------------------------------------

async function seedProviderConnections() {
  const schema = pgModule.getSchema();
  const now = new Date().toISOString();
  const rows = [
    { id: `${RUN_PREFIX}-pc-openai`, provider: "openai-compatible-abc" },
    { id: `${RUN_PREFIX}-pc-giga`, provider: "gigachat-compatible-xyz" },
    { id: `${RUN_PREFIX}-pc-named`, provider: "openai" },
    { id: `${RUN_PREFIX}-pc-claude`, provider: "claude" },
    // Bare compatible prefixes without a suffix must NOT survive (regex needs .+).
    { id: `${RUN_PREFIX}-pc-bare`, provider: "openai-compatible" },
  ];
  for (const r of rows) {
    await pgModule.query(
      `INSERT INTO ${schema}.provider_connections (id, provider, created_at, updated_at)
       VALUES ($1, $2, $3, $3) ON CONFLICT (id) DO NOTHING`,
      [r.id, r.provider, now]
    );
  }
}

async function seedProviderNodes() {
  const schema = pgModule.getSchema();
  const now = new Date().toISOString();
  const rows = [
    { id: `${RUN_PREFIX}-pn-openai`, type: "openai-compatible" },
    { id: `${RUN_PREFIX}-pn-giga`, type: "gigachat-compatible" },
    { id: `${RUN_PREFIX}-pn-named`, type: "anthropic" },
  ];
  for (const r of rows) {
    await pgModule.query(
      `INSERT INTO ${schema}.provider_nodes (id, type, name, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4) ON CONFLICT (id) DO NOTHING`,
      [r.id, r.type, r.id, now]
    );
  }
}

async function seedUsageHistory() {
  const schema = pgModule.getSchema();
  const now = new Date().toISOString();
  const rows = [
    { provider: "openai-compatible-abc" },
    { provider: "gigachat-compatible-xyz" },
    { provider: "openai" },
    { provider: null }, // aggregate row — provider IS NULL must survive.
  ];
  for (const r of rows) {
    await pgModule.query(
      `INSERT INTO ${schema}.usage_history (provider, model, timestamp)
       VALUES ($1, $2, $3)`,
      [r.provider, `${RUN_PREFIX}-model`, `${RUN_PREFIX}::${now}`]
    );
  }
}

async function seedCallLogs() {
  const schema = pgModule.getSchema();
  const now = new Date().toISOString();
  const rows = [
    { id: `${RUN_PREFIX}-cl-openai`, provider: "openai-compatible-abc" },
    { id: `${RUN_PREFIX}-cl-giga`, provider: "gigachat-compatible-xyz" },
    { id: `${RUN_PREFIX}-cl-named`, provider: "groq" },
    { id: `${RUN_PREFIX}-cl-null`, provider: null },
  ];
  for (const r of rows) {
    await pgModule.query(
      `INSERT INTO ${schema}.call_logs (id, timestamp, provider)
       VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [r.id, now, r.provider]
    );
  }
}

async function seedRequestDetailLogs() {
  const schema = pgModule.getSchema();
  const now = new Date().toISOString();
  const rows = [
    { id: `${RUN_PREFIX}-rdl-openai`, provider: "openai-compatible-abc" },
    { id: `${RUN_PREFIX}-rdl-giga`, provider: "gigachat-compatible-xyz" },
    { id: `${RUN_PREFIX}-rdl-named`, provider: "cohere" },
    { id: `${RUN_PREFIX}-rdl-null`, provider: null },
  ];
  for (const r of rows) {
    await pgModule.query(
      `INSERT INTO ${schema}.request_detail_logs (id, timestamp, provider)
       VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [r.id, now, r.provider]
    );
  }
}

async function seedRoutingDecisions() {
  const schema = pgModule.getSchema();
  const rows = [
    { provider_selected: "openai-compatible-abc" },
    { provider_selected: "gigachat-compatible-xyz" },
    { provider_selected: "deepseek" },
    { provider_selected: null },
  ];
  for (const r of rows) {
    await pgModule.query(
      `INSERT INTO ${schema}.routing_decisions (request_id, provider_selected)
       VALUES ($1, $2)`,
      [`${RUN_PREFIX}-req`, r.provider_selected]
    );
  }
}

async function seedComboAdaptationState() {
  const schema = pgModule.getSchema();
  const rows = [
    { combo: `${RUN_PREFIX}-c1`, provider_id: "openai-compatible-abc" },
    { combo: `${RUN_PREFIX}-c2`, provider_id: "gigachat-compatible-xyz" },
    { combo: `${RUN_PREFIX}-c3`, provider_id: "xai" },
  ];
  for (const r of rows) {
    await pgModule.query(
      `INSERT INTO ${schema}.combo_adaptation_state (combo_id, provider_id)
       VALUES ($1, $2) ON CONFLICT (combo_id, provider_id) DO NOTHING`,
      [r.combo, r.provider_id]
    );
  }
}

async function seedRegisteredKeys() {
  const schema = pgModule.getSchema();
  const rows = [
    { id: `${RUN_PREFIX}-rk-openai`, provider: "openai-compatible-abc" },
    { id: `${RUN_PREFIX}-rk-giga`, provider: "gigachat-compatible-xyz" },
    { id: `${RUN_PREFIX}-rk-named`, provider: "together" },
    // provider = '' is a generic key — must survive the purge.
    { id: `${RUN_PREFIX}-rk-generic`, provider: "" },
  ];
  for (const r of rows) {
    await pgModule.query(
      `INSERT INTO ${schema}.registered_keys (id, key, key_prefix, name, provider)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
      [r.id, `${r.id}-key`, `${RUN_PREFIX}`, r.id, r.provider]
    );
  }
}

async function seedAuditLog() {
  const schema = pgModule.getSchema();
  const now = new Date().toISOString();
  const rows = [
    // provider-linked, non-compatible target → must be deleted.
    {
      action: `${RUN_PREFIX}.provider.create`,
      target: "openai",
      resource_type: "provider_connections",
    },
    // provider-linked, compatible target → must survive.
    {
      action: `${RUN_PREFIX}.provider.create`,
      target: "openai-compatible-abc",
      resource_type: "provider_connections",
    },
    // unrelated resource_type → must survive regardless of target.
    { action: `${RUN_PREFIX}.apikey.create`, target: "openai", resource_type: "api_key" },
    // administrative action with no provider linkage → must survive.
    { action: `${RUN_PREFIX}.settings.update`, target: null, resource_type: "settings" },
  ];
  for (const r of rows) {
    await pgModule.query(
      `INSERT INTO ${schema}.audit_log (timestamp, action, actor, target, resource_type, status)
       VALUES ($1, $2, 'system', $3, $4, 'ok')`,
      [now, r.action, r.target, r.resource_type]
    );
  }
}

async function seedAll() {
  await seedProviderConnections();
  await seedProviderNodes();
  await seedUsageHistory();
  await seedCallLogs();
  await seedRequestDetailLogs();
  await seedRoutingDecisions();
  await seedComboAdaptationState();
  await seedRegisteredKeys();
  await seedAuditLog();
}

async function cleanup() {
  const schema = pgModule.getSchema();
  const p = `${RUN_PREFIX}%`;
  await pgModule.query(`DELETE FROM ${schema}.provider_connections WHERE id LIKE $1`, [p]);
  await pgModule.query(`DELETE FROM ${schema}.provider_nodes WHERE id LIKE $1`, [p]);
  await pgModule.query(`DELETE FROM ${schema}.usage_history WHERE timestamp LIKE $1`, [p]);
  await pgModule.query(`DELETE FROM ${schema}.call_logs WHERE id LIKE $1`, [p]);
  await pgModule.query(`DELETE FROM ${schema}.request_detail_logs WHERE id LIKE $1`, [p]);
  await pgModule.query(`DELETE FROM ${schema}.routing_decisions WHERE request_id LIKE $1`, [p]);
  await pgModule.query(`DELETE FROM ${schema}.combo_adaptation_state WHERE combo_id LIKE $1`, [p]);
  await pgModule.query(`DELETE FROM ${schema}.registered_keys WHERE id LIKE $1`, [p]);
  await pgModule.query(`DELETE FROM ${schema}.audit_log WHERE action LIKE $1`, [`${RUN_PREFIX}%`]);
  // The migration's own purge record targets 'provider_connections' with the
  // fixed action name — scrub any purge records written during this test run.
  await pgModule.query(
    `DELETE FROM ${schema}.audit_log
     WHERE action = 'migration.purge_named_providers' AND status = 'started'
       AND details LIKE '%"provider_connections"%'
       AND timestamp >= $1`,
    [TEST_RUN_STARTED_AT]
  );
  core.resetDbInstance();
}

// Marker so cleanup only scrubs purge records created during this test process.
const TEST_RUN_STARTED_AT = to_ts(new Date());
function to_ts(d: Date): string {
  // Match the audit_log timestamp format: 'YYYY-MM-DD HH24:MI:SS' (UTC).
  return d.toISOString().slice(0, 19).replace("T", " ");
}

async function countPurgeRecordsSince(): Promise<number> {
  return scalar(
    `SELECT COUNT(*)::int AS cnt FROM __S__.audit_log
     WHERE action = 'migration.purge_named_providers'
       AND status = 'started'
       AND timestamp >= $1`,
    [TEST_RUN_STARTED_AT]
  );
}

test.beforeEach(async () => {
  await cleanup();
});

test.after(async () => {
  await cleanup();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// -------------------------------------------------------------------------
// Scenario (a): fresh DB with no non-compatible rows → true no-op.
// Models "0001-only / nothing to purge": every DELETE matches zero rows, no
// error, and the only side effect is the additive audit record with all-zero
// pre-deletion counts.
// -------------------------------------------------------------------------
serialTest("scenario (a): no-op on a DB with no non-compatible rows", async () => {
  // Seed ONLY compatible rows plus survive-forever edge cases (NULL / generic).
  const schema = pgModule.getSchema();
  const now = new Date().toISOString();
  await pgModule.query(
    `INSERT INTO ${schema}.provider_connections (id, provider, created_at, updated_at)
     VALUES ($1, $2, $3, $3) ON CONFLICT (id) DO NOTHING`,
    [`${RUN_PREFIX}-pc-openai`, "openai-compatible-abc", now]
  );
  await pgModule.query(
    `INSERT INTO ${schema}.registered_keys (id, key, key_prefix, name, provider)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
    [`${RUN_PREFIX}-rk-generic`, `${RUN_PREFIX}-gk`, RUN_PREFIX, `${RUN_PREFIX}-gk`, ""]
  );

  const purgeBefore = await countPurgeRecordsSince();

  await runMigration(); // must not throw

  // Compatible + generic rows untouched.
  assert.equal(
    await scalar(
      `SELECT COUNT(*)::int AS cnt FROM __S__.provider_connections WHERE id = $1`,
      [`${RUN_PREFIX}-pc-openai`]
    ),
    1,
    "compatible provider_connection survives"
  );
  assert.equal(
    await scalar(`SELECT COUNT(*)::int AS cnt FROM __S__.registered_keys WHERE id = $1`, [
      `${RUN_PREFIX}-rk-generic`,
    ]),
    1,
    "generic registered_key (provider='') survives"
  );

  // The audit record is written even on a no-op run — with all-zero counts.
  const purgeAfter = await countPurgeRecordsSince();
  assert.equal(purgeAfter, purgeBefore + 1, "exactly one purge audit record appended");

  const detailsRow = await pgModule.query<{ details: string }>(
    `SELECT details FROM ${schema}.audit_log
     WHERE action = 'migration.purge_named_providers' AND status = 'started'
       AND timestamp >= $1
     ORDER BY id DESC LIMIT 1`,
    [TEST_RUN_STARTED_AT]
  );
  const details = JSON.parse(detailsRow.rows[0].details) as Record<string, number>;
  assert.equal(details.provider_connections, 0, "zero non-compatible provider_connections counted");
  assert.equal(details.registered_keys, 0, "generic key not counted as a purge target");
});

// -------------------------------------------------------------------------
// Scenario (b): fully-populated fixture → deletes exactly the non-compatible
// rows in every table; compatible + NULL + generic rows survive; unrelated
// audit_log rows survive; a purge audit record with the fixed action exists.
// -------------------------------------------------------------------------
serialTest("scenario (b): purges non-compatible rows across every table", async () => {
  await seedAll();

  await runMigration();

  // provider_connections: 2 compatible survive; named/claude/bare deleted.
  assert.equal(
    await scalar(
      `SELECT COUNT(*)::int AS cnt FROM __S__.provider_connections
       WHERE id LIKE $1 AND provider ~ '^(gigachat-compatible-|openai-compatible-).+'`,
      [`${RUN_PREFIX}%`]
    ),
    2,
    "both compatible provider_connections survive"
  );
  assert.equal(
    await scalar(
      `SELECT COUNT(*)::int AS cnt FROM __S__.provider_connections
       WHERE id LIKE $1 AND provider !~ '^(gigachat-compatible-|openai-compatible-).+'`,
      [`${RUN_PREFIX}%`]
    ),
    0,
    "all non-compatible provider_connections (incl. bare 'openai-compatible') purged"
  );

  // provider_nodes: 2 compatible types survive; 'anthropic' deleted.
  assert.equal(
    await scalar(
      `SELECT COUNT(*)::int AS cnt FROM __S__.provider_nodes WHERE id LIKE $1`,
      [`${RUN_PREFIX}%`]
    ),
    2,
    "only compatible-type provider_nodes survive"
  );

  // usage_history: compatible (2) + NULL (1) survive; 'openai' deleted.
  assert.equal(
    await scalar(
      `SELECT COUNT(*)::int AS cnt FROM __S__.usage_history WHERE timestamp LIKE $1`,
      [`${RUN_PREFIX}%`]
    ),
    3,
    "compatible + NULL-provider usage_history survive; named purged"
  );
  assert.equal(
    await scalar(
      `SELECT COUNT(*)::int AS cnt FROM __S__.usage_history
       WHERE timestamp LIKE $1 AND provider IS NULL`,
      [`${RUN_PREFIX}%`]
    ),
    1,
    "NULL-provider usage_history row explicitly survives"
  );

  // call_logs: compatible (2) + NULL (1) survive.
  assert.equal(
    await scalar(`SELECT COUNT(*)::int AS cnt FROM __S__.call_logs WHERE id LIKE $1`, [
      `${RUN_PREFIX}%`,
    ]),
    3,
    "compatible + NULL-provider call_logs survive"
  );

  // request_detail_logs: compatible (2) + NULL (1) survive.
  assert.equal(
    await scalar(
      `SELECT COUNT(*)::int AS cnt FROM __S__.request_detail_logs WHERE id LIKE $1`,
      [`${RUN_PREFIX}%`]
    ),
    3,
    "compatible + NULL-provider request_detail_logs survive"
  );

  // routing_decisions: compatible (2) + NULL (1) survive.
  assert.equal(
    await scalar(
      `SELECT COUNT(*)::int AS cnt FROM __S__.routing_decisions WHERE request_id = $1`,
      [`${RUN_PREFIX}-req`]
    ),
    3,
    "compatible + NULL provider_selected routing_decisions survive"
  );

  // combo_adaptation_state: 2 compatible survive; 'xai' deleted.
  assert.equal(
    await scalar(
      `SELECT COUNT(*)::int AS cnt FROM __S__.combo_adaptation_state WHERE combo_id LIKE $1`,
      [`${RUN_PREFIX}%`]
    ),
    2,
    "only compatible combo_adaptation_state survive"
  );

  // registered_keys: compatible (2) + generic '' (1) survive; 'together' deleted.
  assert.equal(
    await scalar(
      `SELECT COUNT(*)::int AS cnt FROM __S__.registered_keys WHERE id LIKE $1`,
      [`${RUN_PREFIX}%`]
    ),
    3,
    "compatible + generic ('') registered_keys survive"
  );
  assert.equal(
    await scalar(
      `SELECT COUNT(*)::int AS cnt FROM __S__.registered_keys
       WHERE id LIKE $1 AND provider = ''`,
      [`${RUN_PREFIX}%`]
    ),
    1,
    "generic registered_key explicitly survives"
  );

  // audit_log: provider-linked non-compatible deleted; the other 3 survive.
  assert.equal(
    await scalar(
      `SELECT COUNT(*)::int AS cnt FROM __S__.audit_log
       WHERE action LIKE $1 AND resource_type = 'provider_connections'
         AND target = 'openai'`,
      [`${RUN_PREFIX}%`]
    ),
    0,
    "provider-linked non-compatible audit row purged"
  );
  assert.equal(
    await scalar(
      `SELECT COUNT(*)::int AS cnt FROM __S__.audit_log
       WHERE action LIKE $1 AND resource_type = 'provider_connections'
         AND target = 'openai-compatible-abc'`,
      [`${RUN_PREFIX}%`]
    ),
    1,
    "provider-linked compatible audit row survives"
  );
  assert.equal(
    await scalar(
      `SELECT COUNT(*)::int AS cnt FROM __S__.audit_log
       WHERE action LIKE $1 AND resource_type IN ('api_key', 'settings')`,
      [`${RUN_PREFIX}%`]
    ),
    2,
    "unrelated (non-provider_connections) audit rows survive"
  );

  // The purge record itself exists with the fixed action name.
  assert.ok((await countPurgeRecordsSince()) >= 1, "purge audit record written");

  // And the purge record's pre-deletion details captured the non-zero counts.
  const detailsRow = await pgModule.query<{ details: string }>(
    `SELECT details FROM ${schema()}.audit_log
     WHERE action = 'migration.purge_named_providers' AND status = 'started'
       AND timestamp >= $1
     ORDER BY id DESC LIMIT 1`,
    [TEST_RUN_STARTED_AT]
  );
  const details = JSON.parse(detailsRow.rows[0].details) as Record<string, number>;
  assert.equal(details.provider_connections, 3, "pre-deletion counted 3 non-compatible pc rows");
  assert.equal(details.provider_nodes, 1, "pre-deletion counted 1 non-compatible node");
  assert.equal(details.registered_keys, 1, "pre-deletion counted 1 named key (not the generic)");
});

// Small local helper so the details query above reads cleanly.
function schema(): string {
  return pgModule.getSchema();
}

// -------------------------------------------------------------------------
// Scenario (c): re-running the migration a second time is a true no-op — the
// non-compatible rows are already gone, so the second run deletes nothing and
// the surviving rows are unchanged.
// -------------------------------------------------------------------------
serialTest("scenario (c): second run is a true no-op", async () => {
  await seedAll();

  await runMigration();
  const survivorsAfterFirst = await scalar(
    `SELECT COUNT(*)::int AS cnt FROM __S__.provider_connections WHERE id LIKE $1`,
    [`${RUN_PREFIX}%`]
  );

  await runMigration(); // second run — must not throw, must not change survivors.

  const survivorsAfterSecond = await scalar(
    `SELECT COUNT(*)::int AS cnt FROM __S__.provider_connections WHERE id LIKE $1`,
    [`${RUN_PREFIX}%`]
  );
  assert.equal(
    survivorsAfterSecond,
    survivorsAfterFirst,
    "survivor count unchanged after a second run"
  );
  assert.equal(survivorsAfterSecond, 2, "still exactly the 2 compatible connections");

  // Second run's purge record reports all-zero counts (nothing left to purge).
  const detailsRow = await pgModule.query<{ details: string }>(
    `SELECT details FROM ${schema()}.audit_log
     WHERE action = 'migration.purge_named_providers' AND status = 'started'
       AND timestamp >= $1
     ORDER BY id DESC LIMIT 1`,
    [TEST_RUN_STARTED_AT]
  );
  const details = JSON.parse(detailsRow.rows[0].details) as Record<string, number>;
  assert.equal(
    details.provider_connections,
    0,
    "second-run purge record counts zero remaining non-compatible rows"
  );
});

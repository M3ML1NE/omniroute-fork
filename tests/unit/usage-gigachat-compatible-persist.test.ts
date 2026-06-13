import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

// nonCriticalDbDisabled() is read at call time, so enabling full-DB mode here
// (before importing the modules) lets saveRequestUsage actually write.
process.env.OMNIROUTE_MINIMAL_DB = "false";

const usageHistory = await import("../../src/lib/usage/usageHistory.ts");
const core = await import("../../src/lib/db/core.ts");

/**
 * Proves usage for a gigachat-compatible-* provider is actually persisted to
 * usage_history and reads back — the symptom the user reported ("usage не
 * считается в аналитике за gigachat compatible провайдеров"). Uses a unique
 * provider id and cleans up so it is safe on the shared Postgres test DB.
 */
describe("usage persistence for gigachat-compatible providers", () => {
  const provider = `gigachat-compatible-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  after(async () => {
    const db = core.getDbInstance();
    await db.prepare("DELETE FROM usage_history WHERE provider = ?").run(provider);
  });

  it("persists in/out tokens and reads them back", async () => {
    await usageHistory.saveRequestUsage({
      provider,
      model: "GigaChat-3",
      connectionId: "conn-giga",
      apiKeyId: "key-1",
      apiKeyName: "Key 1",
      tokens: { input: 10, output: 33 },
      success: true,
      latencyMs: 120,
      timestamp: new Date().toISOString(),
    });

    const db = core.getDbInstance();
    const rows = (await db
      .prepare(
        "SELECT provider, tokens_input, tokens_output, combo_strategy, success FROM usage_history WHERE provider = ?"
      )
      .all(provider)) as Array<{
      provider: string;
      tokens_input: number;
      tokens_output: number;
      combo_strategy: string;
      success: number;
    }>;

    assert.equal(rows.length, 1, "exactly one usage row persisted");
    assert.equal(rows[0].tokens_input, 10, "input tokens persisted");
    assert.equal(rows[0].tokens_output, 33, "output tokens persisted");
    assert.equal(rows[0].combo_strategy, "direct", "combo_strategy defaulted (NOT NULL)");
    assert.equal(rows[0].success, 1, "success flag persisted");
  });

  it("surfaces the persisted row through getUsageDb", async () => {
    const res = await usageHistory.getUsageDb();
    const row = res.data.history.find((r) => r.provider === provider);
    assert.ok(row, "gigachat-compatible usage row visible in getUsageDb");
    assert.equal(
      (row?.tokens as { input?: number })?.input,
      10,
      "input tokens surfaced via getUsageDb"
    );
  });
});

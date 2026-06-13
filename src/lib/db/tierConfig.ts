import { getDbInstance } from "./core";
import type { TierConfig } from "../../../open-sse/services/tierTypes";
import { validateTierConfig, DEFAULT_TIER_CONFIG } from "../../../open-sse/services/tierConfig";

const TABLE = "tier_config";

export function initTierConfigTable(): void {
  const db = getDbInstance();
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    );
  `);
}

export function saveTierConfig(config: TierConfig): void {
  const db = getDbInstance();
  const serialized = JSON.stringify(config);
  db.prepare(
    `INSERT INTO ${TABLE} (key, value, updated_at) VALUES ('tier_config', ?, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`
  ).run(serialized);
}

export function loadTierConfigFromDb(): TierConfig | null {
  const db = getDbInstance();
  const row = db.prepare(`SELECT value FROM ${TABLE} WHERE key = 'tier_config'`).get() as
    | { value: string }
    | undefined;
  if (!row) return null;
  try {
    return validateTierConfig(JSON.parse(row.value));
  } catch {
    return null;
  }
}

export function loadTierConfig(): TierConfig {
  return loadTierConfigFromDb() || DEFAULT_TIER_CONFIG;
}

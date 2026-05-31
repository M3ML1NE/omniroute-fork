/**
 * db/featureFlags.ts — Feature flag DB overrides.
 *
 * Stores per-flag override values in the key_value table under the
 * "feature_flags" namespace. When an override is present it takes precedence
 * over the process environment variable of the same name.
 */

import { FEATURE_FLAG_DEFINITIONS } from "@/shared/constants/featureFlagDefinitions";
import { getDbInstance } from "./core";

const NAMESPACE = "feature_flags";

/**
 * Returns all feature flag overrides as a key→value map.
 */
export async function getFeatureFlagOverrides(): Promise<Record<string, string>> {
  const db = getDbInstance();
  const rows = (await db
    .prepare("SELECT key, value FROM key_value WHERE namespace = ?")
    .all(NAMESPACE)) as Array<{ key: string; value: string }>;

  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

/**
 * Returns the override value for a single flag, or undefined if no override
 * is stored.
 */
export async function getFeatureFlagOverride(key: string): Promise<string | undefined> {
  const db = getDbInstance();
  const row = (await db
    .prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
    .get(NAMESPACE, key)) as { value: string } | undefined;
  return row?.value;
}

/**
 * Persists (or replaces) an override for a single flag.
 */
export async function setFeatureFlagOverride(key: string, value: string): Promise<void> {
  const definition = FEATURE_FLAG_DEFINITIONS.find((d) => d.key === key);
  if (!definition) {
    throw new Error(`Unknown feature flag key: ${key}`);
  }
  if (
    definition.type === "enum" &&
    definition.enumValues &&
    !definition.enumValues.includes(value)
  ) {
    throw new Error(
      `Invalid value "${value}" for enum flag ${key}. Allowed: ${definition.enumValues.join(", ")}`
    );
  }
  const db = getDbInstance();
  await db
    .prepare(
      "INSERT INTO key_value (namespace, key, value) VALUES (?, ?, ?) ON CONFLICT (namespace, key) DO UPDATE SET value = excluded.value"
    )
    .run(NAMESPACE, key, value);
}

/**
 * Removes the override for a single flag, restoring env-var / default
 * behaviour.
 */
export async function removeFeatureFlagOverride(key: string): Promise<void> {
  const db = getDbInstance();
  await db
    .prepare("DELETE FROM key_value WHERE namespace = ? AND key = ?")
    .run(NAMESPACE, key);
}

/**
 * Removes all stored feature flag overrides.
 */
export async function clearAllFeatureFlagOverrides(): Promise<void> {
  const db = getDbInstance();
  await db.prepare("DELETE FROM key_value WHERE namespace = ?").run(NAMESPACE);
}

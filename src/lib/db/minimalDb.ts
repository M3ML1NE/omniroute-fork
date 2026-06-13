/**
 * minimalDb.ts — Minimal-DB mode feature flag.
 *
 * During the scoped Postgres migration, only ~22 critical-path DB modules have
 * been converted to async Postgres-compatible code. The remaining ~21
 * non-critical modules (gamification, evals, relay*, skills, memory,
 * cloudAgent, plugins, batches, files, syncTokens, contextHandoffs,
 * compression*, freeProxies, oneproxy, upstreamProxy, reasoningCache,
 * versionManager, cliToolState, tierConfig, etc.) still use sync better-sqlite3
 * patterns and SQLite-specific syntax that would break on Postgres.
 *
 * When OMNIROUTE_MINIMAL_DB is enabled (the default for this fork), those
 * non-critical modules must NOT execute DB queries — they return safe defaults
 * instead.
 *
 * ## Contract for non-critical modules (T6 will apply this)
 *
 * At the top of every exported function in a non-critical module:
 *
 * ```typescript
 * import { nonCriticalDbDisabled } from "@/lib/db/minimalDb";
 *
 * export function getMyThings(): MyThing[] {
 *   if (nonCriticalDbDisabled()) return [];   // safe default
 *   // ... real DB query ...
 * }
 *
 * export async function saveMyThing(thing: MyThing): Promise<void> {
 *   if (nonCriticalDbDisabled()) return;      // no-op
 *   // ... real DB write ...
 * }
 * ```
 *
 * Safe defaults by return type:
 *   - array  → []
 *   - object → undefined / null
 *   - void   → return (no-op)
 *   - boolean → false
 *   - number  → 0
 *
 * ## Environment variable
 *
 * | Value              | isMinimalDb() |
 * |--------------------|---------------|
 * | unset (default)    | false (OFF)   |
 * | "true" / "1"       | true  (ON)    |
 * | "false" / "0" / *  | false (OFF)   |
 *
 * The default flipped to OFF once every non-critical module
 * (usage/usageHistory, compression*, relay*, files, detailedLogs,
 * reasoningCache, etc.) was converted to Postgres-compatible async code, so
 * usage/logs/analytics now persist by default. Set OMNIROUTE_MINIMAL_DB=true
 * only to deliberately suppress non-critical DB writes again.
 */

/**
 * Returns true when Minimal-DB mode is active.
 *
 * Default: false (disabled) — the SQLite→Postgres migration of non-critical
 * modules is complete, so they execute real queries by default.
 */
export function isMinimalDb(): boolean {
  const v = process.env["OMNIROUTE_MINIMAL_DB"];
  if (v === undefined) return false; // default OFF — migration complete
  return v === "true" || v === "1";
}

/**
 * Guard for non-critical module operations.
 *
 * Returns true when non-critical DB modules should skip their queries and
 * return safe defaults instead.
 *
 * Usage:
 * ```typescript
 * if (nonCriticalDbDisabled()) return [];
 * ```
 */
export function nonCriticalDbDisabled(): boolean {
  return isMinimalDb();
}

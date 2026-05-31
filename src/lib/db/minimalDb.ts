/**
 * minimalDb.ts — Minimal-DB mode feature flag.
 *
 * During the scoped Postgres migration, only ~22 critical-path DB modules have
 * been converted to async Postgres-compatible code. The remaining ~21
 * non-critical modules (gamification, evals, relay*, skills, memory,
 * cloudAgent, webhooks, plugins, batches, files, syncTokens, contextHandoffs,
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
 * | unset (default)    | true  (ON)    |
 * | "true" / "1" / *   | true  (ON)    |
 * | "false"            | false (OFF)   |
 * | "0"                | false (OFF)   |
 *
 * Set OMNIROUTE_MINIMAL_DB=false only when ALL DB modules have been migrated
 * to Postgres-compatible async code.
 */

/**
 * Returns true when Minimal-DB mode is active.
 *
 * Default: true (enabled) — safe for this fork where only critical-path
 * modules are Postgres-ready.
 */
export function isMinimalDb(): boolean {
  const v = process.env["OMNIROUTE_MINIMAL_DB"];
  if (v === undefined) return true; // default ON
  return v !== "false" && v !== "0";
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

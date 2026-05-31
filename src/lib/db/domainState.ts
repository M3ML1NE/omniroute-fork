/**
 * Domain State Persistence — Phase 5 Foundation
 *
 * CRUD operations for persisting domain layer state in Postgres.
 * Replaces in-memory Map() storage with durable persistence.
 *
 * Tables: domain_fallback_chains, domain_budgets, domain_cost_history,
 *         domain_lockout_state, domain_circuit_breakers,
 *         domain_budget_reset_logs
 *
 * Schema is owned by db/migrations/postgres/0001_baseline.sql.
 * No runtime DDL here.
 *
 * @module lib/db/domainState
 */

import { getDbInstance } from "./core";
import { withTransaction } from "./postgres";

type JsonRecord = Record<string, unknown>;
type BudgetResetInterval = "daily" | "weekly" | "monthly";

interface BudgetConfigRecord {
  dailyLimitUsd: number;
  weeklyLimitUsd: number;
  monthlyLimitUsd: number;
  warningThreshold: number;
  resetInterval: BudgetResetInterval;
  resetTime: string;
  budgetResetAt: number | null;
  lastBudgetResetAt: number | null;
  warningEmittedAt: number | null;
  warningPeriodStart: number | null;
}

interface BudgetResetLogRecord {
  apiKeyId: string;
  resetInterval: BudgetResetInterval;
  previousSpend: number;
  resetAt: number;
  nextResetAt: number;
  periodStart: number;
  periodEnd: number;
}

interface FallbackChainEntry {
  provider: string;
  priority: number;
  enabled: boolean;
}

interface LockoutStateRecord {
  attempts: number[];
  lockedUntil: number | null;
}

interface CircuitBreakerStateRecord {
  state: string;
  failureCount: number;
  lastFailureTime: number | null;
  options?: JsonRecord | null;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

// ──────────────── Fallback Chains ────────────────

/**
 * Save a fallback chain for a model.
 * @param {string} model
 * @param {Array<{provider: string, priority: number, enabled: boolean}>} chain
 */
export async function saveFallbackChain(model: string, chain: FallbackChainEntry[]) {
  const db = getDbInstance();
  await db
    .prepare(
      `INSERT INTO domain_fallback_chains (model, chain) VALUES (?, ?)
       ON CONFLICT (model) DO UPDATE SET chain = EXCLUDED.chain`
    )
    .run(model, JSON.stringify(chain));
}

/**
 * Load a fallback chain for a model.
 * @param {string} model
 * @returns {Array<{provider: string, priority: number, enabled: boolean}> | null}
 */
export async function loadFallbackChain(model: string): Promise<FallbackChainEntry[] | null> {
  const db = getDbInstance();
  const row = await db
    .prepare("SELECT chain FROM domain_fallback_chains WHERE model = ?")
    .get(model);
  const chain = asRecord(row).chain;
  return typeof chain === "string" ? JSON.parse(chain) : null;
}

/**
 * Load all fallback chains.
 * @returns {Record<string, Array<{provider: string, priority: number, enabled: boolean}>>}
 */
export async function loadAllFallbackChains() {
  const db = getDbInstance();
  const rows = await db.prepare("SELECT model, chain FROM domain_fallback_chains").all();
  const result: Record<string, unknown> = {};
  for (const row of rows) {
    const record = asRecord(row);
    const model = typeof record.model === "string" ? record.model : null;
    const chain = typeof record.chain === "string" ? record.chain : null;
    if (!model || !chain) continue;
    result[model] = JSON.parse(chain);
  }
  return result;
}

/**
 * Delete a fallback chain.
 * @param {string} model
 * @returns {boolean}
 */
export async function deleteFallbackChain(model: string) {
  const db = getDbInstance();
  const info = await db
    .prepare("DELETE FROM domain_fallback_chains WHERE model = ?")
    .run(model);
  return info.changes > 0;
}

/**
 * Delete all fallback chains.
 */
export async function deleteAllFallbackChains() {
  const db = getDbInstance();
  await db.prepare("DELETE FROM domain_fallback_chains").run();
}

// ──────────────── Budgets ────────────────

/**
 * Save a budget config for an API key.
 * @param {string} apiKeyId
 * @param {{ dailyLimitUsd: number, monthlyLimitUsd?: number, warningThreshold?: number }} config
 */
export async function saveBudget(apiKeyId: string, config: Partial<BudgetConfigRecord>) {
  const db = getDbInstance();
  await db
    .prepare(
      `INSERT INTO domain_budgets (
         api_key_id,
         daily_limit_usd,
         weekly_limit_usd,
         monthly_limit_usd,
         warning_threshold,
         reset_interval,
         reset_time,
         budget_reset_at,
         last_budget_reset_at,
         warning_emitted_at,
         warning_period_start
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (api_key_id) DO UPDATE SET
         daily_limit_usd      = EXCLUDED.daily_limit_usd,
         weekly_limit_usd     = EXCLUDED.weekly_limit_usd,
         monthly_limit_usd    = EXCLUDED.monthly_limit_usd,
         warning_threshold    = EXCLUDED.warning_threshold,
         reset_interval       = EXCLUDED.reset_interval,
         reset_time           = EXCLUDED.reset_time,
         budget_reset_at      = EXCLUDED.budget_reset_at,
         last_budget_reset_at = EXCLUDED.last_budget_reset_at,
         warning_emitted_at   = EXCLUDED.warning_emitted_at,
         warning_period_start = EXCLUDED.warning_period_start`
    )
    .run(
      apiKeyId,
      toNumber(config.dailyLimitUsd),
      toNumber(config.weeklyLimitUsd),
      toNumber(config.monthlyLimitUsd),
      toNumber(config.warningThreshold, 0.8),
      typeof config.resetInterval === "string" ? config.resetInterval : "daily",
      typeof config.resetTime === "string" ? config.resetTime : "00:00",
      config.budgetResetAt ?? null,
      config.lastBudgetResetAt ?? null,
      config.warningEmittedAt ?? null,
      config.warningPeriodStart ?? null
    );
}

/**
 * Load a budget config.
 * @param {string} apiKeyId
 * @returns {{ dailyLimitUsd: number, monthlyLimitUsd: number, warningThreshold: number } | null}
 */
export async function loadBudget(apiKeyId: string): Promise<BudgetConfigRecord | null> {
  const db = getDbInstance();
  const row = await db
    .prepare("SELECT * FROM domain_budgets WHERE api_key_id = ?")
    .get(apiKeyId);
  if (!row) return null;
  const record = asRecord(row);
  return {
    dailyLimitUsd: toNumber(record.daily_limit_usd),
    weeklyLimitUsd: toNumber(record.weekly_limit_usd),
    monthlyLimitUsd: toNumber(record.monthly_limit_usd),
    warningThreshold: toNumber(record.warning_threshold, 0.8),
    resetInterval:
      typeof record.reset_interval === "string"
        ? (record.reset_interval as BudgetResetInterval)
        : "daily",
    resetTime: typeof record.reset_time === "string" ? record.reset_time : "00:00",
    budgetResetAt: toNumber(record.budget_reset_at, 0) || null,
    lastBudgetResetAt: toNumber(record.last_budget_reset_at, 0) || null,
    warningEmittedAt: toNumber(record.warning_emitted_at, 0) || null,
    warningPeriodStart: toNumber(record.warning_period_start, 0) || null,
  };
}

/**
 * Load all budget configs.
 * @returns {Record<string, BudgetConfigRecord>}
 */
export async function loadAllBudgets() {
  const db = getDbInstance();
  const rows = await db
    .prepare("SELECT * FROM domain_budgets ORDER BY api_key_id")
    .all();
  const result: Record<string, BudgetConfigRecord> = {};

  for (const row of rows) {
    const record = asRecord(row);
    const apiKeyId = typeof record.api_key_id === "string" ? record.api_key_id : "";
    if (!apiKeyId) continue;

    result[apiKeyId] = {
      dailyLimitUsd: toNumber(record.daily_limit_usd),
      weeklyLimitUsd: toNumber(record.weekly_limit_usd),
      monthlyLimitUsd: toNumber(record.monthly_limit_usd),
      warningThreshold: toNumber(record.warning_threshold, 0.8),
      resetInterval:
        typeof record.reset_interval === "string"
          ? (record.reset_interval as BudgetResetInterval)
          : "daily",
      resetTime: typeof record.reset_time === "string" ? record.reset_time : "00:00",
      budgetResetAt: toNumber(record.budget_reset_at, 0) || null,
      lastBudgetResetAt: toNumber(record.last_budget_reset_at, 0) || null,
      warningEmittedAt: toNumber(record.warning_emitted_at, 0) || null,
      warningPeriodStart: toNumber(record.warning_period_start, 0) || null,
    };
  }

  return result;
}

/**
 * Persist a budget reset log entry.
 * @param {BudgetResetLogRecord} entry
 */
export async function saveBudgetResetLog(entry: BudgetResetLogRecord) {
  const db = getDbInstance();
  await db
    .prepare(
      `INSERT INTO domain_budget_reset_logs
         (api_key_id, reset_interval, previous_spend, reset_at, next_reset_at, period_start, period_end)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      entry.apiKeyId,
      entry.resetInterval,
      entry.previousSpend,
      entry.resetAt,
      entry.nextResetAt,
      entry.periodStart,
      entry.periodEnd
    );
}

/**
 * Load recent budget reset logs for an API key.
 * @param {string} apiKeyId
 * @param {number} [limit=10]
 * @returns {Array<BudgetResetLogRecord & { id: number }>}
 */
export async function loadBudgetResetLogs(apiKeyId: string, limit = 10) {
  const db = getDbInstance();
  const rows = await db
    .prepare(
      `SELECT id, api_key_id, reset_interval, previous_spend, reset_at, next_reset_at, period_start, period_end
       FROM domain_budget_reset_logs
       WHERE api_key_id = ?
       ORDER BY reset_at DESC
       LIMIT ?`
    )
    .all(apiKeyId, Math.max(1, Math.floor(limit)));

  return rows
    .map((row) => {
      const record = asRecord(row);
      return {
        id: toNumber(record.id),
        apiKeyId: typeof record.api_key_id === "string" ? record.api_key_id : "",
        resetInterval:
          typeof record.reset_interval === "string"
            ? (record.reset_interval as BudgetResetInterval)
            : "daily",
        previousSpend: toNumber(record.previous_spend),
        resetAt: toNumber(record.reset_at),
        nextResetAt: toNumber(record.next_reset_at),
        periodStart: toNumber(record.period_start),
        periodEnd: toNumber(record.period_end),
      };
    })
    .filter((entry) => entry.apiKeyId.length > 0);
}

/**
 * Delete a budget config.
 * @param {string} apiKeyId
 */
export async function deleteBudget(apiKeyId: string) {
  const db = getDbInstance();
  await db.prepare("DELETE FROM domain_budgets WHERE api_key_id = ?").run(apiKeyId);
  await db
    .prepare("DELETE FROM domain_budget_reset_logs WHERE api_key_id = ?")
    .run(apiKeyId);
}

// ──────────────── Cost History ────────────────

/**
 * Record a cost entry.
 * @param {string} apiKeyId
 * @param {number} cost
 * @param {number} [timestamp]
 */
export async function saveCostEntry(apiKeyId: string, cost: number, timestamp = Date.now()) {
  const db = getDbInstance();
  await db
    .prepare(
      "INSERT INTO domain_cost_history (api_key_id, cost, timestamp) VALUES (?, ?, ?)"
    )
    .run(apiKeyId, cost, timestamp);
}

export async function batchSaveCostEntries(
  entries: Array<{ apiKeyId: string; cost: number; timestamp: number }>
) {
  if (!Array.isArray(entries) || entries.length === 0) return;

  await withTransaction(async (client) => {
    for (const entry of entries) {
      await client.query(
        "INSERT INTO domain_cost_history (api_key_id, cost, timestamp) VALUES ($1, $2, $3)",
        [entry.apiKeyId, entry.cost, entry.timestamp]
      );
    }
  });
}

export async function loadCostTotal(apiKeyId: string, sinceTimestamp: number) {
  const db = getDbInstance();
  const row = await db
    .prepare(
      "SELECT COALESCE(SUM(cost), 0) AS total FROM domain_cost_history WHERE api_key_id = ? AND timestamp >= ?"
    )
    .get<{ total?: number }>(apiKeyId, sinceTimestamp);
  return Number(row?.total || 0);
}

/**
 * Load cost entries for an API key within a time window.
 * @param {string} apiKeyId
 * @param {number} sinceTimestamp
 * @returns {Array<{cost: number, timestamp: number}>}
 */
export async function loadCostEntries(apiKeyId: string, sinceTimestamp: number) {
  const db = getDbInstance();
  return db
    .prepare(
      "SELECT cost, timestamp FROM domain_cost_history WHERE api_key_id = ? AND timestamp >= ? ORDER BY timestamp"
    )
    .all(apiKeyId, sinceTimestamp);
}

/**
 * Load cost entries for an API key within a bounded time window.
 * @param {string} apiKeyId
 * @param {number} sinceTimestamp
 * @param {number} untilTimestamp
 * @returns {Array<{cost: number, timestamp: number}>}
 */
export async function loadCostEntriesInRange(
  apiKeyId: string,
  sinceTimestamp: number,
  untilTimestamp: number
) {
  const db = getDbInstance();
  return db
    .prepare(
      `SELECT cost, timestamp
       FROM domain_cost_history
       WHERE api_key_id = ? AND timestamp >= ? AND timestamp < ?
       ORDER BY timestamp`
    )
    .all(apiKeyId, sinceTimestamp, untilTimestamp);
}

/**
 * Delete old cost entries (cleanup).
 * @param {number} olderThanTimestamp
 * @returns {number} deleted count
 */
export async function cleanOldCostEntries(olderThanTimestamp: number) {
  const db = getDbInstance();
  const info = await db
    .prepare("DELETE FROM domain_cost_history WHERE timestamp < ?")
    .run(olderThanTimestamp);
  return info.changes;
}

/**
 * Delete all cost data for an API key.
 * @param {string} apiKeyId
 */
export async function deleteCostEntries(apiKeyId: string) {
  const db = getDbInstance();
  await db
    .prepare("DELETE FROM domain_cost_history WHERE api_key_id = ?")
    .run(apiKeyId);
}

/**
 * Delete all cost data.
 */
export async function deleteAllCostData() {
  const db = getDbInstance();
  await db.prepare("DELETE FROM domain_cost_history").run();
  await db.prepare("DELETE FROM domain_budgets").run();
  await db.prepare("DELETE FROM domain_budget_reset_logs").run();
}

// ──────────────── Lockout State ────────────────

/**
 * Save lockout state for an identifier.
 * @param {string} identifier
 * @param {{ attempts: number[], lockedUntil: number|null }} state
 */
export async function saveLockoutState(identifier: string, state: LockoutStateRecord) {
  const db = getDbInstance();
  await db
    .prepare(
      `INSERT INTO domain_lockout_state (identifier, attempts, locked_until)
       VALUES (?, ?, ?)
       ON CONFLICT (identifier) DO UPDATE SET
         attempts     = EXCLUDED.attempts,
         locked_until = EXCLUDED.locked_until`
    )
    .run(identifier, JSON.stringify(state.attempts), state.lockedUntil);
}

/**
 * Load lockout state for an identifier.
 * @param {string} identifier
 * @returns {{ attempts: number[], lockedUntil: number|null } | null}
 */
export async function loadLockoutState(identifier: string): Promise<LockoutStateRecord | null> {
  const db = getDbInstance();
  const row = await db
    .prepare("SELECT * FROM domain_lockout_state WHERE identifier = ?")
    .get(identifier);
  if (!row) return null;
  const record = asRecord(row);
  const attemptsRaw = typeof record.attempts === "string" ? record.attempts : "[]";
  const lockedUntilRaw = record.locked_until;
  return {
    attempts: JSON.parse(attemptsRaw),
    lockedUntil: typeof lockedUntilRaw === "number" ? lockedUntilRaw : null,
  };
}

/**
 * Delete lockout state for an identifier.
 * @param {string} identifier
 */
export async function deleteLockoutState(identifier: string) {
  const db = getDbInstance();
  await db
    .prepare("DELETE FROM domain_lockout_state WHERE identifier = ?")
    .run(identifier);
}

/**
 * Get all locked identifiers.
 * @returns {Array<{identifier: string, lockedUntil: number}>}
 */
export async function loadAllLockedIdentifiers() {
  const db = getDbInstance();
  const now = Date.now();
  const rows = await db
    .prepare(
      "SELECT identifier, locked_until FROM domain_lockout_state WHERE locked_until IS NOT NULL AND locked_until > ?"
    )
    .all(now);

  return rows
    .map((row) => {
      const record = asRecord(row);
      return {
        identifier: typeof record.identifier === "string" ? record.identifier : "",
        lockedUntil: toNumber(record.locked_until),
      };
    })
    .filter((row) => row.identifier.length > 0);
}

// ──────────────── Circuit Breakers ────────────────

/**
 * Save circuit breaker state.
 * @param {string} name
 * @param {{ state: string, failureCount: number, lastFailureTime: number|null, options?: object }} cbState
 */
export async function saveCircuitBreakerState(name: string, cbState: CircuitBreakerStateRecord) {
  const db = getDbInstance();
  await db
    .prepare(
      `INSERT INTO domain_circuit_breakers (name, state, failure_count, last_failure_time, options)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET
         state             = EXCLUDED.state,
         failure_count     = EXCLUDED.failure_count,
         last_failure_time = EXCLUDED.last_failure_time,
         options           = EXCLUDED.options`
    )
    .run(
      name,
      cbState.state,
      cbState.failureCount,
      cbState.lastFailureTime,
      cbState.options ? JSON.stringify(cbState.options) : null
    );
}

/**
 * Load circuit breaker state.
 * @param {string} name
 * @returns {{ state: string, failureCount: number, lastFailureTime: number|null, options?: object } | null}
 */
export async function loadCircuitBreakerState(
  name: string
): Promise<CircuitBreakerStateRecord | null> {
  const db = getDbInstance();
  const row = await db
    .prepare("SELECT * FROM domain_circuit_breakers WHERE name = ?")
    .get(name);
  if (!row) return null;
  const record = asRecord(row);
  const options = typeof record.options === "string" ? JSON.parse(record.options) : null;
  return {
    state: typeof record.state === "string" ? record.state : "CLOSED",
    failureCount: toNumber(record.failure_count),
    lastFailureTime: toNumber(record.last_failure_time, 0) || null,
    options,
  };
}

/**
 * Load all circuit breaker states.
 * @returns {Array<{name: string, state: string, failureCount: number, lastFailureTime: number|null}>}
 */
export async function loadAllCircuitBreakerStates() {
  const db = getDbInstance();
  const rows = await db
    .prepare(
      "SELECT name, state, failure_count, last_failure_time FROM domain_circuit_breakers"
    )
    .all();

  return rows
    .map((row) => {
      const record = asRecord(row);
      return {
        name: typeof record.name === "string" ? record.name : "",
        state: typeof record.state === "string" ? record.state : "CLOSED",
        failureCount: toNumber(record.failure_count),
        lastFailureTime: toNumber(record.last_failure_time, 0) || null,
      };
    })
    .filter((row) => row.name.length > 0);
}

/**
 * Delete a circuit breaker state.
 * @param {string} name
 */
export async function deleteCircuitBreakerState(name: string) {
  const db = getDbInstance();
  await db.prepare("DELETE FROM domain_circuit_breakers WHERE name = ?").run(name);
}

/**
 * Delete all circuit breaker states.
 */
export async function deleteAllCircuitBreakerStates() {
  const db = getDbInstance();
  await db.prepare("DELETE FROM domain_circuit_breakers").run();
}

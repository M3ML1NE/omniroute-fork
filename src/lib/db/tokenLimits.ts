import { randomUUID } from "crypto";
import { getDbInstance } from "./core";
import { getBudgetWindow, type BudgetResetInterval } from "@/domain/costRules";

export type TokenLimitScopeType = "model" | "provider" | "global";

export interface TokenLimit {
  id: string;
  apiKeyId: string;
  scopeType: TokenLimitScopeType;
  scopeValue: string;
  tokenLimit: number;
  resetInterval: BudgetResetInterval;
  resetTime: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertTokenLimitInput {
  id?: string;
  apiKeyId: string;
  scopeType: TokenLimitScopeType;
  scopeValue?: string;
  tokenLimit: number;
  resetInterval?: BudgetResetInterval;
  resetTime?: string;
  enabled?: boolean;
}

export interface TokenWindowState {
  windowStart: string;
  didReset: boolean;
  periodStartAt: number;
  nextResetAt: number;
}

type JsonRecord = Record<string, unknown>;

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

function normalizeScopeType(value: unknown): TokenLimitScopeType {
  if (value === "model" || value === "provider" || value === "global") return value;
  return "global";
}

function normalizeResetInterval(value: unknown): BudgetResetInterval {
  if (value === "daily" || value === "weekly" || value === "monthly") return value;
  return "monthly";
}

function rowToTokenLimit(row: unknown): TokenLimit {
  const r = asRecord(row);
  return {
    id: typeof r.id === "string" ? r.id : "",
    apiKeyId: typeof r.api_key_id === "string" ? r.api_key_id : "",
    scopeType: normalizeScopeType(r.scope_type),
    scopeValue: typeof r.scope_value === "string" ? r.scope_value : "",
    tokenLimit: toNumber(r.token_limit),
    resetInterval: normalizeResetInterval(r.reset_interval),
    resetTime: typeof r.reset_time === "string" && r.reset_time ? r.reset_time : "00:00",
    enabled: toNumber(r.enabled, 1) !== 0,
    createdAt: typeof r.created_at === "string" ? r.created_at : "",
    updatedAt: typeof r.updated_at === "string" ? r.updated_at : "",
  };
}

export async function upsertTokenLimit(input: UpsertTokenLimitInput): Promise<TokenLimit> {
  const db = getDbInstance();
  const scopeType = normalizeScopeType(input.scopeType);
  const scopeValue = scopeType === "global" ? "" : (input.scopeValue ?? "").trim();
  const resetInterval = normalizeResetInterval(input.resetInterval);
  const resetTime =
    typeof input.resetTime === "string" && input.resetTime ? input.resetTime : "00:00";
  const enabled = input.enabled === false ? 0 : 1;
  const tokenLimit = Math.floor(toNumber(input.tokenLimit));
  const id = input.id && input.id.trim() ? input.id.trim() : randomUUID();

  await db
    .prepare(
      `INSERT INTO api_key_token_limits
         (id, api_key_id, scope_type, scope_value, token_limit, reset_interval, reset_time, enabled, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
       ON CONFLICT (api_key_id, scope_type, scope_value)
       DO UPDATE SET token_limit    = excluded.token_limit,
                     reset_interval = excluded.reset_interval,
                     reset_time     = excluded.reset_time,
                     enabled        = excluded.enabled,
                     updated_at     = NOW()`
    )
    .run(id, input.apiKeyId, scopeType, scopeValue, tokenLimit, resetInterval, resetTime, enabled);

  const row = await db
    .prepare(
      "SELECT * FROM api_key_token_limits WHERE api_key_id = $1 AND scope_type = $2 AND scope_value = $3"
    )
    .get(input.apiKeyId, scopeType, scopeValue);
  return rowToTokenLimit(row);
}

export async function listTokenLimits(apiKeyId: string): Promise<TokenLimit[]> {
  const db = getDbInstance();
  const rows = await db
    .prepare(
      `SELECT * FROM api_key_token_limits
       WHERE api_key_id = $1
       ORDER BY CASE scope_type WHEN 'model' THEN 0 WHEN 'provider' THEN 1 ELSE 2 END, scope_value`
    )
    .all(apiKeyId);
  return rows.map(rowToTokenLimit);
}

export async function getTokenLimitsForRequest(
  apiKeyId: string,
  provider: string,
  model: string
): Promise<TokenLimit[]> {
  const db = getDbInstance();
  const rows = await db
    .prepare(
      `SELECT * FROM api_key_token_limits
       WHERE api_key_id = $1
         AND enabled = 1
         AND (
           (scope_type = 'global')
           OR (scope_type = 'model' AND scope_value = $2)
           OR (scope_type = 'provider' AND scope_value = $3)
         )`
    )
    .all(apiKeyId, model || "", provider || "");
  return rows.map(rowToTokenLimit);
}

export async function deleteTokenLimit(id: string): Promise<boolean> {
  const db = getDbInstance();
  await db.prepare("DELETE FROM api_key_token_counters WHERE limit_id = $1").run(id);
  await db.prepare("DELETE FROM api_key_token_limit_reset_logs WHERE limit_id = $1").run(id);
  const info = await db.prepare("DELETE FROM api_key_token_limits WHERE id = $1").run(id);
  return info.changes > 0;
}

export function resetWindowIfElapsed(limit: TokenLimit, now = Date.now()): TokenWindowState {
  const window = getBudgetWindow(limit.resetInterval, limit.resetTime, now);
  const windowStart = String(window.periodStartAt);
  return {
    windowStart,
    didReset: false,
    periodStartAt: window.periodStartAt,
    nextResetAt: window.nextResetAt,
  };
}

export async function getWindowUsage(limit: TokenLimit, now = Date.now()): Promise<number> {
  const db = getDbInstance();
  const { windowStart } = resetWindowIfElapsed(limit, now);
  const row = await db
    .prepare(
      "SELECT tokens_used FROM api_key_token_counters WHERE limit_id = $1 AND window_start = $2"
    )
    .get(limit.id, windowStart);
  return toNumber(asRecord(row).tokens_used);
}

export async function incrementWindowTokens(
  limitId: string,
  windowStart: string,
  tokens: number
): Promise<number> {
  const db = getDbInstance();
  const delta = Math.max(0, Math.floor(toNumber(tokens)));
  const row = await db
    .prepare(
      `INSERT INTO api_key_token_counters (limit_id, window_start, tokens_used, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (limit_id, window_start)
       DO UPDATE SET tokens_used = api_key_token_counters.tokens_used + excluded.tokens_used,
                     updated_at  = NOW()
       RETURNING tokens_used`
    )
    .get(limitId, windowStart, delta);
  return toNumber(asRecord(row).tokens_used);
}

export async function logTokenLimitReset(
  limitId: string,
  prevTokens: number,
  windowStart: string
): Promise<void> {
  const db = getDbInstance();
  await db
    .prepare(
      `INSERT INTO api_key_token_limit_reset_logs (limit_id, reset_at, prev_tokens, window_start)
       VALUES ($1, NOW(), $2, $3)`
    )
    .run(limitId, Math.max(0, Math.floor(toNumber(prevTokens))), windowStart);
}

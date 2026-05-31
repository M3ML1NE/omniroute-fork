import { getDbInstance, withTransaction } from "../../src/lib/db/core.ts";
import {
  resetWindowIfElapsed,
  getWindowUsage,
  incrementWindowTokens,
  getTokenLimitsForRequest,
  logTokenLimitReset,
  type TokenLimit,
} from "@/lib/localDb";

interface CacheEntry {
  windowStart: string;
  tokensUsed: number;
  syncedAt: number;
}

const cache = new Map<string, CacheEntry>();

const CACHE_TTL_MS = 5_000;

export async function seedWindowUsageFromHistory(limit: TokenLimit, now = Date.now()): Promise<number> {
  const { periodStartAt } = resetWindowIfElapsed(limit, now);
  const lowerBound = new Date(periodStartAt).toISOString();
  const db = getDbInstance();

  const tokenSum = `COALESCE(SUM(
      COALESCE(tokens_input, 0) + COALESCE(tokens_output, 0)
      + COALESCE(tokens_reasoning, 0)
    ), 0) AS total`;

  let row: unknown;
  if (limit.scopeType === "model") {
    row = await db
      .prepare(
        `SELECT ${tokenSum} FROM usage_history
         WHERE api_key_id = ? AND model = ? AND timestamp >= ?`
      )
      .get(limit.apiKeyId, limit.scopeValue, lowerBound);
  } else if (limit.scopeType === "provider") {
    row = await db
      .prepare(
        `SELECT ${tokenSum} FROM usage_history
         WHERE api_key_id = ? AND provider = ? AND timestamp >= ?`
      )
      .get(limit.apiKeyId, limit.scopeValue, lowerBound);
  } else {
    row = await db
      .prepare(
        `SELECT ${tokenSum} FROM usage_history
         WHERE api_key_id = ? AND timestamp >= ?`
      )
      .get(limit.apiKeyId, lowerBound);
  }

  const total = row && typeof row === "object" ? (row as { total?: unknown }).total : 0;
  const n = typeof total === "number" ? total : Number(total);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export async function getCurrentWindowUsage(
  limit: TokenLimit,
  now = Date.now(),
  forceFresh = false
): Promise<number> {
  const { windowStart } = resetWindowIfElapsed(limit, now);
  const cached = cache.get(limit.id);

  if (
    !forceFresh &&
    cached &&
    cached.windowStart === windowStart &&
    now - cached.syncedAt < CACHE_TTL_MS
  ) {
    return cached.tokensUsed;
  }

  let dbUsage = await getWindowUsage(limit, now);

  if (dbUsage === 0 && (!cached || cached.windowStart !== windowStart)) {
    const seeded = await seedWindowUsageFromHistory(limit, now);
    if (seeded > 0) {
      dbUsage = await incrementWindowTokens(limit.id, windowStart, seeded);
    }
  }

  cache.set(limit.id, { windowStart, tokensUsed: dbUsage, syncedAt: now });
  return dbUsage;
}

export async function addWindowTokens(limit: TokenLimit, tokens: number, now = Date.now()): Promise<number> {
  const { windowStart } = resetWindowIfElapsed(limit, now);
  const delta = tokens > 0 ? Math.floor(tokens) : 0;
  const newTotal = await incrementWindowTokens(limit.id, windowStart, delta);
  cache.set(limit.id, { windowStart, tokensUsed: newTotal, syncedAt: now });
  return newTotal;
}

export function syncCache(limitId: string, windowStart: string, tokensUsed: number): void {
  cache.set(limitId, { windowStart, tokensUsed, syncedAt: Date.now() });
}

export function invalidateLimit(limitId: string): void {
  cache.delete(limitId);
}

export function clearTokenLimitCache(): void {
  cache.clear();
}

export interface TokenLimitBreach {
  limitId: string;
  scopeType: TokenLimit["scopeType"];
  scopeValue: string;
  limitValue: number;
  tokensUsed: number;
  remaining: number;
  windowStart: string;
  nextResetAt: number;
}

export async function checkTokenLimits(
  apiKeyId: string,
  provider = "",
  model = "",
  now = Date.now()
): Promise<TokenLimitBreach | null> {
  if (!apiKeyId) return null;

  const limits = await getTokenLimitsForRequest(apiKeyId, provider, model);
  if (!limits || limits.length === 0) return null;

  let worst: TokenLimitBreach | null = null;

  for (const limit of limits) {
    if (limit.enabled === false) continue;
    const limitValue = limit.tokenLimit;
    if (!Number.isFinite(limitValue) || limitValue <= 0) continue;

    const tokensUsed = await getCurrentWindowUsage(limit, now, true);
    if (tokensUsed < limitValue) continue;

    const { windowStart, nextResetAt } = resetWindowIfElapsed(limit, now);
    const remaining = Math.max(0, limitValue - tokensUsed);
    const breach: TokenLimitBreach = {
      limitId: limit.id,
      scopeType: limit.scopeType,
      scopeValue: limit.scopeValue,
      limitValue,
      tokensUsed,
      remaining,
      windowStart,
      nextResetAt,
    };

    if (
      worst === null ||
      breach.remaining < worst.remaining ||
      (breach.remaining === worst.remaining && breach.limitValue < worst.limitValue)
    ) {
      worst = breach;
    }
  }

  return worst;
}

export function recordTokenUsage(
  apiKeyId: string,
  provider: string,
  model: string,
  tokens: number
): void {
  if (!apiKeyId) return;
  const delta = Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : 0;
  if (delta <= 0) return;

  Promise.resolve()
    .then(async () => {
      const now = Date.now();
      const limits = await getTokenLimitsForRequest(apiKeyId, provider || "", model || "");
      if (!limits || limits.length === 0) return;

      const db = getDbInstance();
      const applied: Array<{ limitId: string; windowStart: string; total: number }> = [];

      await withTransaction(async (client) => {
        for (const limit of limits) {
          if (limit.enabled === false) continue;

          const { windowStart } = resetWindowIfElapsed(limit, now);

          const currentRes = await client.query<{ tokens_used?: number }>(
            "SELECT tokens_used FROM api_key_token_counters WHERE limit_id = $1 AND window_start = $2",
            [limit.id, windowStart]
          );
          const currentRow = currentRes.rows[0];

          if (!currentRow) {
            const priorRes = await client.query<{ window_start?: string; tokens_used?: number }>(
              `SELECT window_start, tokens_used FROM api_key_token_counters
               WHERE limit_id = $1 AND window_start < $2
               ORDER BY window_start DESC LIMIT 1`,
              [limit.id, windowStart]
            );
            const priorRow = priorRes.rows[0];
            const prevTokens =
              priorRow && typeof priorRow.tokens_used === "number" ? priorRow.tokens_used : 0;
            if (prevTokens > 0) {
              await logTokenLimitReset(limit.id, prevTokens, windowStart);
            }

            const seeded = await seedWindowUsageFromHistory(limit, now);
            if (seeded > 0) {
              await incrementWindowTokens(limit.id, windowStart, seeded);
            }
          }

          const total = await incrementWindowTokens(limit.id, windowStart, delta);
          applied.push({ limitId: limit.id, windowStart, total });
        }
      });

      for (const a of applied) {
        syncCache(a.limitId, a.windowStart, a.total);
      }
    })
    .catch(() => {});
}

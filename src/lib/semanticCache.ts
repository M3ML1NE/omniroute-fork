/**
 * Semantic Cache — Phase 9.1
 *
 * Caches LLM responses (temperature=0) to reduce cost and latency.
 * Supports both streaming and non-streaming requests: streaming responses
 * are cached after assembly; cache hits always return JSON.
 * Two-tier: in-memory LRU (fast) + Postgres (persistent across restarts).
 *
 * Cache key = SHA-256(model + normalized messages + temperature + top_p)
 * Bypass: X-OmniRoute-No-Cache: true
 *
 * @module lib/semanticCache
 */

import crypto from "crypto";
import { LRUCache } from "./cacheLayer";
import { getDbInstance } from "./db/core";

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

async function ensureCacheMetricsTable() {
  try {
    const db = getDbInstance();
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS cache_metrics (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`
      )
      .run();
    await db
      .prepare(
        `INSERT INTO cache_metrics (key, value) VALUES ('hits', 0), ('misses', 0), ('tokens_saved', 0)
         ON CONFLICT (key) DO NOTHING`
      )
      .run();
  } catch {
    // DB not available
  }
}

async function incrementMetric(metric: "hits" | "misses" | "tokens_saved", amount = 1) {
  try {
    const db = getDbInstance();
    await db
      .prepare(`UPDATE cache_metrics SET value = value + ?, updated_at = NOW() WHERE key = ?`)
      .run(amount, metric);
  } catch {
    // DB not available — fall back to in-memory
  }
}

async function getMetricValue(metric: string): Promise<number> {
  try {
    const db = getDbInstance();
    const row = await db.prepare(`SELECT value FROM cache_metrics WHERE key = ?`).get(metric);
    return row ? toNumber(asRecord(row).value, 0) : 0;
  } catch {
    return 0;
  }
}

function getHeaderValue(
  headers: { get?: (name: string) => string | null } | Record<string, unknown> | null | undefined,
  name: string
): string | null {
  if (!headers) return null;

  if (typeof headers.get === "function") {
    return headers.get(name);
  }

  const needle = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== needle) continue;
    return typeof value === "string" ? value : null;
  }

  return null;
}

// ─── Singleton ─────────────────

let memoryCache: LRUCache | null = null;

function getMemoryCache() {
  if (!memoryCache) {
    memoryCache = new LRUCache({
      maxSize: parseInt(process.env.SEMANTIC_CACHE_MAX_SIZE || "50", 10),
      maxBytes: parseInt(process.env.SEMANTIC_CACHE_MAX_BYTES || String(2 * 1024 * 1024), 10),
      defaultTTL: parseInt(process.env.SEMANTIC_CACHE_TTL_MS || "1800000", 10),
    });
    void ensureCacheMetricsTable();
  }
  return memoryCache;
}

// ─── Signature Generation ─────────────────

/**
 * Generate deterministic cache signature from request params.
 * @param {string} model
 * @param {Array} messages - Normalized messages array
 * @param {number} temperature
 * @param {number} topP
 * @returns {string} hex signature
 */
export function generateSignature(model, conversation, temperature = 0, topP = 1) {
  const payload = JSON.stringify({
    model,
    messages: normalizeConversation(conversation),
    temperature,
    top_p: topP,
  });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function stringifyForSignature(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Normalize conversation items for consistent hashing.
 * Supports both Chat Completions `messages[]` and Responses API `input[]`.
 */
function normalizeConversation(conversation: unknown) {
  if (typeof conversation === "string") {
    return [{ role: "user", content: conversation }];
  }
  if (!Array.isArray(conversation)) return [];

  return conversation.map((item: Record<string, unknown>) => ({
    role: typeof item?.role === "string" && item.role.trim().length > 0 ? item.role : "user",
    content: stringifyForSignature(item?.content),
  }));
}

// ─── Cache Operations ─────────────────

/**
 * Check if a cached response exists for the given signature.
 * Checks memory first, then Postgres.
 * @param {string} signature
 * @returns {object|null} Cached response or null
 */
export async function getCachedResponse(signature): Promise<unknown> {
  // 1. Check memory cache
  const memResult = getMemoryCache().get(signature);
  if (memResult) {
    void incrementMetric("hits");
    void incrementMetric("tokens_saved", memResult.tokensSaved || 0);
    return memResult.response;
  }

  // 2. Check Postgres
  try {
    const db = getDbInstance();
    const row = await db
      .prepare(
        "SELECT response, tokens_saved FROM semantic_cache WHERE signature = ? AND expires_at > NOW()"
      )
      .get(signature);

    if (row) {
      const record = asRecord(row);
      const responsePayload = typeof record.response === "string" ? record.response : null;
      if (!responsePayload) {
        void incrementMetric("misses");
        return null;
      }
      const parsed = JSON.parse(responsePayload);
      const tokensSaved = toNumber(record.tokens_saved, 0);
      // Promote to memory cache
      getMemoryCache().set(signature, {
        response: parsed,
        tokensSaved,
      });
      // Update hit count in DB
      await db
        .prepare("UPDATE semantic_cache SET hit_count = hit_count + 1 WHERE signature = ?")
        .run(signature);

      void incrementMetric("hits");
      void incrementMetric("tokens_saved", tokensSaved);
      return parsed;
    }
  } catch {
    // DB not available — fail open
  }

  void incrementMetric("misses");
  return null;
}

/**
 * Store a response in cache.
 * @param {string} signature
 * @param {string} model
 * @param {object} response - The API response to cache
 * @param {number} tokensSaved - Estimated tokens saved
 * @param {number} [ttlMs] - TTL in ms (default: 1 hour)
 */
export async function setCachedResponse(
  signature,
  model,
  response,
  tokensSaved = 0,
  ttlMs = 3600000
): Promise<void> {
  const ttl = parseInt(process.env.SEMANTIC_CACHE_TTL_MS || String(ttlMs), 10);

  // 1. Memory cache
  getMemoryCache().set(signature, { response, tokensSaved }, ttl);

  // 2. Postgres
  try {
    const db = getDbInstance();
    const id = crypto.randomUUID();
    const promptHash = signature.slice(0, 16);
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + ttl).toISOString();

    await db
      .prepare(
        `INSERT INTO semantic_cache (id, signature, model, prompt_hash, response, tokens_saved, hit_count, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT (signature) DO UPDATE SET
           model = EXCLUDED.model,
           prompt_hash = EXCLUDED.prompt_hash,
           response = EXCLUDED.response,
           tokens_saved = EXCLUDED.tokens_saved,
           hit_count = 0,
           created_at = EXCLUDED.created_at,
           expires_at = EXCLUDED.expires_at`
      )
      .run(id, signature, model, promptHash, JSON.stringify(response), tokensSaved, now, expiresAt);
  } catch {
    // DB write failed — cache still in memory
  }
}

// ─── Maintenance ─────────────────

/**
 * Remove expired entries from Postgres.
 * @returns {number} Number of entries removed
 */
export async function cleanExpiredEntries(): Promise<number> {
  try {
    const db = getDbInstance();
    const result = await db
      .prepare("DELETE FROM semantic_cache WHERE expires_at <= NOW()")
      .run();
    return result.changes;
  } catch {
    return 0;
  }
}

/**
 * Invalidate cache entries by model name.
 * Useful when a model is updated/changed and cached responses are stale.
 * @param {string} model - Model name to invalidate (exact match)
 * @returns {number} Number of entries removed
 */
export async function invalidateByModel(model: string): Promise<number> {
  getMemoryCache().clear(); // Memory cache doesn't track model; full clear
  try {
    const db = getDbInstance();
    const result = await db
      .prepare("DELETE FROM semantic_cache WHERE model = ?")
      .run(model);
    return result.changes || 0;
  } catch {
    return 0;
  }
}

/**
 * Invalidate a single cache entry by its signature.
 * @param {string} signature - Cache signature to invalidate
 * @returns {boolean} Whether the entry was found and removed
 */
export async function invalidateBySignature(signature: string): Promise<boolean> {
  getMemoryCache().delete(signature);
  try {
    const db = getDbInstance();
    const result = await db
      .prepare("DELETE FROM semantic_cache WHERE signature = ?")
      .run(signature);
    return (result.changes || 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Invalidate entries older than a given age.
 * @param {number} maxAgeMs - Maximum age in milliseconds
 * @returns {number} Number of entries removed
 */
export async function invalidateStale(maxAgeMs: number): Promise<number> {
  getMemoryCache().clear();
  try {
    const db = getDbInstance();
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const result = await db
      .prepare("DELETE FROM semantic_cache WHERE created_at < ?")
      .run(cutoff);
    return result.changes || 0;
  } catch {
    return 0;
  }
}

// ── Auto-cleanup timer ──

let _cleanupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start periodic auto-cleanup of expired entries.
 * @param {number} intervalMs - Cleanup interval (default: 5 minutes)
 */
export function startAutoCleanup(intervalMs = 300_000): void {
  stopAutoCleanup();
  _cleanupTimer = setInterval(() => {
    void cleanExpiredEntries().then((removed) => {
      if (removed > 0) {
        console.log(`[SemanticCache] Auto-cleaned ${removed} expired entries`);
      }
    });
  }, intervalMs);
  if (_cleanupTimer && typeof _cleanupTimer === "object" && "unref" in _cleanupTimer) {
    (_cleanupTimer as { unref?: () => void }).unref?.();
  }
}

/**
 * Stop periodic auto-cleanup.
 */
export function stopAutoCleanup(): void {
  if (_cleanupTimer) {
    clearInterval(_cleanupTimer);
    _cleanupTimer = null;
  }
}

export async function cleanOldMetrics(retentionDays = 90): Promise<number> {
  try {
    const db = getDbInstance();
    const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
    const result = await db
      .prepare("DELETE FROM semantic_cache WHERE created_at < ?")
      .run(cutoff);
    return result.changes || 0;
  } catch {
    return 0;
  }
}

/**
 * Clear all cache entries.
 */
export async function clearCache(): Promise<number> {
  getMemoryCache().clear();
  let removed = 0;
  try {
    const db = getDbInstance();
    const result = await db.prepare("DELETE FROM semantic_cache").run();
    removed = result.changes || 0;
    await db.prepare("UPDATE cache_metrics SET value = 0").run();
  } catch {
    // DB not available
  }
  return removed;
}

export async function getCacheStats() {
  const memStats = getMemoryCache().getStats();
  let dbSize = 0;
  try {
    const db = getDbInstance();
    const row = await db
      .prepare("SELECT COUNT(*) as count FROM semantic_cache WHERE expires_at > NOW()")
      .get();
    dbSize = toNumber(asRecord(row).count, 0);
  } catch {
    // DB not available
  }

  const hits = await getMetricValue("hits");
  const misses = await getMetricValue("misses");
  const tokensSaved = await getMetricValue("tokens_saved");
  const total = hits + misses;

  return {
    memoryEntries: memStats.size,
    dbEntries: dbSize,
    hits,
    misses,
    hitRate: total > 0 ? ((hits / total) * 100).toFixed(1) : "0.0",
    tokensSaved,
  };
}

/**
 * Check if a cached response can be served for this request.
 * Works for both streaming and non-streaming requests (cache hit returns JSON).
 * Requires explicit numeric `temperature: 0` — omitted temperature is NOT cached
 * because the provider default may be non-deterministic (e.g. random/creative tasks).
 */
export function isCacheableForRead(body, headers) {
  if ((getHeaderValue(headers, "x-omniroute-no-cache") || "").toLowerCase() === "true") {
    return false;
  }
  if (typeof body.temperature !== "number" || body.temperature !== 0) return false;
  return true;
}

/**
 * Check if a response should be stored in cache after completion.
 * Works for both streaming and non-streaming responses.
 * Requires explicit `temperature: 0` — omitted temperature is NOT cacheable
 * because the provider default may be non-deterministic.
 */
export function isCacheableForWrite(body, headers) {
  if ((getHeaderValue(headers, "x-omniroute-no-cache") || "").toLowerCase() === "true") {
    return false;
  }
  if (body.temperature !== 0) return false;
  return true;
}

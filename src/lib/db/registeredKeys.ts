/**
 * db/registeredKeys.ts — Registered Keys Provisioning (#464)
 *
 * Handles:
 *   - Issuing registered keys with idempotency
 *   - Per-provider and per-account quota enforcement
 *   - Key revocation
 *   - Quota status queries for rate-limiting decisions
 */

import { createHash, randomBytes } from "crypto";
import { v4 as uuidv4 } from "uuid";
import { getDbInstance, rowToCamel } from "./core";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RegisteredKey {
  id: string;
  keyPrefix: string;
  name: string;
  provider: string;
  accountId: string;
  isActive: boolean;
  revokedAt: string | null;
  expiresAt: string | null;
  idempotencyKey: string | null;
  dailyBudget: number | null;
  hourlyBudget: number | null;
  dailyUsed: number;
  hourlyUsed: number;
  createdAt: string;
  updatedAt: string;
}

export interface RegisteredKeyWithSecret extends RegisteredKey {
  /** Raw key material — only returned once on creation */
  rawKey: string;
}

export interface ProviderKeyLimit {
  provider: string;
  maxActiveKeys: number | null;
  dailyIssueLimit: number | null;
  hourlyIssueLimit: number | null;
  dailyIssued: number;
  hourlyIssued: number;
  updatedAt: string;
}

export interface AccountKeyLimit {
  accountId: string;
  maxActiveKeys: number | null;
  dailyIssueLimit: number | null;
  hourlyIssueLimit: number | null;
  dailyIssued: number;
  hourlyIssued: number;
  updatedAt: string;
}

export interface QuotaCheckResult {
  allowed: boolean;
  errorCode?: string;
  errorMessage?: string;
  provider?: string;
  accountId?: string;
  providerActiveKeys?: number;
  accountActiveKeys?: number;
}

export interface IssueKeyParams {
  name: string;
  provider?: string;
  accountId?: string;
  idempotencyKey?: string;
  expiresAt?: string;
  dailyBudget?: number;
  hourlyBudget?: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function nowDay(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function nowHour(): string {
  return new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
}

function hashKey(raw: string): string {
  if (!raw || typeof raw !== "string") return "";
  return createHash("sha256").update(raw).digest("hex");
}

function generateRawKey(): string {
  // ork_ prefix so users can easily identify these keys
  return "ork_" + randomBytes(24).toString("base64url");
}

/** Reset window counters if the tracking period has changed. */
async function maybeResetWindow(
  db: ReturnType<typeof getDbInstance>,
  table: string,
  idField: string,
  idValue: string
): Promise<void> {
  const today = nowDay();
  const hour = nowHour();

  await db
    .prepare(
      `UPDATE ${table}
       SET daily_issued = CASE WHEN last_reset_day <> ? THEN 0 ELSE daily_issued END,
           hourly_issued = CASE WHEN last_reset_hour <> ? THEN 0 ELSE hourly_issued END,
           last_reset_day = ?,
           last_reset_hour = ?
       WHERE ${idField} = ?`
    )
    .run(today, hour, today, hour, idValue);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Check if a new registered key can be issued for the given provider/account.
 * Returns { allowed: true } or { allowed: false, errorCode, errorMessage }.
 */
export async function checkQuota(provider = "", accountId = ""): Promise<QuotaCheckResult> {
  const db = getDbInstance();

  // ── provider-level check ──
  if (provider) {
    await maybeResetWindow(db, "provider_key_limits", "provider", provider);

    const limits = await db
      .prepare("SELECT * FROM provider_key_limits WHERE provider = ?")
      .get<ProviderKeyLimitRow>(provider);

    if (limits) {
      if (limits.hourly_issue_limit !== null && limits.hourly_issued >= limits.hourly_issue_limit) {
        return {
          allowed: false,
          errorCode: "PROVIDER_QUOTA_EXCEEDED",
          errorMessage: `Hourly issue limit (${limits.hourly_issue_limit}) reached for provider '${provider}'`,
          provider,
        };
      }
      if (limits.daily_issue_limit !== null && limits.daily_issued >= limits.daily_issue_limit) {
        return {
          allowed: false,
          errorCode: "PROVIDER_QUOTA_EXCEEDED",
          errorMessage: `Daily issue limit (${limits.daily_issue_limit}) reached for provider '${provider}'`,
          provider,
        };
      }
      if (limits.max_active_keys !== null) {
        const countRow = await db
          .prepare(
            "SELECT COUNT(*) as active_count FROM registered_keys WHERE provider = ? AND is_active = 1"
          )
          .get<{ active_count: number | string }>(provider);
        const activeCount = Number(countRow?.active_count) || 0;
        if (activeCount >= limits.max_active_keys) {
          return {
            allowed: false,
            errorCode: "MAX_ACTIVE_KEYS_EXCEEDED",
            errorMessage: `Max active keys (${limits.max_active_keys}) reached for provider '${provider}'`,
            provider,
            providerActiveKeys: activeCount,
          };
        }
      }
    }
  }

  // ── account-level check ──
  if (accountId) {
    await maybeResetWindow(db, "account_key_limits", "account_id", accountId);

    const limits = await db
      .prepare("SELECT * FROM account_key_limits WHERE account_id = ?")
      .get<AccountKeyLimitRow>(accountId);

    if (limits) {
      if (limits.hourly_issue_limit !== null && limits.hourly_issued >= limits.hourly_issue_limit) {
        return {
          allowed: false,
          errorCode: "ACCOUNT_QUOTA_EXCEEDED",
          errorMessage: `Hourly issue limit (${limits.hourly_issue_limit}) reached for account '${accountId}'`,
          accountId,
        };
      }
      if (limits.daily_issue_limit !== null && limits.daily_issued >= limits.daily_issue_limit) {
        return {
          allowed: false,
          errorCode: "ACCOUNT_QUOTA_EXCEEDED",
          errorMessage: `Daily issue limit (${limits.daily_issue_limit}) reached for account '${accountId}'`,
          accountId,
        };
      }
      if (limits.max_active_keys !== null) {
        const countRow = await db
          .prepare(
            "SELECT COUNT(*) as active_count FROM registered_keys WHERE account_id = ? AND is_active = 1"
          )
          .get<{ active_count: number | string }>(accountId);
        const activeCount = Number(countRow?.active_count) || 0;
        if (activeCount >= limits.max_active_keys) {
          return {
            allowed: false,
            errorCode: "MAX_ACTIVE_KEYS_EXCEEDED",
            errorMessage: `Max active keys (${limits.max_active_keys}) reached for account '${accountId}'`,
            accountId,
            accountActiveKeys: activeCount,
          };
        }
      }
    }
  }

  return { allowed: true };
}

/**
 * Issue a new registered key.
 * Returns the key with rawKey (only on creation) or an idempotency conflict object.
 */
export async function issueRegisteredKey(
  params: IssueKeyParams
): Promise<RegisteredKeyWithSecret | { idempotencyConflict: true; existing: RegisteredKey }> {
  const db = getDbInstance();
  const {
    name,
    provider = "",
    accountId = "",
    idempotencyKey,
    expiresAt,
    dailyBudget,
    hourlyBudget,
  } = params;

  // ── idempotency check ──
  if (idempotencyKey) {
    const existing = await db
      .prepare("SELECT * FROM registered_keys WHERE idempotency_key = ?")
      .get<RegisteredKeyRow>(idempotencyKey);
    if (existing) {
      return {
        idempotencyConflict: true,
        existing: rowToCamel(existing) as unknown as RegisteredKey,
      };
    }
  }

  const rawKey = generateRawKey();
  const id = uuidv4();
  const keyHash = hashKey(rawKey);
  const keyPrefix = rawKey.slice(0, 12); // "ork_" + 8 chars

  await db
    .prepare(
      `INSERT INTO registered_keys
        (id, key, key_prefix, name, provider, account_id, idempotency_key, expires_at, daily_budget, hourly_budget, last_reset_day, last_reset_hour)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      keyHash,
      keyPrefix,
      name,
      provider,
      accountId,
      idempotencyKey ?? null,
      expiresAt ?? null,
      dailyBudget ?? null,
      hourlyBudget ?? null,
      nowDay(),
      nowHour()
    );

  // Increment provider/account issuance counters
  if (provider) {
    await maybeResetWindow(db, "provider_key_limits", "provider", provider);
    await db
      .prepare(
        `INSERT INTO provider_key_limits (provider, daily_issued, hourly_issued, last_reset_day, last_reset_hour)
         VALUES (?, 1, 1, ?, ?)
         ON CONFLICT(provider) DO UPDATE SET
           daily_issued = provider_key_limits.daily_issued + 1,
           hourly_issued = provider_key_limits.hourly_issued + 1,
           updated_at = NOW()`
      )
      .run(provider, nowDay(), nowHour());
  }
  if (accountId) {
    await maybeResetWindow(db, "account_key_limits", "account_id", accountId);
    await db
      .prepare(
        `INSERT INTO account_key_limits (account_id, daily_issued, hourly_issued, last_reset_day, last_reset_hour)
         VALUES (?, 1, 1, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET
           daily_issued = account_key_limits.daily_issued + 1,
           hourly_issued = account_key_limits.hourly_issued + 1,
           updated_at = NOW()`
      )
      .run(accountId, nowDay(), nowHour());
  }

  const created = await db
    .prepare("SELECT * FROM registered_keys WHERE id = ?")
    .get<RegisteredKeyRow>(id);
  if (!created) throw new Error("Failed to retrieve newly created registered key");
  return { ...(rowToCamel(created) as unknown as RegisteredKey), rawKey };
}

/**
 * Get a registered key by ID (without the raw key — only prefix is returned).
 */
export async function getRegisteredKey(id: string): Promise<RegisteredKey | null> {
  const db = getDbInstance();
  const row = await db
    .prepare("SELECT * FROM registered_keys WHERE id = ?")
    .get<RegisteredKeyRow>(id);
  return row ? (rowToCamel(row) as unknown as RegisteredKey) : null;
}

/**
 * List all registered keys (optionally filtered by provider/accountId).
 */
export async function listRegisteredKeys(
  opts: { provider?: string; accountId?: string } = {}
): Promise<RegisteredKey[]> {
  const db = getDbInstance();
  let sql = "SELECT * FROM registered_keys WHERE 1=1";
  const args: string[] = [];
  if (opts.provider) {
    sql += " AND provider = ?";
    args.push(opts.provider);
  }
  if (opts.accountId) {
    sql += " AND account_id = ?";
    args.push(opts.accountId);
  }
  sql += " ORDER BY created_at DESC LIMIT 500";
  const rows = await db.prepare(sql).all<RegisteredKeyRow>(...args);
  return rows.map((r) => rowToCamel(r) as unknown as RegisteredKey);
}

/**
 * Revoke a registered key by ID.
 */
export async function revokeRegisteredKey(id: string): Promise<boolean> {
  const db = getDbInstance();
  const result = await db
    .prepare(
      `UPDATE registered_keys
       SET is_active = 0, revoked_at = NOW(), updated_at = NOW()
       WHERE id = ? AND is_active = 1`
    )
    .run(id);
  return result.changes > 0;
}

/**
 * Validate a raw registered key against stored hashes.
 * Returns the key metadata if valid, null otherwise.
 */
export async function validateRegisteredKey(rawKey: string): Promise<RegisteredKey | null> {
  const db = getDbInstance();
  const hash = hashKey(rawKey);
  const row = await db
    .prepare(
      `SELECT * FROM registered_keys
       WHERE key = ? AND is_active = 1
         AND (expires_at IS NULL OR expires_at::timestamptz > NOW())`
    )
    .get<RegisteredKeyRow>(hash);
  if (!row) return null;

  // Auto-reset budget windows if needed
  const today = nowDay();
  const hour = nowHour();
  if (row.last_reset_day !== today || row.last_reset_hour !== hour) {
    await db
      .prepare(
        `UPDATE registered_keys
         SET daily_used = CASE WHEN last_reset_day <> ? THEN 0 ELSE daily_used END,
             hourly_used = CASE WHEN last_reset_hour <> ? THEN 0 ELSE hourly_used END,
             last_reset_day = ?, last_reset_hour = ?
         WHERE id = ?`
      )
      .run(today, hour, today, hour, row.id);
  }

  // Budget check
  if (row.daily_budget !== null && row.daily_used >= row.daily_budget) return null;
  if (row.hourly_budget !== null && row.hourly_used >= row.hourly_budget) return null;

  return rowToCamel(row) as unknown as RegisteredKey;
}

/**
 * Increment usage counters for a registered key (called by request pipeline).
 */
export async function incrementRegisteredKeyUsage(id: string): Promise<void> {
  const db = getDbInstance();
  await db
    .prepare(
      `UPDATE registered_keys
       SET daily_used = daily_used + 1, hourly_used = hourly_used + 1, updated_at = NOW()
       WHERE id = ?`
    )
    .run(id);
}

// ─── Provider / Account Limit Management ──────────────────────────────────────

export async function setProviderKeyLimit(
  provider: string,
  limits: Partial<Omit<ProviderKeyLimit, "provider" | "dailyIssued" | "hourlyIssued" | "updatedAt">>
): Promise<void> {
  const db = getDbInstance();
  await db
    .prepare(
      `INSERT INTO provider_key_limits (provider, max_active_keys, daily_issue_limit, hourly_issue_limit, last_reset_day, last_reset_hour)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET
         max_active_keys = excluded.max_active_keys,
         daily_issue_limit = excluded.daily_issue_limit,
         hourly_issue_limit = excluded.hourly_issue_limit,
         updated_at = NOW()`
    )
    .run(
      provider,
      limits.maxActiveKeys ?? null,
      limits.dailyIssueLimit ?? null,
      limits.hourlyIssueLimit ?? null,
      nowDay(),
      nowHour()
    );
}

export async function setAccountKeyLimit(
  accountId: string,
  limits: Partial<Omit<AccountKeyLimit, "accountId" | "dailyIssued" | "hourlyIssued" | "updatedAt">>
): Promise<void> {
  const db = getDbInstance();
  await db
    .prepare(
      `INSERT INTO account_key_limits (account_id, max_active_keys, daily_issue_limit, hourly_issue_limit, last_reset_day, last_reset_hour)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET
         max_active_keys = excluded.max_active_keys,
         daily_issue_limit = excluded.daily_issue_limit,
         hourly_issue_limit = excluded.hourly_issue_limit,
         updated_at = NOW()`
    )
    .run(
      accountId,
      limits.maxActiveKeys ?? null,
      limits.dailyIssueLimit ?? null,
      limits.hourlyIssueLimit ?? null,
      nowDay(),
      nowHour()
    );
}

export async function getProviderKeyLimit(provider: string): Promise<ProviderKeyLimit | null> {
  const db = getDbInstance();
  const row = await db
    .prepare("SELECT * FROM provider_key_limits WHERE provider = ?")
    .get<ProviderKeyLimitRow>(provider);
  return row ? (rowToCamel(row) as unknown as ProviderKeyLimit) : null;
}

export async function getAccountKeyLimit(accountId: string): Promise<AccountKeyLimit | null> {
  const db = getDbInstance();
  const row = await db
    .prepare("SELECT * FROM account_key_limits WHERE account_id = ?")
    .get<AccountKeyLimitRow>(accountId);
  return row ? (rowToCamel(row) as unknown as AccountKeyLimit) : null;
}

// ─── Internal types (raw DB rows) ─────────────────────────────────────────────

interface RegisteredKeyRow {
  id: string;
  key: string;
  key_prefix: string;
  name: string;
  provider: string;
  account_id: string;
  is_active: number;
  revoked_at: string | null;
  expires_at: string | null;
  idempotency_key: string | null;
  daily_budget: number | null;
  hourly_budget: number | null;
  daily_used: number;
  hourly_used: number;
  last_reset_day: string;
  last_reset_hour: string;
  created_at: string;
  updated_at: string;
}

interface ProviderKeyLimitRow {
  provider: string;
  max_active_keys: number | null;
  daily_issue_limit: number | null;
  hourly_issue_limit: number | null;
  daily_issued: number;
  hourly_issued: number;
  last_reset_day: string;
  last_reset_hour: string;
  updated_at: string;
}

interface AccountKeyLimitRow {
  account_id: string;
  max_active_keys: number | null;
  daily_issue_limit: number | null;
  hourly_issue_limit: number | null;
  daily_issued: number;
  hourly_issued: number;
  last_reset_day: string;
  last_reset_hour: string;
  updated_at: string;
}

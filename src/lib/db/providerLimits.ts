import { getDbInstance, isBuildPhase, isCloud } from "./core";
import { withTransaction } from "./postgres";

type JsonRecord = Record<string, unknown>;

interface KeyValueRow {
  key: string;
  value: string;
}

export interface ProviderLimitsCacheEntry {
  quotas: JsonRecord | null;
  plan: unknown;
  message: string | null;
  fetchedAt: string;
  source?: string | null;
}

const PROVIDER_LIMITS_CACHE_NAMESPACE = "providerLimitsCache";

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function toRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function normalizeCacheEntry(value: unknown): ProviderLimitsCacheEntry | null {
  const record = toRecord(value);
  if (!record) return null;

  const fetchedAt =
    typeof record.fetchedAt === "string" && record.fetchedAt.trim() ? record.fetchedAt : null;
  if (!fetchedAt) return null;

  return {
    quotas: toRecord(record.quotas),
    plan: record.plan ?? null,
    message: typeof record.message === "string" ? record.message : null,
    fetchedAt,
    source: typeof record.source === "string" ? record.source : null,
  };
}

export async function getProviderLimitsCache(
  connectionId: string
): Promise<ProviderLimitsCacheEntry | null> {
  if (isBuildPhase || isCloud) return null;
  const db = getDbInstance();
  const row = await db
    .prepare("SELECT value FROM key_value WHERE namespace = $1 AND key = $2")
    .get<KeyValueRow>(PROVIDER_LIMITS_CACHE_NAMESPACE, connectionId);
  if (!row?.value) return null;
  return normalizeCacheEntry(parseJson(row.value));
}

export async function getAllProviderLimitsCache(): Promise<Record<string, ProviderLimitsCacheEntry>> {
  if (isBuildPhase || isCloud) return {};
  const db = getDbInstance();
  const rows = await db
    .prepare("SELECT key, value FROM key_value WHERE namespace = $1")
    .all<KeyValueRow>(PROVIDER_LIMITS_CACHE_NAMESPACE);

  const result: Record<string, ProviderLimitsCacheEntry> = {};
  for (const row of rows) {
    const parsed = normalizeCacheEntry(parseJson(row.value));
    if (parsed) {
      result[row.key] = parsed;
    }
  }
  return result;
}

export async function setProviderLimitsCache(
  connectionId: string,
  entry: ProviderLimitsCacheEntry
): Promise<ProviderLimitsCacheEntry> {
  if (isBuildPhase || isCloud) return entry;
  const db = getDbInstance();
  await db
    .prepare(
      "INSERT INTO key_value (namespace, key, value) VALUES ($1, $2, $3) ON CONFLICT (namespace, key) DO UPDATE SET value = EXCLUDED.value"
    )
    .run(PROVIDER_LIMITS_CACHE_NAMESPACE, connectionId, JSON.stringify(entry));
  return entry;
}

export async function setProviderLimitsCacheBatch(
  entries: Array<{ connectionId: string; entry: ProviderLimitsCacheEntry }>
): Promise<number> {
  if (isBuildPhase || isCloud || entries.length === 0) return 0;
  await withTransaction(async (client) => {
    for (const item of entries) {
      await client.query(
        "INSERT INTO key_value (namespace, key, value) VALUES ($1, $2, $3) ON CONFLICT (namespace, key) DO UPDATE SET value = EXCLUDED.value",
        [PROVIDER_LIMITS_CACHE_NAMESPACE, item.connectionId, JSON.stringify(item.entry)]
      );
    }
  });
  return entries.length;
}

export async function deleteProviderLimitsCache(connectionId: string): Promise<void> {
  if (isBuildPhase || isCloud) return;
  const db = getDbInstance();
  await db
    .prepare("DELETE FROM key_value WHERE namespace = $1 AND key = $2")
    .run(PROVIDER_LIMITS_CACHE_NAMESPACE, connectionId);
}

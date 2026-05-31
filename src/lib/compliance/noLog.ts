import { getDbInstance } from "../db/core";

// #2650: extracted from compliance/index.ts to break the
// callLogs.ts → compliance/index.ts → callLogs.ts cycle that deadlocks
// the bundled MCP server under Node.js 24's stricter ESM evaluation.

function getDb() {
  try {
    return getDbInstance();
  } catch {
    return null;
  }
}

const noLogKeys = new Set<string>();
const noLogDbCache = new Map<string, { value: boolean; timestamp: number }>();
let noLogColumnVerified = false;
let hasNoLogColumn = false;
const NO_LOG_CACHE_TTL_MS = 30_000;

const noLogIdsFromEnv = (process.env.NO_LOG_API_KEY_IDS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
for (const id of noLogIdsFromEnv) {
  noLogKeys.add(id);
}

export function setNoLog(apiKeyId: string, noLog: boolean): void {
  if (noLog) {
    noLogKeys.add(apiKeyId);
  } else {
    noLogKeys.delete(apiKeyId);
  }
  noLogDbCache.set(apiKeyId, { value: noLog, timestamp: Date.now() });
}

async function ensureNoLogColumn(db: ReturnType<typeof getDbInstance>): Promise<boolean> {
  if (noLogColumnVerified) {
    return hasNoLogColumn;
  }

  try {
    const columns = (await db
      .prepare(
        "SELECT column_name AS name FROM information_schema.columns WHERE table_name = 'api_keys' AND table_schema = 'public'"
      )
      .all()) as Array<{ name: string }>;
    hasNoLogColumn = columns.some((column) => column.name === "no_log");
  } catch {
    hasNoLogColumn = false;
  }

  noLogColumnVerified = true;
  return hasNoLogColumn;
}

async function readNoLogFromDb(apiKeyId: string): Promise<boolean> {
  const db = getDb();
  if (!db || !apiKeyId) return false;
  if (!(await ensureNoLogColumn(db))) return false;

  const cached = noLogDbCache.get(apiKeyId);
  if (cached && Date.now() - cached.timestamp < NO_LOG_CACHE_TTL_MS) {
    return cached.value;
  }

  try {
    const row = (await db
      .prepare("SELECT no_log FROM api_keys WHERE id = $1")
      .get(apiKeyId)) as { no_log?: number } | undefined;
    const value = Boolean(row && Number(row.no_log) === 1);
    noLogDbCache.set(apiKeyId, { value, timestamp: Date.now() });
    return value;
  } catch {
    return false;
  }
}

export async function isNoLog(apiKeyId: string): Promise<boolean> {
  if (!apiKeyId) return false;
  if (noLogKeys.has(apiKeyId)) return true;

  const persistedNoLog = await readNoLogFromDb(apiKeyId);
  if (persistedNoLog) {
    noLogKeys.add(apiKeyId);
  }
  return persistedNoLog;
}

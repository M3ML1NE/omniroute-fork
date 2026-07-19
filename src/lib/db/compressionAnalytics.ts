import { getDbInstance, getDriverInfo } from "./core";
import { nonCriticalDbDisabled } from "./minimalDb";

export interface CompressionAnalyticsRow {
  id?: number;
  timestamp: string;
  combo_id?: string | null;
  compression_combo_id?: string | null;
  engine?: string | null;
  provider?: string | null;
  mode: string;
  original_tokens: number;
  compressed_tokens: number;
  tokens_saved: number;
  duration_ms?: number | null;
  request_id?: string | null;
  actual_prompt_tokens?: number | null;
  actual_completion_tokens?: number | null;
  actual_total_tokens?: number | null;
  actual_cache_read_tokens?: number | null;
  actual_cache_write_tokens?: number | null;
  estimated_usd_saved?: number | null;
  mcp_description_tokens_saved?: number | null;
  multimodal_skip_count?: number | null;
  receipt_source?: string | null;
  validation_fallback?: boolean | number | null;
  output_mode?: string | null;
  rtk_raw_output_pointer?: string | null;
  rtk_raw_output_bytes?: number | null;
  rtk_raw_output_pointers?: string | null;
  rtk_raw_output_total_bytes?: number | null;
}

export interface CompressionAnalyticsSummary {
  totalRequests: number;
  totalTokensSaved: number;
  avgSavingsPct: number;
  avgDurationMs: number;
  byMode: Record<string, { count: number; tokensSaved: number; avgSavingsPct: number }>;
  byEngine: Record<string, { count: number; tokensSaved: number; avgSavingsPct: number }>;
  byCompressionCombo: Record<string, { count: number; tokensSaved: number }>;
  byProvider: Record<string, { count: number; tokensSaved: number }>;
  last24h: Array<{ hour: string; count: number; tokensSaved: number }>;
  validationFallbacks: number;
  realUsage: {
    requestsWithReceipts: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    estimatedUsdSaved: number;
    bySource: Record<string, number>;
  };
  mcpDescriptionCompression: {
    snapshots: number;
    estimatedTokensSaved: number;
  };
}

let columnsEnsuredForDb: unknown = null;

async function ensureCompressionAnalyticsColumns(): Promise<void> {
  const db = getDbInstance();
  if (columnsEnsuredForDb === db) return;
  const driverInfo = getDriverInfo();
  if (driverInfo?.kind === "postgres") {
    columnsEnsuredForDb = db;
    return;
  }
  const rows = (await db.prepare("PRAGMA table_info(compression_analytics)").all()) as Array<{
    name: string;
  }>;
  const columns = new Set(rows.map((row) => row.name));
  const addColumn = async (name: string, sql: string) => {
    if (!columns.has(name)) await db.exec(sql);
  };
  await addColumn(
    "actual_prompt_tokens",
    "ALTER TABLE compression_analytics ADD COLUMN actual_prompt_tokens INTEGER"
  );
  await addColumn(
    "actual_completion_tokens",
    "ALTER TABLE compression_analytics ADD COLUMN actual_completion_tokens INTEGER"
  );
  await addColumn(
    "actual_total_tokens",
    "ALTER TABLE compression_analytics ADD COLUMN actual_total_tokens INTEGER"
  );
  await addColumn(
    "actual_cache_read_tokens",
    "ALTER TABLE compression_analytics ADD COLUMN actual_cache_read_tokens INTEGER"
  );
  await addColumn(
    "actual_cache_write_tokens",
    "ALTER TABLE compression_analytics ADD COLUMN actual_cache_write_tokens INTEGER"
  );
  await addColumn(
    "estimated_usd_saved",
    "ALTER TABLE compression_analytics ADD COLUMN estimated_usd_saved REAL"
  );
  await addColumn(
    "mcp_description_tokens_saved",
    "ALTER TABLE compression_analytics ADD COLUMN mcp_description_tokens_saved INTEGER DEFAULT 0"
  );
  await addColumn(
    "multimodal_skip_count",
    "ALTER TABLE compression_analytics ADD COLUMN multimodal_skip_count INTEGER DEFAULT 0"
  );
  await addColumn(
    "receipt_source",
    "ALTER TABLE compression_analytics ADD COLUMN receipt_source TEXT"
  );
  await addColumn(
    "validation_fallback",
    "ALTER TABLE compression_analytics ADD COLUMN validation_fallback INTEGER DEFAULT 0"
  );
  await addColumn("output_mode", "ALTER TABLE compression_analytics ADD COLUMN output_mode TEXT");
  await addColumn(
    "compression_combo_id",
    "ALTER TABLE compression_analytics ADD COLUMN compression_combo_id TEXT"
  );
  await addColumn("engine", "ALTER TABLE compression_analytics ADD COLUMN engine TEXT");
  await addColumn(
    "rtk_raw_output_pointer",
    "ALTER TABLE compression_analytics ADD COLUMN rtk_raw_output_pointer TEXT"
  );
  await addColumn(
    "rtk_raw_output_bytes",
    "ALTER TABLE compression_analytics ADD COLUMN rtk_raw_output_bytes INTEGER"
  );
  await addColumn(
    "rtk_raw_output_pointers",
    "ALTER TABLE compression_analytics ADD COLUMN rtk_raw_output_pointers TEXT"
  );
  await addColumn(
    "rtk_raw_output_total_bytes",
    "ALTER TABLE compression_analytics ADD COLUMN rtk_raw_output_total_bytes INTEGER"
  );
  columnsEnsuredForDb = db;
}

export async function insertCompressionAnalyticsRow(row: CompressionAnalyticsRow): Promise<void> {
  if (nonCriticalDbDisabled()) return;
  const db = getDbInstance();
  await ensureCompressionAnalyticsColumns();
  await db
    .prepare(
      `
    INSERT INTO compression_analytics (
      timestamp, combo_id, compression_combo_id, engine, provider, mode, original_tokens, compressed_tokens, tokens_saved,
      duration_ms, request_id, actual_prompt_tokens, actual_completion_tokens,
      actual_total_tokens, actual_cache_read_tokens, actual_cache_write_tokens,
      estimated_usd_saved, mcp_description_tokens_saved, multimodal_skip_count,
      receipt_source, validation_fallback, output_mode, rtk_raw_output_pointer, rtk_raw_output_bytes,
      rtk_raw_output_pointers, rtk_raw_output_total_bytes
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
    )
    .run(
      row.timestamp,
      row.combo_id ?? null,
      row.compression_combo_id ?? null,
      row.engine ?? row.mode,
      row.provider ?? null,
      row.mode,
      row.original_tokens,
      row.compressed_tokens,
      row.tokens_saved,
      row.duration_ms ?? null,
      row.request_id ?? null,
      row.actual_prompt_tokens ?? null,
      row.actual_completion_tokens ?? null,
      row.actual_total_tokens ?? null,
      row.actual_cache_read_tokens ?? null,
      row.actual_cache_write_tokens ?? null,
      row.estimated_usd_saved ?? null,
      row.mcp_description_tokens_saved ?? 0,
      row.multimodal_skip_count ?? 0,
      row.receipt_source ?? null,
      row.validation_fallback ? 1 : 0,
      row.output_mode ?? null,
      row.rtk_raw_output_pointer ?? null,
      row.rtk_raw_output_bytes ?? null,
      row.rtk_raw_output_pointers ?? null,
      row.rtk_raw_output_total_bytes ?? null
    );
}

export async function attachCompressionUsageReceipt(
  requestId: string | null | undefined,
  usage: Record<string, unknown> | null | undefined,
  source: "provider" | "estimated" | "stream" = "provider"
): Promise<void> {
  if (nonCriticalDbDisabled()) return;
  if (!requestId || !usage || typeof usage !== "object") return;
  const promptTokens = toFiniteInt(usage.prompt_tokens);
  const completionTokens = toFiniteInt(usage.completion_tokens);
  const totalTokens =
    toFiniteInt(usage.total_tokens) ?? (promptTokens ?? 0) + (completionTokens ?? 0);
  const promptDetails =
    usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object"
      ? (usage.prompt_tokens_details as Record<string, unknown>)
      : {};
  const cacheReadTokens = toFiniteInt(
    usage.cache_read_input_tokens ?? usage.cached_tokens ?? promptDetails.cached_tokens
  );
  const cacheWriteTokens = toFiniteInt(
    usage.cache_creation_input_tokens ?? promptDetails.cache_creation_tokens
  );
  if (promptTokens === null && completionTokens === null && totalTokens <= 0) return;

  const db = getDbInstance();
  await ensureCompressionAnalyticsColumns();
  await db
    .prepare(
      `
    UPDATE compression_analytics
    SET actual_prompt_tokens = ?,
        actual_completion_tokens = ?,
        actual_total_tokens = ?,
        actual_cache_read_tokens = ?,
        actual_cache_write_tokens = ?,
        receipt_source = ?
    WHERE request_id = ?
      AND id = (
        SELECT id FROM compression_analytics
        WHERE request_id = ?
        ORDER BY id DESC
        LIMIT 1
      )
  `
    )
    .run(
      promptTokens,
      completionTokens,
      totalTokens,
      cacheReadTokens,
      cacheWriteTokens,
      source,
      requestId,
      requestId
    );
}

function toFiniteInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(0, Math.floor(parsed));
  }
  return null;
}

function appendCondition(whereClause: string, condition: string): string {
  return whereClause ? `${whereClause} AND ${condition}` : `WHERE ${condition}`;
}

export async function getCompressionAnalyticsSummary(
  since?: string
): Promise<CompressionAnalyticsSummary> {
  if (nonCriticalDbDisabled())
    return {
      totalRequests: 0,
      totalTokensSaved: 0,
      avgSavingsPct: 0,
      avgDurationMs: 0,
      byMode: {},
      byEngine: {},
      byCompressionCombo: {},
      byProvider: {},
      last24h: [],
      validationFallbacks: 0,
      realUsage: {
        requestsWithReceipts: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedUsdSaved: 0,
        bySource: {},
      },
      mcpDescriptionCompression: { snapshots: 0, estimatedTokensSaved: 0 },
    };
  const db = getDbInstance();
  await ensureCompressionAnalyticsColumns();

  let cutoff: string | null = null;
  if (since === "24h") {
    cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  } else if (since === "7d") {
    cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  } else if (since === "30d") {
    cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  }

  const whereClause = cutoff ? "WHERE timestamp >= ?" : "";
  const params = cutoff ? [cutoff] : [];

  type ScalarRow = { total: number; total_saved: number; avg_pct: number; avg_dur: number };
  const scalar = (await db
    .prepare(
      `
    SELECT
      COUNT(*)::double precision as total,
      COALESCE(SUM(tokens_saved), 0)::double precision as total_saved,
      COALESCE(AVG(CASE WHEN original_tokens > 0 THEN CAST(tokens_saved AS DOUBLE PRECISION) / original_tokens * 100 ELSE 0 END), 0)::double precision as avg_pct,
      COALESCE(AVG(duration_ms), 0)::double precision as avg_dur
    FROM compression_analytics ${whereClause}
  `
    )
    .get(...params)) as ScalarRow | undefined;

  const modeRows = (await db
    .prepare(
      `
    SELECT mode, COUNT(*)::integer as cnt, COALESCE(SUM(tokens_saved), 0)::integer as saved,
      COALESCE(AVG(CASE WHEN original_tokens > 0 THEN CAST(tokens_saved AS DOUBLE PRECISION) / original_tokens * 100 ELSE 0 END), 0)::double precision as avg_pct
    FROM compression_analytics ${whereClause}
    GROUP BY mode
  `
    )
    .all(...params)) as Array<{ mode: string; cnt: number; saved: number; avg_pct: number }>;

  const byMode: Record<string, { count: number; tokensSaved: number; avgSavingsPct: number }> = {};
  for (const r of modeRows) {
    byMode[r.mode] = { count: r.cnt, tokensSaved: r.saved, avgSavingsPct: Math.round(r.avg_pct) };
  }

  const engineRows = (await db
    .prepare(
      `
    SELECT COALESCE(engine, mode) as engine, COUNT(*)::integer as cnt, COALESCE(SUM(tokens_saved), 0)::integer as saved,
      COALESCE(AVG(CASE WHEN original_tokens > 0 THEN CAST(tokens_saved AS DOUBLE PRECISION) / original_tokens * 100 ELSE 0 END), 0)::double precision as avg_pct
    FROM compression_analytics ${whereClause}
    GROUP BY COALESCE(engine, mode)
  `
    )
    .all(...params)) as Array<{ engine: string; cnt: number; saved: number; avg_pct: number }>;

  const byEngine: Record<string, { count: number; tokensSaved: number; avgSavingsPct: number }> =
    {};
  for (const r of engineRows) {
    byEngine[r.engine] = {
      count: r.cnt,
      tokensSaved: r.saved,
      avgSavingsPct: Math.round(r.avg_pct),
    };
  }

  const compressionComboRows = (await db
    .prepare(
      `
    SELECT compression_combo_id, COUNT(*)::integer as cnt,
      COALESCE(SUM(tokens_saved), 0)::integer as saved
    FROM compression_analytics ${appendCondition(whereClause, "compression_combo_id IS NOT NULL")}
    GROUP BY compression_combo_id ORDER BY cnt DESC
  `
    )
    .all(...params)) as Array<{ compression_combo_id: string | null; cnt: number; saved: number }>;

  const byCompressionCombo: Record<string, { count: number; tokensSaved: number }> = {};
  for (const r of compressionComboRows) {
    const key = r.compression_combo_id ?? "unknown";
    byCompressionCombo[key] = { count: r.cnt, tokensSaved: r.saved };
  }

  const provRows = (await db
    .prepare(
      `
    SELECT provider, COUNT(*)::integer as cnt, COALESCE(SUM(tokens_saved), 0)::integer as saved
    FROM compression_analytics ${whereClause}
    GROUP BY provider ORDER BY cnt DESC
  `
    )
    .all(...params)) as Array<{ provider: string | null; cnt: number; saved: number }>;

  const byProvider: Record<string, { count: number; tokensSaved: number }> = {};
  for (const r of provRows) {
    const key = r.provider ?? "unknown";
    byProvider[key] = { count: r.cnt, tokensSaved: r.saved };
  }

  const last24hMap = new Map<string, { hour: string; count: number; tokensSaved: number }>();
  const now = new Date();
  for (let i = 23; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 60 * 60 * 1000);
    const hourStr = d.toISOString().substring(0, 14) + "00:00Z";
    last24hMap.set(hourStr, { hour: hourStr, count: 0, tokensSaved: 0 });
  }

  const hourRows = (await db
    .prepare(
      `
    SELECT to_char(timestamp::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:00:00"Z"') as hour,
      COUNT(*)::integer as cnt, COALESCE(SUM(tokens_saved), 0)::integer as saved
    FROM compression_analytics
    WHERE timestamp >= ?
    GROUP BY hour ORDER BY hour ASC
  `
    )
    .all(new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString())) as Array<{
    hour: string;
    cnt: number;
    saved: number;
  }>;

  for (const r of hourRows) {
    if (last24hMap.has(r.hour)) {
      last24hMap.set(r.hour, { hour: r.hour, count: r.cnt, tokensSaved: r.saved });
    }
  }

  const last24h = Array.from(last24hMap.values());

  const receiptRows = (await db
    .prepare(
      `
    SELECT receipt_source as source, COUNT(*)::integer as cnt,
      COALESCE(SUM(actual_prompt_tokens), 0)::integer as prompt,
      COALESCE(SUM(actual_completion_tokens), 0)::integer as completion,
      COALESCE(SUM(actual_total_tokens), 0)::integer as total,
      COALESCE(SUM(actual_cache_read_tokens), 0)::integer as cache_read,
      COALESCE(SUM(actual_cache_write_tokens), 0)::integer as cache_write,
      COALESCE(SUM(estimated_usd_saved), 0)::double precision as usd_saved
    FROM compression_analytics ${appendCondition(whereClause, "receipt_source IS NOT NULL")}
    GROUP BY receipt_source
  `
    )
    .all(...params)) as Array<{
    source: string | null;
    cnt: number;
    prompt: number;
    completion: number;
    total: number;
    cache_read: number;
    cache_write: number;
    usd_saved: number;
  }>;

  const realUsage = {
    requestsWithReceipts: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedUsdSaved: 0,
    bySource: {} as Record<string, number>,
  };
  for (const row of receiptRows) {
    const source = row.source ?? "unknown";
    realUsage.requestsWithReceipts += row.cnt;
    realUsage.promptTokens += row.prompt;
    realUsage.completionTokens += row.completion;
    realUsage.totalTokens += row.total;
    realUsage.cacheReadTokens += row.cache_read;
    realUsage.cacheWriteTokens += row.cache_write;
    realUsage.estimatedUsdSaved += row.usd_saved;
    realUsage.bySource[source] = row.cnt;
  }

  const fallbackRow = (await db
    .prepare(
      `
    SELECT COUNT(*)::integer as cnt
    FROM compression_analytics ${appendCondition(whereClause, "validation_fallback = 1")}
  `
    )
    .get(...params)) as { cnt: number } | undefined;

  const mcpDescriptionRow = (await db
    .prepare(
      `
    SELECT COUNT(*)::integer as cnt, COALESCE(SUM(mcp_description_tokens_saved), 0)::integer as saved
    FROM compression_analytics ${appendCondition(whereClause, "mcp_description_tokens_saved > 0")}
  `
    )
    .get(...params)) as { cnt: number; saved: number } | undefined;

  return {
    totalRequests: scalar?.total ?? 0,
    totalTokensSaved: scalar?.total_saved ?? 0,
    avgSavingsPct: Math.round(scalar?.avg_pct ?? 0),
    avgDurationMs: Math.round(scalar?.avg_dur ?? 0),
    byMode,
    byEngine,
    byCompressionCombo,
    byProvider,
    last24h,
    validationFallbacks: fallbackRow?.cnt ?? 0,
    realUsage,
    mcpDescriptionCompression: {
      snapshots: mcpDescriptionRow?.cnt ?? 0,
      estimatedTokensSaved: mcpDescriptionRow?.saved ?? 0,
    },
  };
}

// Ported from OmniRoute upstream v3.8.48 (/api/context/analytics/engine). Derives the
// per-engine shape from getCompressionAnalyticsSummary().byEngine (no new SQL). The fork
// summary only supports discrete windows, so `days` maps to the closest 24h/7d/30d bucket.
export async function getPerEngineAnalytics(
  engineId: string,
  days: number
): Promise<{
  engineId: string;
  runs: number;
  tokensSaved: number;
  avgSavingsPercent: number;
  days: number;
}> {
  const window = days <= 1 ? "24h" : days <= 7 ? "7d" : days <= 30 ? "30d" : undefined;
  const summary = await getCompressionAnalyticsSummary(window);
  const entry = summary.byEngine[engineId];
  return {
    engineId,
    runs: entry?.count ?? 0,
    tokensSaved: entry?.tokensSaved ?? 0,
    avgSavingsPercent: entry?.avgSavingsPct ?? 0,
    days,
  };
}

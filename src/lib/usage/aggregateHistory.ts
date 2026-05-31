/**
 * Aggregation utility functions for usage data summarization.
 * Rolls up usage_history (and quota_snapshots) into daily summary tables.
 *
 * @module lib/usage/aggregateHistory
 */

import { getDbInstance } from "../db/core";
import { getUserDatabaseSettings } from "../db/databaseSettings";

interface AggregationResult {
  processed: number;
  inserted: number;
  errors: number;
}

/**
 * Roll up quota_snapshots into daily_usage_summary table.
 * Aggregates by provider, model, and date.
 *
 * @param fromDate - Start date (YYYY-MM-DD format)
 * @param toDate - End date (YYYY-MM-DD format)
 * @returns Aggregation result with counts
 */
export async function rollupDailyUsage(
  fromDate: string,
  toDate: string
): Promise<AggregationResult> {
  const db = getDbInstance();

  const result: AggregationResult = {
    processed: 0,
    inserted: 0,
    errors: 0,
  };

  try {
    // Aggregate quota_snapshots by provider, model, and date
    // Postgres: use ->>/CAST instead of json_extract, DATE() works in PG too
    const aggregateQuery = `
      INSERT INTO daily_usage_summary (provider, model, date, total_requests, total_input_tokens, total_output_tokens, total_cost)
      SELECT 
        provider,
        COALESCE(NULLIF(raw_data->>'model', ''), 'unknown') as model,
        DATE(created_at) as date,
        COUNT(*) as total_requests,
        COALESCE(SUM(CAST(raw_data->>'input_tokens' AS INTEGER)), 0) as total_input_tokens,
        COALESCE(SUM(CAST(raw_data->>'output_tokens' AS INTEGER)), 0) as total_output_tokens,
        COALESCE(SUM(CAST(raw_data->>'cost' AS NUMERIC)), 0.0) as total_cost
      FROM quota_snapshots
      WHERE DATE(created_at) >= ? AND DATE(created_at) <= ?
      GROUP BY provider, model, DATE(created_at)
      ON CONFLICT(provider, model, date) DO UPDATE SET
        total_requests = excluded.total_requests,
        total_input_tokens = excluded.total_input_tokens,
        total_output_tokens = excluded.total_output_tokens,
        total_cost = excluded.total_cost
    `;

    const runResult = await db.prepare(aggregateQuery).run(fromDate, toDate);

    result.processed = runResult.changes;
    result.inserted = runResult.changes;

    console.log(`[Aggregation] Daily rollup: ${result.inserted} rows for ${fromDate} to ${toDate}`);
  } catch (err: any) {
    console.error("[Aggregation] Daily rollup error:", err);
    result.errors++;
  }

  return result;
}

/**
 * Roll up quota_snapshots into hourly_usage_summary table.
 * Aggregates by provider, model, and hour.
 *
 * @param fromDate - Start datetime (YYYY-MM-DD HH:MM:SS format)
 * @param toDate - End datetime (YYYY-MM-DD HH:MM:SS format)
 * @returns Aggregation result with counts
 */
export async function rollupHourlyQuota(
  fromDate: string,
  toDate: string
): Promise<AggregationResult> {
  const db = getDbInstance();

  const result: AggregationResult = {
    processed: 0,
    inserted: 0,
    errors: 0,
  };

  try {
    // Postgres: date_trunc('hour', ...) replaces datetime(strftime('%Y-%m-%d %H:00:00', ...))
    const aggregateQuery = `
      INSERT INTO hourly_usage_summary (provider, model, date_hour, total_requests, total_input_tokens, total_output_tokens, total_cost)
      SELECT 
        provider,
        COALESCE(NULLIF(raw_data->>'model', ''), 'unknown') as model,
        date_trunc('hour', created_at) as date_hour,
        COUNT(*) as total_requests,
        COALESCE(SUM(CAST(raw_data->>'input_tokens' AS INTEGER)), 0) as total_input_tokens,
        COALESCE(SUM(CAST(raw_data->>'output_tokens' AS INTEGER)), 0) as total_output_tokens,
        COALESCE(SUM(CAST(raw_data->>'cost' AS NUMERIC)), 0.0) as total_cost
      FROM quota_snapshots
      WHERE created_at >= ? AND created_at <= ?
      GROUP BY provider, model, date_trunc('hour', created_at)
      ON CONFLICT(provider, model, date_hour) DO UPDATE SET
        total_requests = excluded.total_requests,
        total_input_tokens = excluded.total_input_tokens,
        total_output_tokens = excluded.total_output_tokens,
        total_cost = excluded.total_cost
    `;

    const runResult = await db.prepare(aggregateQuery).run(fromDate, toDate);

    result.processed = runResult.changes;
    result.inserted = runResult.changes;

    console.log(
      `[Aggregation] Hourly rollup: ${result.inserted} rows for ${fromDate} to ${toDate}`
    );
  } catch (err: any) {
    console.error("[Aggregation] Hourly rollup error:", err);
    result.errors++;
  }

  return result;
}

/**
 * Roll up usage_history into daily_usage_summary before raw rows are deleted.
 * This is the authoritative rollup — sourced from actual per-request token data,
 * not from quota_snapshots. Should be called before cleanupUsageHistory() deletes rows.
 *
 * The ON CONFLICT clause uses SUM so re-running is additive-safe: if a date already
 * has a partial rollup (e.g. from a previous partial cleanup), new rows accumulate.
 *
 * @param beforeDate - ISO timestamp/date boundary. Rows strictly before this value are rolled up.
 * @returns Aggregation result with counts
 */
export async function rollupUsageHistoryBeforeDate(beforeDate: string): Promise<AggregationResult> {
  const db = getDbInstance();

  const result: AggregationResult = {
    processed: 0,
    inserted: 0,
    errors: 0,
  };

  try {
    // Postgres: DATE() works; LOWER() works; no SQLite-specific syntax needed here
    const aggregateQuery = `
      INSERT INTO daily_usage_summary (provider, model, date, total_requests, total_input_tokens, total_output_tokens, total_cost)
      SELECT
        LOWER(provider) as provider,
        LOWER(model) as model,
        DATE(timestamp) as date,
        COUNT(*) as total_requests,
        COALESCE(SUM(tokens_input), 0) as total_input_tokens,
        COALESCE(SUM(tokens_output), 0) as total_output_tokens,
        0.0 as total_cost
      FROM usage_history
      WHERE timestamp < ?
        AND provider IS NOT NULL AND provider != ''
        AND model IS NOT NULL AND model != ''
      GROUP BY LOWER(provider), LOWER(model), DATE(timestamp)
      ON CONFLICT(provider, model, date) DO UPDATE SET
        total_requests = daily_usage_summary.total_requests + excluded.total_requests,
        total_input_tokens = daily_usage_summary.total_input_tokens + excluded.total_input_tokens,
        total_output_tokens = daily_usage_summary.total_output_tokens + excluded.total_output_tokens
    `;

    const runResult = await db.prepare(aggregateQuery).run(beforeDate);

    result.processed = runResult.changes;
    result.inserted = runResult.changes;

    console.log(
      `[Aggregation] usage_history rollup: ${result.inserted} rows for dates before ${beforeDate}`
    );
  } catch (err: any) {
    console.error("[Aggregation] usage_history rollup error:", err);
    result.errors++;
  }

  return result;
}

/**
 * Get the cutoff date for raw data based on retention settings.
 * Data older than this should be aggregated and cleaned up.
 *
 * @returns ISO date string (YYYY-MM-DD)
 */
export async function getRawDataCutoffDate(): Promise<string> {
  const settings = await getUserDatabaseSettings();
  const rawDataRetentionDays = settings.aggregation.rawDataRetentionDays;

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - rawDataRetentionDays);

  return cutoffDate.toISOString().split("T")[0];
}

/**
 * Check if aggregation is enabled in settings.
 */
export async function isAggregationEnabled(): Promise<boolean> {
  const settings = await getUserDatabaseSettings();
  return settings.aggregation.enabled;
}

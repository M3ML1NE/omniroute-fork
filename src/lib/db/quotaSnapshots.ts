import { getDbInstance, rowToCamel } from "./core";
import type { QuotaSnapshotRow, ProviderUtilizationPoint } from "@/shared/types/utilization";

let lastCleanupAt = 0;

export async function saveQuotaSnapshot(
  snapshot: Omit<QuotaSnapshotRow, "id" | "created_at">
): Promise<void> {
  const db = getDbInstance();
  const now = new Date().toISOString();

  try {
    await db
      .prepare(
        `INSERT INTO quota_snapshots
         (provider, connection_id, window_key, remaining_percentage, is_exhausted,
          next_reset_at, window_duration_ms, raw_data, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        snapshot.provider,
        snapshot.connection_id,
        snapshot.window_key,
        snapshot.remaining_percentage,
        snapshot.is_exhausted,
        snapshot.next_reset_at,
        snapshot.window_duration_ms,
        snapshot.raw_data,
        now
      );
  } catch (err: any) {
    if (err?.message?.includes("no such table") || err?.message?.includes("does not exist")) {
      console.warn(
        "[QuotaSnapshots] Skipping save: quota_snapshots table not found. Awaiting migration."
      );
      return;
    }
    throw err;
  }
}

export async function getQuotaSnapshots(opts: {
  provider?: string;
  connectionId?: string;
  since: string;
  until?: string;
}): Promise<QuotaSnapshotRow[]> {
  const db = getDbInstance();
  const conditions: string[] = ["created_at >= ?"];
  const params: unknown[] = [opts.since];

  if (opts.provider) {
    conditions.push("provider = ?");
    params.push(opts.provider);
  }

  if (opts.connectionId) {
    conditions.push("connection_id = ?");
    params.push(opts.connectionId);
  }

  if (opts.until) {
    conditions.push("created_at <= ?");
    params.push(opts.until);
  }

  try {
    const sql = `SELECT * FROM quota_snapshots WHERE ${conditions.join(" AND ")} ORDER BY created_at ASC`;
    const rows = await db.prepare(sql).all(...params);
    return rows.map((r) => rowToCamel(r) as unknown as QuotaSnapshotRow);
  } catch (err: any) {
    if (err?.message?.includes("no such table") || err?.message?.includes("does not exist")) {
      return [];
    }
    throw err;
  }
}

export async function getAggregatedSnapshots(opts: {
  provider?: string;
  since: string;
  until?: string;
  bucketMinutes: number;
  aggregateBy?: "provider" | "connection";
}): Promise<ProviderUtilizationPoint[]> {
  const db = getDbInstance();
  const conditions: string[] = ["created_at >= ?"];
  const params: unknown[] = [opts.since];

  if (opts.provider) {
    conditions.push("provider = ?");
    params.push(opts.provider);
  }

  if (opts.until) {
    conditions.push("created_at <= ?");
    params.push(opts.until);
  }

  const bucketSeconds = Number(opts.bucketMinutes) * 60;
  if (!Number.isFinite(bucketSeconds) || bucketSeconds <= 0) {
    throw new Error("Invalid bucket size");
  }

  const groupFields =
    opts.aggregateBy === "connection"
      ? "bucket, provider, connection_id, window_key"
      : "bucket, provider, window_key";
  const selectKey =
    opts.aggregateBy === "connection"
      ? "provider || ':' || connection_id as provider"
      : "provider";

  try {
    const sql = `
      SELECT
        TO_TIMESTAMP(
          (EXTRACT(EPOCH FROM created_at::timestamptz)::bigint / ${bucketSeconds}) * ${bucketSeconds}
        ) AS bucket,
        ${selectKey},
        AVG(remaining_percentage) as remainingPct,
        MAX(is_exhausted) as isExhausted,
        window_key
      FROM quota_snapshots
      WHERE ${conditions.join(" AND ")}
      GROUP BY ${groupFields}
      ORDER BY bucket ASC
    `;

    const rows = await db.prepare(sql).all(...params) as Array<{
      bucket: string | Date;
      provider: string;
      remainingpct: number | null;
      isexhausted: number;
      window_key: string;
    }>;

    return rows.map((r) => ({
      timestamp: r.bucket instanceof Date ? r.bucket.toISOString() : String(r.bucket),
      provider: r.provider,
      remainingPct: r.remainingpct ?? 0,
      isExhausted: r.isexhausted === 1 || (r.isexhausted as unknown) === true,
      windowKey: r.window_key,
    }));
  } catch (err: any) {
    if (err?.message?.includes("no such table") || err?.message?.includes("does not exist")) {
      return [];
    }
    throw err;
  }
}

export async function cleanupOldSnapshots(retentionDays = 90): Promise<number> {
  const now = Date.now();
  const cleanupThresholdMs = 6 * 60 * 60 * 1000;

  if (now - lastCleanupAt < cleanupThresholdMs) {
    return 0;
  }

  const db = getDbInstance();
  const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  try {
    const result = await db
      .prepare("DELETE FROM quota_snapshots WHERE created_at < ?")
      .run(cutoffDate);
    lastCleanupAt = now;
    return result.changes;
  } catch (err: any) {
    if (err?.message?.includes("no such table") || err?.message?.includes("does not exist")) {
      return 0;
    }
    throw err;
  }
}

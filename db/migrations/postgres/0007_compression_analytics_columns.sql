-- 0007_compression_analytics_columns.sql
-- Add the compression_analytics columns that the SQLite-era runtime added via
-- ensureCompressionAnalyticsColumns(). That helper early-returns on Postgres, so
-- on PG these columns were never created and getCompressionAnalyticsSummary()
-- failed with: column "engine" does not exist (once OMNIROUTE_MINIMAL_DB is off
-- and the query actually runs). Idempotent (ADD COLUMN IF NOT EXISTS).
ALTER TABLE compression_analytics ADD COLUMN IF NOT EXISTS engine TEXT;
ALTER TABLE compression_analytics ADD COLUMN IF NOT EXISTS compression_combo_id TEXT;
ALTER TABLE compression_analytics ADD COLUMN IF NOT EXISTS rtk_raw_output_pointer TEXT;
ALTER TABLE compression_analytics ADD COLUMN IF NOT EXISTS rtk_raw_output_bytes INTEGER;
ALTER TABLE compression_analytics ADD COLUMN IF NOT EXISTS rtk_raw_output_pointers TEXT;
ALTER TABLE compression_analytics ADD COLUMN IF NOT EXISTS rtk_raw_output_total_bytes INTEGER;

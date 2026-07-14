-- 0011_call_logs_correlation_id.sql
-- Persist request/correlation IDs on call_logs so support/debug flows can
-- connect an HTTP request header to the durable call-log row after the request
-- has completed. Idempotent for already-migrated databases.
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS correlation_id TEXT;
CREATE INDEX IF NOT EXISTS idx_call_logs_correlation_id ON call_logs(correlation_id);

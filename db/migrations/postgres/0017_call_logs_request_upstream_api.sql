-- 0017_call_logs_request_upstream_api.sql
-- Persist the effective X-Request-ID (client-supplied, falling back to the
-- upstream provider's echoed value) and the GigaChat upstream API contract
-- version ("v1" | "v2") that actually served each call, so the dashboard
-- call-log card can surface both directly from the summary row without
-- opening the (much larger) pipeline payload artifact.
-- Idempotent for already-migrated databases.
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS request_id TEXT;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS upstream_api_version TEXT;
CREATE INDEX IF NOT EXISTS idx_call_logs_request_id ON call_logs(request_id);

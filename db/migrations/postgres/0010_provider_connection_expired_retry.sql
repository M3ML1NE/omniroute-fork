-- 0010_provider_connection_expired_retry.sql
-- src/lib/tokenHealthCheck.ts reads/writes conn.expiredRetryCount and
-- conn.expiredRetryAt to back off retries for connections whose OAuth
-- refresh token has been permanently consumed (testStatus = 'expired').
-- Neither column ever existed in provider_connections (missing from the
-- upstream schema too), so every write silently no-ops and every read
-- falls back to 0 — the exponential backoff in checkConnection() (up to
-- EXPIRED_RETRY_MAX=3 attempts, 5min/10min/20min spacing) never actually
-- persists across sweeps, so expired connections get hammered on every
-- 60s tick indefinitely instead of backing off.
-- Idempotent: IF NOT EXISTS ensures safe re-application.
ALTER TABLE provider_connections ADD COLUMN IF NOT EXISTS expired_retry_count INTEGER;
ALTER TABLE provider_connections ADD COLUMN IF NOT EXISTS expired_retry_at TEXT;

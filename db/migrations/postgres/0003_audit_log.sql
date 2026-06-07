-- 0003_audit_log.sql
-- Compliance audit_log table for administrative actions.
--
-- The runtime helper src/lib/compliance/index.ts (getAuditLog / logAuditEvent)
-- queries `audit_log`, but the table was never created in the Postgres baseline
-- (ensureAuditLogSchema became a no-op during the SQLite->Postgres migration),
-- causing `relation "audit_log" does not exist`. This migration restores it,
-- folding the original SQLite schema + ALTER COLUMN history into a single
-- consolidated Postgres definition.
--
-- Idempotent (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS audit_log (
  id            BIGSERIAL PRIMARY KEY,
  timestamp     TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  action        TEXT NOT NULL,
  actor         TEXT NOT NULL DEFAULT 'system',
  target        TEXT,
  details       TEXT,
  ip_address    TEXT,
  resource_type TEXT,
  status        TEXT,
  request_id    TEXT,
  metadata      TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_timestamp     ON audit_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_action        ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_actor         ON audit_log(actor);
CREATE INDEX IF NOT EXISTS idx_audit_resource_type ON audit_log(resource_type);
CREATE INDEX IF NOT EXISTS idx_audit_status        ON audit_log(status);
CREATE INDEX IF NOT EXISTS idx_audit_request_id    ON audit_log(request_id);

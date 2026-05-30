-- 0002_schema.sql
-- Full base schema for omniroute, ported from src/lib/db/core.ts SCHEMA_SQL
-- plus the column extensions previously applied at runtime by ensure*Columns.
-- This single migration replaces SQLite as the system of record.

CREATE TABLE IF NOT EXISTS provider_connections (
  id                          TEXT PRIMARY KEY,
  provider                    TEXT NOT NULL,
  auth_type                   TEXT,
  name                        TEXT,
  email                       TEXT,
  priority                    INTEGER NOT NULL DEFAULT 0,
  is_active                   INTEGER NOT NULL DEFAULT 1,
  access_token                TEXT,
  refresh_token               TEXT,
  expires_at                  TEXT,
  token_expires_at            TEXT,
  scope                       TEXT,
  project_id                  TEXT,
  test_status                 TEXT,
  error_code                  TEXT,
  last_error                  TEXT,
  last_error_at               TEXT,
  last_error_type             TEXT,
  last_error_source           TEXT,
  backoff_level               INTEGER NOT NULL DEFAULT 0,
  rate_limited_until          BIGINT,
  health_check_interval       INTEGER,
  last_health_check_at        TEXT,
  last_tested                 TEXT,
  api_key                     TEXT,
  id_token                    TEXT,
  provider_specific_data      TEXT,
  expires_in                  INTEGER,
  display_name                TEXT,
  global_priority             INTEGER,
  default_model               TEXT,
  token_type                  TEXT,
  consecutive_use_count       INTEGER NOT NULL DEFAULT 0,
  rate_limit_protection       INTEGER NOT NULL DEFAULT 0,
  last_used_at                TEXT,
  "group"                     TEXT,
  max_concurrent              INTEGER,
  quota_window_thresholds_json TEXT,
  -- Task 22: nullable reference to a keys.json keystore entry id (T25 will populate).
  keystore_entry_id           TEXT,
  created_at                  TEXT NOT NULL,
  updated_at                  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pc_provider           ON provider_connections(provider);
CREATE INDEX IF NOT EXISTS idx_pc_active             ON provider_connections(is_active);
CREATE INDEX IF NOT EXISTS idx_pc_priority           ON provider_connections(provider, priority);
CREATE INDEX IF NOT EXISTS idx_pc_max_concurrent     ON provider_connections(provider, max_concurrent);

CREATE TABLE IF NOT EXISTS provider_nodes (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  name         TEXT NOT NULL,
  prefix       TEXT,
  api_type     TEXT,
  base_url     TEXT,
  chat_path    TEXT,
  models_path  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS key_value (
  namespace TEXT NOT NULL,
  key       TEXT NOT NULL,
  value     TEXT NOT NULL,
  PRIMARY KEY (namespace, key)
);

CREATE TABLE IF NOT EXISTS combos (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  data        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id                       TEXT PRIMARY KEY,
  name                     TEXT NOT NULL,
  key                      TEXT NOT NULL UNIQUE,
  machine_id               TEXT,
  allowed_models           TEXT NOT NULL DEFAULT '[]',
  allowed_combos           TEXT,
  allowed_connections      TEXT,
  no_log                   INTEGER NOT NULL DEFAULT 0,
  auto_resolve             INTEGER NOT NULL DEFAULT 0,
  is_active                INTEGER NOT NULL DEFAULT 1,
  access_schedule          TEXT,
  max_requests_per_day     INTEGER,
  max_requests_per_minute  INTEGER,
  throttle_delay_ms        INTEGER,
  max_sessions             INTEGER NOT NULL DEFAULT 0,
  revoked_at               TEXT,
  expires_at               TEXT,
  last_used_at             TEXT,
  key_prefix               TEXT,
  ip_allowlist             TEXT,
  scopes                   TEXT,
  rate_limits              TEXT,
  is_banned                INTEGER NOT NULL DEFAULT 0,
  key_hash                 TEXT,
  allowed_endpoints        TEXT,
  created_at               TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ak_key      ON api_keys(key);
CREATE INDEX IF NOT EXISTS idx_ak_key_hash ON api_keys(key_hash);

CREATE TABLE IF NOT EXISTS db_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS usage_history (
  id                      BIGSERIAL PRIMARY KEY,
  provider                TEXT,
  model                   TEXT,
  connection_id           TEXT,
  api_key_id              TEXT,
  api_key_name            TEXT,
  tokens_input            INTEGER NOT NULL DEFAULT 0,
  tokens_output           INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read       INTEGER NOT NULL DEFAULT 0,
  tokens_cache_creation   INTEGER NOT NULL DEFAULT 0,
  tokens_reasoning        INTEGER NOT NULL DEFAULT 0,
  service_tier            TEXT NOT NULL DEFAULT 'standard',
  status                  TEXT,
  success                 INTEGER NOT NULL DEFAULT 1,
  latency_ms              INTEGER NOT NULL DEFAULT 0,
  ttft_ms                 INTEGER NOT NULL DEFAULT 0,
  error_code              TEXT,
  combo_strategy          TEXT NOT NULL DEFAULT 'direct',
  timestamp               TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_uh_timestamp      ON usage_history(timestamp);
CREATE INDEX IF NOT EXISTS idx_uh_provider       ON usage_history(provider);
CREATE INDEX IF NOT EXISTS idx_uh_model          ON usage_history(model);
CREATE INDEX IF NOT EXISTS idx_uh_service_tier   ON usage_history(service_tier);
CREATE INDEX IF NOT EXISTS idx_uh_combo_strategy ON usage_history(combo_strategy);

CREATE TABLE IF NOT EXISTS call_logs (
  id                       TEXT PRIMARY KEY,
  timestamp                TEXT NOT NULL,
  method                   TEXT,
  path                     TEXT,
  status                   INTEGER,
  model                    TEXT,
  requested_model          TEXT,
  provider                 TEXT,
  account                  TEXT,
  connection_id            TEXT,
  duration                 INTEGER NOT NULL DEFAULT 0,
  tokens_in                INTEGER NOT NULL DEFAULT 0,
  tokens_out               INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read        INTEGER,
  tokens_cache_creation    INTEGER,
  tokens_reasoning         INTEGER,
  tokens_compressed        INTEGER,
  cache_source             TEXT NOT NULL DEFAULT 'upstream',
  request_type             TEXT,
  source_format            TEXT,
  target_format            TEXT,
  api_key_id               TEXT,
  api_key_name             TEXT,
  combo_name               TEXT,
  combo_step_id            TEXT,
  combo_execution_key      TEXT,
  error_summary            TEXT,
  detail_state             TEXT NOT NULL DEFAULT 'none',
  artifact_relpath         TEXT,
  artifact_size_bytes      INTEGER,
  artifact_sha256          TEXT,
  has_request_body         INTEGER NOT NULL DEFAULT 0,
  has_response_body        INTEGER NOT NULL DEFAULT 0,
  has_pipeline_details     INTEGER NOT NULL DEFAULT 0,
  request_summary          TEXT
);
CREATE INDEX IF NOT EXISTS idx_cl_timestamp                ON call_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_cl_status                   ON call_logs(status);
CREATE INDEX IF NOT EXISTS idx_call_logs_requested_model   ON call_logs(requested_model);
CREATE INDEX IF NOT EXISTS idx_call_logs_request_type      ON call_logs(request_type);
CREATE INDEX IF NOT EXISTS idx_cl_combo_target             ON call_logs(combo_name, combo_execution_key, timestamp);

CREATE TABLE IF NOT EXISTS proxy_logs (
  id                BIGSERIAL PRIMARY KEY,
  timestamp         TEXT NOT NULL,
  status            TEXT,
  proxy_type        TEXT,
  proxy_host        TEXT,
  proxy_port        INTEGER,
  level             TEXT,
  level_id          TEXT,
  provider          TEXT,
  target_url        TEXT,
  public_ip         TEXT,
  latency_ms        INTEGER NOT NULL DEFAULT 0,
  error             TEXT,
  connection_id     TEXT,
  combo_id          TEXT,
  account           TEXT,
  tls_fingerprint   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pl_timestamp ON proxy_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_pl_status    ON proxy_logs(status);
CREATE INDEX IF NOT EXISTS idx_pl_provider  ON proxy_logs(provider);

CREATE TABLE IF NOT EXISTS domain_fallback_chains (
  model TEXT PRIMARY KEY,
  chain TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS domain_budgets (
  api_key_id            TEXT PRIMARY KEY,
  daily_limit_usd       DOUBLE PRECISION NOT NULL,
  weekly_limit_usd      DOUBLE PRECISION NOT NULL DEFAULT 0,
  monthly_limit_usd     DOUBLE PRECISION NOT NULL DEFAULT 0,
  warning_threshold     DOUBLE PRECISION NOT NULL DEFAULT 0.8,
  reset_interval        TEXT NOT NULL DEFAULT 'daily',
  reset_time            TEXT NOT NULL DEFAULT '00:00',
  budget_reset_at       BIGINT,
  last_budget_reset_at  BIGINT,
  warning_emitted_at    BIGINT,
  warning_period_start  BIGINT
);

CREATE TABLE IF NOT EXISTS domain_budget_reset_logs (
  id              BIGSERIAL PRIMARY KEY,
  api_key_id      TEXT NOT NULL,
  reset_interval  TEXT NOT NULL,
  previous_spend  DOUBLE PRECISION NOT NULL DEFAULT 0,
  reset_at        BIGINT NOT NULL,
  next_reset_at   BIGINT NOT NULL,
  period_start    BIGINT NOT NULL,
  period_end      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dbrl_key_reset ON domain_budget_reset_logs(api_key_id, reset_at DESC);

CREATE TABLE IF NOT EXISTS domain_cost_history (
  id          BIGSERIAL PRIMARY KEY,
  api_key_id  TEXT NOT NULL,
  cost        DOUBLE PRECISION NOT NULL,
  timestamp   BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dch_key ON domain_cost_history(api_key_id);
CREATE INDEX IF NOT EXISTS idx_dch_ts  ON domain_cost_history(timestamp);

CREATE TABLE IF NOT EXISTS domain_lockout_state (
  identifier   TEXT PRIMARY KEY,
  attempts     TEXT NOT NULL,
  locked_until BIGINT
);

CREATE TABLE IF NOT EXISTS domain_circuit_breakers (
  name              TEXT PRIMARY KEY,
  state             TEXT NOT NULL DEFAULT 'CLOSED',
  failure_count     INTEGER NOT NULL DEFAULT 0,
  last_failure_time BIGINT,
  options           TEXT
);

CREATE TABLE IF NOT EXISTS semantic_cache (
  id            TEXT PRIMARY KEY,
  signature     TEXT NOT NULL UNIQUE,
  model         TEXT NOT NULL,
  prompt_hash   TEXT NOT NULL,
  response      TEXT NOT NULL,
  tokens_saved  INTEGER NOT NULL DEFAULT 0,
  hit_count     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sc_sig   ON semantic_cache(signature);
CREATE INDEX IF NOT EXISTS idx_sc_model ON semantic_cache(model);

CREATE TABLE IF NOT EXISTS quota_snapshots (
  id                     BIGSERIAL PRIMARY KEY,
  provider               TEXT NOT NULL,
  connection_id          TEXT NOT NULL,
  window_key             TEXT NOT NULL,
  remaining_percentage   DOUBLE PRECISION,
  is_exhausted           INTEGER NOT NULL DEFAULT 0,
  next_reset_at          TEXT,
  window_duration_ms     INTEGER,
  raw_data               TEXT,
  created_at             TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_quota_snapshots_provider_time   ON quota_snapshots(provider, created_at);
CREATE INDEX IF NOT EXISTS idx_quota_snapshots_connection_time ON quota_snapshots(connection_id, created_at);
CREATE INDEX IF NOT EXISTS idx_quota_snapshots_created_at      ON quota_snapshots(created_at);

CREATE TABLE IF NOT EXISTS prompt_templates (
  id            BIGSERIAL PRIMARY KEY,
  slug          TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  content       TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  variables     TEXT,
  description   TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  UNIQUE(slug, version)
);
CREATE INDEX IF NOT EXISTS idx_pt_slug   ON prompt_templates(slug);
CREATE INDEX IF NOT EXISTS idx_pt_active ON prompt_templates(slug, is_active);
CREATE INDEX IF NOT EXISTS idx_pt_hash   ON prompt_templates(content_hash);

-- Schema version stamp.
INSERT INTO db_meta (key, value) VALUES ('schema_version', '1')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

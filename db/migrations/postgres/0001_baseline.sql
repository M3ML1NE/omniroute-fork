-- 0001_baseline.sql
-- Consolidated PostgreSQL baseline schema for OmniRoute.
--
-- This single migration is the system-of-record schema. It is the result of
-- translating the 74 incremental SQLite migrations
-- (src/lib/db/migrations/001_initial_schema.sql ... 076_create_plugins.sql) into
-- their FINAL consolidated state and porting them to PostgreSQL. All later
-- ALTER TABLE ADD COLUMN steps from the SQLite history are folded directly into
-- each CREATE TABLE definition here, so a fresh database reaches the exact same
-- shape as a fully-migrated SQLite database.
--
-- Covers all 75 application tables. Idempotent throughout
-- (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS), so it may be
-- re-applied safely.
--
-- Translation conventions (matched to the existing TypeScript code, see the
-- prior partial translation in 0002_schema.sql which this file supersedes):
--   * INTEGER PRIMARY KEY AUTOINCREMENT      -> BIGSERIAL PRIMARY KEY
--   * TEXT PRIMARY KEY                        -> TEXT PRIMARY KEY (string ids)
--   * BLOB                                    -> BYTEA
--   * REAL                                    -> DOUBLE PRECISION
--   * boolean-ish 0/1 flags                   -> kept as INTEGER (code stores 0/1)
--   * ISO-string timestamps                   -> kept as TEXT
--   * epoch (ms/seconds) timestamps & counters-> BIGINT
--   * DEFAULT (datetime('now'))               -> TEXT DEFAULT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS')
--   * strftime()/randomblob() SQLite fns      -> nearest portable Postgres default
-- SQLite-only constructs (FTS5 virtual tables, ring-buffer / cascade-emulation
-- TRIGGERs, WITHOUT ROWID) are not portable and are intentionally omitted; the
-- relevant behaviour is owned by the application layer.

-- ============================================================================
-- Core / no-dependency tables
-- ============================================================================

CREATE TABLE IF NOT EXISTS db_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS key_value (
  namespace TEXT NOT NULL,
  key       TEXT NOT NULL,
  value     TEXT NOT NULL,
  PRIMARY KEY (namespace, key)
);

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
  keystore_entry_id           TEXT,
  created_at                  TEXT NOT NULL,
  updated_at                  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pc_provider       ON provider_connections(provider);
CREATE INDEX IF NOT EXISTS idx_pc_active         ON provider_connections(is_active);
CREATE INDEX IF NOT EXISTS idx_pc_priority       ON provider_connections(provider, priority);
CREATE INDEX IF NOT EXISTS idx_pc_max_concurrent ON provider_connections(provider, max_concurrent);

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

CREATE TABLE IF NOT EXISTS combos (
  id                       TEXT PRIMARY KEY,
  name                     TEXT NOT NULL UNIQUE,
  data                     TEXT NOT NULL,
  system_message           TEXT,
  tool_filter_regex        TEXT,
  context_cache_protection INTEGER DEFAULT 0,
  sort_order               INTEGER NOT NULL DEFAULT 0,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_combos_cache_protection ON combos(context_cache_protection);

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
CREATE INDEX IF NOT EXISTS idx_ak_key             ON api_keys(key);
CREATE INDEX IF NOT EXISTS idx_ak_key_hash        ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_revoked_at ON api_keys(revoked_at);
CREATE INDEX IF NOT EXISTS idx_api_keys_expires_at ON api_keys(expires_at);

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
CREATE INDEX IF NOT EXISTS idx_usage_history_api_key_id_timestamp   ON usage_history(api_key_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_usage_history_api_key_name_timestamp ON usage_history(api_key_name, timestamp);
CREATE INDEX IF NOT EXISTS idx_uh_key_provider_model_ts            ON usage_history(api_key_id, provider, model, timestamp);

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
CREATE INDEX IF NOT EXISTS idx_call_logs_combo_name_timestamp ON call_logs(combo_name, timestamp);

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

CREATE TABLE IF NOT EXISTS proxy_registry (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL,
  host          TEXT NOT NULL,
  port          INTEGER NOT NULL,
  username      TEXT,
  password      TEXT,
  region        TEXT,
  notes         TEXT,
  status        TEXT NOT NULL DEFAULT 'active',
  source        TEXT NOT NULL DEFAULT 'manual',
  quality_score INTEGER,
  latency_ms    INTEGER,
  anonymity     TEXT,
  google_access INTEGER DEFAULT 0,
  last_validated TEXT,
  country_code  TEXT,
  created_at    TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at    TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_proxy_registry_status  ON proxy_registry(status);
CREATE INDEX IF NOT EXISTS idx_proxy_registry_host    ON proxy_registry(host);
CREATE INDEX IF NOT EXISTS idx_proxy_registry_source  ON proxy_registry(source);
CREATE INDEX IF NOT EXISTS idx_proxy_registry_quality ON proxy_registry(quality_score DESC);
CREATE INDEX IF NOT EXISTS idx_proxy_registry_country ON proxy_registry(country_code);

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

CREATE TABLE IF NOT EXISTS domain_cost_history (
  id          BIGSERIAL PRIMARY KEY,
  api_key_id  TEXT NOT NULL,
  cost        DOUBLE PRECISION NOT NULL,
  timestamp   BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dch_key           ON domain_cost_history(api_key_id);
CREATE INDEX IF NOT EXISTS idx_dch_ts            ON domain_cost_history(timestamp);
CREATE INDEX IF NOT EXISTS idx_dch_key_timestamp ON domain_cost_history(api_key_id, timestamp);

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

-- ============================================================================
-- MCP / A2A / routing
-- ============================================================================

CREATE TABLE IF NOT EXISTS mcp_tool_audit (
  id             BIGSERIAL PRIMARY KEY,
  tool_name      TEXT NOT NULL,
  input_hash     TEXT,
  output_summary TEXT,
  duration_ms    INTEGER,
  api_key_id     TEXT,
  success        INTEGER DEFAULT 1,
  error_code     TEXT,
  created_at     TEXT DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_mta_tool    ON mcp_tool_audit(tool_name);
CREATE INDEX IF NOT EXISTS idx_mta_created ON mcp_tool_audit(created_at);
CREATE INDEX IF NOT EXISTS idx_mta_apikey  ON mcp_tool_audit(api_key_id);

CREATE TABLE IF NOT EXISTS routing_decisions (
  id                  BIGSERIAL PRIMARY KEY,
  request_id          TEXT,
  task_type           TEXT,
  combo_id            TEXT,
  provider_selected   TEXT,
  model_selected      TEXT,
  score               DOUBLE PRECISION,
  factors_json        TEXT,
  fallbacks_triggered INTEGER DEFAULT 0,
  success             INTEGER DEFAULT 1,
  latency_ms          INTEGER,
  cost                DOUBLE PRECISION,
  source              TEXT DEFAULT 'api',
  created_at          TEXT DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_rd_request  ON routing_decisions(request_id);
CREATE INDEX IF NOT EXISTS idx_rd_combo    ON routing_decisions(combo_id);
CREATE INDEX IF NOT EXISTS idx_rd_provider ON routing_decisions(provider_selected);
CREATE INDEX IF NOT EXISTS idx_rd_created  ON routing_decisions(created_at);

CREATE TABLE IF NOT EXISTS combo_adaptation_state (
  id              BIGSERIAL PRIMARY KEY,
  combo_id        TEXT NOT NULL,
  provider_id     TEXT NOT NULL,
  learned_score   DOUBLE PRECISION DEFAULT 0.5,
  request_count   INTEGER DEFAULT 0,
  success_count   INTEGER DEFAULT 0,
  avg_latency_ms  DOUBLE PRECISION,
  last_failure_at TEXT,
  excluded_until  TEXT,
  updated_at      TEXT DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE(combo_id, provider_id)
);
CREATE INDEX IF NOT EXISTS idx_cas_combo ON combo_adaptation_state(combo_id);

-- ============================================================================
-- Logging / detailed request logs
-- ============================================================================

CREATE TABLE IF NOT EXISTS request_detail_logs (
  id                 TEXT PRIMARY KEY,
  call_log_id        TEXT,
  timestamp          TEXT NOT NULL,
  client_request     TEXT,
  translated_request TEXT,
  provider_response  TEXT,
  client_response    TEXT,
  provider           TEXT,
  model              TEXT,
  source_format      TEXT,
  target_format      TEXT,
  duration_ms        INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_rdl_timestamp   ON request_detail_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_rdl_call_log_id ON request_detail_logs(call_log_id);

-- ============================================================================
-- Registered keys / provisioning limits
-- ============================================================================

CREATE TABLE IF NOT EXISTS registered_keys (
  id              TEXT PRIMARY KEY,
  key             TEXT NOT NULL UNIQUE,
  key_prefix      TEXT NOT NULL,
  name            TEXT NOT NULL,
  provider        TEXT NOT NULL DEFAULT '',
  account_id      TEXT NOT NULL DEFAULT '',
  is_active       INTEGER NOT NULL DEFAULT 1,
  revoked_at      TEXT,
  expires_at      TEXT,
  idempotency_key TEXT UNIQUE,
  daily_budget    INTEGER,
  hourly_budget   INTEGER,
  daily_used      INTEGER NOT NULL DEFAULT 0,
  hourly_used     INTEGER NOT NULL DEFAULT 0,
  last_reset_day  TEXT NOT NULL DEFAULT '',
  last_reset_hour TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at      TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_registered_keys_provider    ON registered_keys(provider);
CREATE INDEX IF NOT EXISTS idx_registered_keys_account     ON registered_keys(account_id);
CREATE INDEX IF NOT EXISTS idx_registered_keys_active      ON registered_keys(is_active);
CREATE INDEX IF NOT EXISTS idx_registered_keys_idempotency ON registered_keys(idempotency_key);

CREATE TABLE IF NOT EXISTS provider_key_limits (
  provider           TEXT PRIMARY KEY,
  max_active_keys    INTEGER,
  daily_issue_limit  INTEGER,
  hourly_issue_limit INTEGER,
  daily_issued       INTEGER NOT NULL DEFAULT 0,
  hourly_issued      INTEGER NOT NULL DEFAULT 0,
  last_reset_day     TEXT NOT NULL DEFAULT '',
  last_reset_hour    TEXT NOT NULL DEFAULT '',
  updated_at         TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS account_key_limits (
  account_id         TEXT PRIMARY KEY,
  max_active_keys    INTEGER,
  daily_issue_limit  INTEGER,
  hourly_issue_limit INTEGER,
  daily_issued       INTEGER NOT NULL DEFAULT 0,
  hourly_issued      INTEGER NOT NULL DEFAULT 0,
  last_reset_day     TEXT NOT NULL DEFAULT '',
  last_reset_hour    TEXT NOT NULL DEFAULT '',
  updated_at         TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

-- ============================================================================
-- Webhooks
-- ============================================================================

CREATE TABLE IF NOT EXISTS webhooks (
  id                 TEXT PRIMARY KEY,
  url                TEXT NOT NULL,
  events             TEXT NOT NULL DEFAULT '["*"]',
  secret             TEXT,
  enabled            INTEGER DEFAULT 1,
  description        TEXT DEFAULT '',
  created_at         TEXT DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  last_triggered_at  TEXT,
  last_status        INTEGER,
  failure_count      INTEGER DEFAULT 0,
  kind               TEXT NOT NULL DEFAULT 'custom',
  metadata_encrypted BYTEA
);

-- ============================================================================
-- Memories / skills
-- ============================================================================

CREATE TABLE IF NOT EXISTS memories (
  id         TEXT PRIMARY KEY,
  api_key_id TEXT NOT NULL,
  session_id TEXT,
  type       TEXT NOT NULL CHECK(type IN ('factual', 'episodic', 'procedural', 'semantic')),
  key        TEXT,
  content    TEXT NOT NULL,
  metadata   TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  expires_at TEXT,
  memory_id  BIGINT
);
CREATE INDEX IF NOT EXISTS idx_memories_api_key ON memories(api_key_id);
CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);
CREATE INDEX IF NOT EXISTS idx_memories_type    ON memories(type);
CREATE INDEX IF NOT EXISTS idx_memories_expires ON memories(expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_memory_id ON memories(memory_id);

CREATE TABLE IF NOT EXISTS skills (
  id              TEXT PRIMARY KEY,
  api_key_id      TEXT NOT NULL,
  name            TEXT NOT NULL,
  version         TEXT NOT NULL DEFAULT '1.0.0',
  description     TEXT,
  schema          TEXT NOT NULL,
  handler         TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  mode            TEXT NOT NULL DEFAULT 'auto',
  source_provider TEXT,
  tags            TEXT,
  install_count   INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at      TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_skills_api_key         ON skills(api_key_id);
CREATE INDEX IF NOT EXISTS idx_skills_name            ON skills(name);
CREATE INDEX IF NOT EXISTS idx_skills_mode            ON skills(mode);
CREATE INDEX IF NOT EXISTS idx_skills_source_provider ON skills(source_provider);

-- ============================================================================
-- Version manager / upstream proxy config
-- ============================================================================

CREATE TABLE IF NOT EXISTS version_manager (
  id                BIGSERIAL PRIMARY KEY,
  tool              TEXT NOT NULL UNIQUE,
  current_version   TEXT,
  installed_version TEXT,
  pinned_version    TEXT,
  binary_path       TEXT,
  status            TEXT NOT NULL DEFAULT 'not_installed',
  pid               INTEGER,
  port              INTEGER DEFAULT 8317,
  api_key           TEXT,
  management_key    TEXT,
  auto_update       INTEGER NOT NULL DEFAULT 1,
  auto_start        INTEGER NOT NULL DEFAULT 0,
  last_health_check TEXT,
  last_update_check TEXT,
  health_status     TEXT DEFAULT 'unknown',
  config_overrides  TEXT,
  error_message     TEXT,
  logs_buffer_path  TEXT,
  provider_expose   INTEGER NOT NULL DEFAULT 0,
  last_sync_at      TEXT,
  created_at        TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at        TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_vm_tool   ON version_manager(tool);
CREATE INDEX IF NOT EXISTS idx_vm_status ON version_manager(status);

CREATE TABLE IF NOT EXISTS upstream_proxy_config (
  id                        BIGSERIAL PRIMARY KEY,
  provider_id               TEXT NOT NULL UNIQUE,
  mode                      TEXT NOT NULL DEFAULT 'native',
  cliproxyapi_model_mapping TEXT,
  native_priority           INTEGER NOT NULL DEFAULT 1,
  cliproxyapi_priority      INTEGER NOT NULL DEFAULT 2,
  enabled                   INTEGER NOT NULL DEFAULT 1,
  created_at                TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at                TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_upc_provider ON upstream_proxy_config(provider_id);
CREATE INDEX IF NOT EXISTS idx_upc_mode     ON upstream_proxy_config(mode);

-- ============================================================================
-- Context handoffs / session model history
-- ============================================================================

CREATE TABLE IF NOT EXISTS context_handoffs (
  id                    TEXT PRIMARY KEY DEFAULT substr(md5(random()::text), 1, 16),
  session_id            TEXT NOT NULL,
  combo_name            TEXT NOT NULL,
  from_account          TEXT NOT NULL,
  summary               TEXT NOT NULL,
  key_decisions         TEXT NOT NULL DEFAULT '[]',
  task_progress         TEXT NOT NULL DEFAULT '',
  active_entities       TEXT NOT NULL DEFAULT '[]',
  message_count         INTEGER NOT NULL DEFAULT 0,
  model                 TEXT NOT NULL DEFAULT '',
  warning_threshold_pct DOUBLE PRECISION NOT NULL DEFAULT 0.85,
  generated_at          TEXT NOT NULL,
  expires_at            TEXT NOT NULL,
  last_model            TEXT,
  created_at            TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
);
CREATE INDEX IF NOT EXISTS idx_context_handoffs_session    ON context_handoffs(session_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_context_handoffs_expires    ON context_handoffs(expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_context_handoffs_session_combo ON context_handoffs(session_id, combo_name);
CREATE INDEX IF NOT EXISTS idx_context_handoffs_last_model ON context_handoffs(session_id, combo_name, last_model);

CREATE TABLE IF NOT EXISTS session_model_history (
  id            BIGSERIAL PRIMARY KEY,
  session_id    TEXT NOT NULL,
  combo_name    TEXT NOT NULL,
  model_str     TEXT NOT NULL,
  provider      TEXT NOT NULL,
  connection_id TEXT,
  used_at       TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_session_model_history_lookup  ON session_model_history(session_id, combo_name, used_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_model_history_cleanup ON session_model_history(used_at);

-- ============================================================================
-- Sync tokens
-- ============================================================================

CREATE TABLE IF NOT EXISTS sync_tokens (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  token_hash      TEXT NOT NULL UNIQUE,
  sync_api_key_id TEXT,
  revoked_at      TEXT,
  last_used_at    TEXT,
  created_at      TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at      TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_sync_tokens_created_at      ON sync_tokens(created_at);
CREATE INDEX IF NOT EXISTS idx_sync_tokens_last_used_at    ON sync_tokens(last_used_at);
CREATE INDEX IF NOT EXISTS idx_sync_tokens_revoked_at      ON sync_tokens(revoked_at);
CREATE INDEX IF NOT EXISTS idx_sync_tokens_sync_api_key_id ON sync_tokens(sync_api_key_id);

-- ============================================================================
-- Files / batches (batches FK -> files)
-- ============================================================================

CREATE TABLE IF NOT EXISTS files (
  id         TEXT PRIMARY KEY,
  bytes      BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  filename   TEXT NOT NULL,
  purpose    TEXT NOT NULL,
  content    BYTEA,
  mime_type  TEXT,
  api_key_id TEXT,
  deleted_at BIGINT,
  expires_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_files_api_key ON files(api_key_id);

CREATE TABLE IF NOT EXISTS batches (
  id                           TEXT PRIMARY KEY,
  endpoint                     TEXT NOT NULL,
  completion_window            TEXT NOT NULL,
  status                       TEXT NOT NULL,
  input_file_id                TEXT NOT NULL,
  output_file_id               TEXT,
  error_file_id                TEXT,
  created_at                   BIGINT NOT NULL,
  in_progress_at               BIGINT,
  expires_at                   BIGINT,
  finalizing_at                BIGINT,
  completed_at                 BIGINT,
  failed_at                    BIGINT,
  expired_at                   BIGINT,
  cancelling_at                BIGINT,
  cancelled_at                 BIGINT,
  request_counts_total         INTEGER DEFAULT 0,
  request_counts_completed     INTEGER DEFAULT 0,
  request_counts_failed        INTEGER DEFAULT 0,
  metadata                     TEXT,
  api_key_id                   TEXT,
  errors                       TEXT,
  model                        TEXT,
  usage                        TEXT,
  output_expires_after_seconds INTEGER,
  output_expires_after_anchor  TEXT,
  FOREIGN KEY(input_file_id)  REFERENCES files(id),
  FOREIGN KEY(output_file_id) REFERENCES files(id),
  FOREIGN KEY(error_file_id)  REFERENCES files(id)
);
CREATE INDEX IF NOT EXISTS idx_batches_api_key ON batches(api_key_id);
CREATE INDEX IF NOT EXISTS idx_batches_status  ON batches(status);

-- ============================================================================
-- Evals
-- ============================================================================

CREATE TABLE IF NOT EXISTS eval_runs (
  id            TEXT PRIMARY KEY,
  run_group_id  TEXT,
  suite_id      TEXT NOT NULL,
  suite_name    TEXT NOT NULL,
  target_type   TEXT NOT NULL,
  target_id     TEXT,
  target_label  TEXT NOT NULL,
  api_key_id    TEXT,
  pass_rate     INTEGER NOT NULL DEFAULT 0,
  total         INTEGER NOT NULL DEFAULT 0,
  passed        INTEGER NOT NULL DEFAULT 0,
  failed        INTEGER NOT NULL DEFAULT 0,
  avg_latency_ms INTEGER NOT NULL DEFAULT 0,
  summary_json  TEXT NOT NULL,
  results_json  TEXT NOT NULL,
  outputs_json  TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_eval_runs_suite_created_at ON eval_runs(suite_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_eval_runs_group_id         ON eval_runs(run_group_id);
CREATE INDEX IF NOT EXISTS idx_eval_runs_created_at        ON eval_runs(created_at DESC);

CREATE TABLE IF NOT EXISTS eval_suites (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_eval_suites_updated_at ON eval_suites(updated_at DESC);

CREATE TABLE IF NOT EXISTS eval_cases (
  id                TEXT PRIMARY KEY,
  suite_id          TEXT NOT NULL,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  name              TEXT NOT NULL,
  model             TEXT,
  input_json        TEXT NOT NULL,
  expected_strategy TEXT NOT NULL,
  expected_value    TEXT,
  tags_json         TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_eval_cases_suite_order ON eval_cases(suite_id, sort_order ASC, created_at ASC);

-- ============================================================================
-- Reasoning cache
-- ============================================================================

CREATE TABLE IF NOT EXISTS reasoning_cache (
  tool_call_id TEXT PRIMARY KEY,
  provider     TEXT NOT NULL,
  model        TEXT NOT NULL,
  reasoning    TEXT NOT NULL,
  char_count   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  expires_at   BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reasoning_cache_expires  ON reasoning_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_reasoning_cache_provider ON reasoning_cache(provider);
CREATE INDEX IF NOT EXISTS idx_reasoning_cache_model    ON reasoning_cache(model);
CREATE INDEX IF NOT EXISTS idx_reasoning_cache_created  ON reasoning_cache(created_at);

-- ============================================================================
-- Compression
-- ============================================================================

CREATE TABLE IF NOT EXISTS compression_analytics (
  id                           BIGSERIAL PRIMARY KEY,
  timestamp                    TEXT NOT NULL,
  combo_id                     TEXT,
  provider                     TEXT,
  mode                         TEXT NOT NULL,
  original_tokens              INTEGER NOT NULL,
  compressed_tokens            INTEGER NOT NULL,
  tokens_saved                 INTEGER NOT NULL,
  duration_ms                  INTEGER,
  request_id                   TEXT,
  actual_prompt_tokens         INTEGER,
  actual_completion_tokens     INTEGER,
  actual_total_tokens          INTEGER,
  actual_cache_read_tokens     INTEGER,
  actual_cache_write_tokens    INTEGER,
  estimated_usd_saved          DOUBLE PRECISION,
  mcp_description_tokens_saved INTEGER DEFAULT 0,
  multimodal_skip_count        INTEGER DEFAULT 0,
  receipt_source               TEXT,
  validation_fallback          INTEGER DEFAULT 0,
  output_mode                  TEXT
);
CREATE INDEX IF NOT EXISTS idx_compression_analytics_request_id         ON compression_analytics(request_id);
CREATE INDEX IF NOT EXISTS idx_compression_analytics_receipt_source     ON compression_analytics(receipt_source);
CREATE INDEX IF NOT EXISTS idx_compression_analytics_timestamp          ON compression_analytics(timestamp);
CREATE INDEX IF NOT EXISTS idx_compression_analytics_provider           ON compression_analytics(provider);
CREATE INDEX IF NOT EXISTS idx_compression_analytics_provider_timestamp ON compression_analytics(provider, timestamp);

CREATE TABLE IF NOT EXISTS compression_cache_stats (
  id                       BIGSERIAL PRIMARY KEY,
  provider                 TEXT NOT NULL,
  model                    TEXT NOT NULL DEFAULT '',
  compression_mode         TEXT NOT NULL,
  cache_control_present    INTEGER NOT NULL DEFAULT 0,
  estimated_cache_hit      INTEGER NOT NULL DEFAULT 0,
  tokens_saved_compression INTEGER NOT NULL DEFAULT 0,
  tokens_saved_caching     INTEGER NOT NULL DEFAULT 0,
  net_savings              INTEGER NOT NULL DEFAULT 0,
  created_at               TEXT DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_compression_cache_stats_provider ON compression_cache_stats(provider);
CREATE INDEX IF NOT EXISTS idx_compression_cache_stats_created  ON compression_cache_stats(created_at);

CREATE TABLE IF NOT EXISTS compression_combos (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  description           TEXT DEFAULT '',
  pipeline              TEXT NOT NULL DEFAULT '[]',
  language_packs        TEXT DEFAULT '["en"]',
  output_mode           INTEGER DEFAULT 0,
  output_mode_intensity TEXT DEFAULT 'full',
  is_default            INTEGER DEFAULT 0,
  created_at            TEXT DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at            TEXT DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_compression_combos_default ON compression_combos(is_default);

-- ============================================================================
-- Usage aggregation summaries
-- ============================================================================

CREATE TABLE IF NOT EXISTS hourly_usage_summary (
  id                  BIGSERIAL PRIMARY KEY,
  provider            TEXT NOT NULL,
  model               TEXT NOT NULL,
  date_hour           TEXT NOT NULL,
  total_requests      INTEGER NOT NULL DEFAULT 0,
  total_input_tokens  INTEGER NOT NULL DEFAULT 0,
  total_output_tokens INTEGER NOT NULL DEFAULT 0,
  total_cost          DOUBLE PRECISION NOT NULL DEFAULT 0.0,
  created_at          TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_hourly_usage_provider_model_date ON hourly_usage_summary(provider, model, date_hour);
CREATE INDEX IF NOT EXISTS idx_hourly_usage_date               ON hourly_usage_summary(date_hour);
CREATE INDEX IF NOT EXISTS idx_hourly_usage_provider_date      ON hourly_usage_summary(provider, date_hour);
CREATE INDEX IF NOT EXISTS idx_hourly_usage_model_date         ON hourly_usage_summary(model, date_hour);
CREATE INDEX IF NOT EXISTS idx_hourly_usage_provider_model_date_composite ON hourly_usage_summary(provider, model, date_hour);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hourly_usage_unique      ON hourly_usage_summary(provider, model, date_hour);

CREATE TABLE IF NOT EXISTS daily_usage_summary (
  id                  BIGSERIAL PRIMARY KEY,
  provider            TEXT NOT NULL,
  model               TEXT NOT NULL,
  date                TEXT NOT NULL,
  total_requests      INTEGER NOT NULL DEFAULT 0,
  total_input_tokens  INTEGER NOT NULL DEFAULT 0,
  total_output_tokens INTEGER NOT NULL DEFAULT 0,
  total_cost          DOUBLE PRECISION NOT NULL DEFAULT 0.0,
  created_at          TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_daily_usage_provider_model_date ON daily_usage_summary(provider, model, date);
CREATE INDEX IF NOT EXISTS idx_daily_usage_date               ON daily_usage_summary(date);
CREATE INDEX IF NOT EXISTS idx_daily_usage_provider_date      ON daily_usage_summary(provider, date);
CREATE INDEX IF NOT EXISTS idx_daily_usage_model_date         ON daily_usage_summary(model, date);
CREATE INDEX IF NOT EXISTS idx_daily_usage_provider_model_date_composite ON daily_usage_summary(provider, model, date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_usage_unique      ON daily_usage_summary(provider, model, date);

-- ============================================================================
-- Session account affinity
-- ============================================================================

CREATE TABLE IF NOT EXISTS session_account_affinity (
  session_key   TEXT NOT NULL,
  provider      TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  created_at    BIGINT NOT NULL,
  last_seen_at  BIGINT NOT NULL,
  PRIMARY KEY (session_key, provider)
);
CREATE INDEX IF NOT EXISTS idx_saa_provider  ON session_account_affinity(provider);
CREATE INDEX IF NOT EXISTS idx_saa_last_seen ON session_account_affinity(last_seen_at);

-- ============================================================================
-- Command code auth sessions
-- ============================================================================

CREATE TABLE IF NOT EXISTS command_code_auth_sessions (
  id                TEXT PRIMARY KEY,
  state_hash        TEXT NOT NULL UNIQUE,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'received', 'applied', 'expired')),
  encrypted_api_key TEXT,
  metadata_json     TEXT,
  created_at        TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  received_at       TEXT,
  applied_at        TEXT,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_command_code_auth_sessions_state_hash     ON command_code_auth_sessions(state_hash);
CREATE INDEX IF NOT EXISTS idx_command_code_auth_sessions_status_expires ON command_code_auth_sessions(status, expires_at);

-- ============================================================================
-- Tier config / assignments
-- ============================================================================

CREATE TABLE IF NOT EXISTS tier_config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS tier_assignments (
  provider           TEXT NOT NULL,
  model              TEXT NOT NULL,
  tier               TEXT NOT NULL CHECK (tier IN ('free', 'cheap', 'premium')),
  cost_per_1m_input  DOUBLE PRECISION DEFAULT 0,
  cost_per_1m_output DOUBLE PRECISION DEFAULT 0,
  has_free_tier      INTEGER DEFAULT 0,
  free_quota_limit   INTEGER,
  reason             TEXT,
  updated_at         TEXT DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (provider, model)
);
CREATE INDEX IF NOT EXISTS idx_tier_assignments_provider ON tier_assignments(provider);
CREATE INDEX IF NOT EXISTS idx_tier_assignments_tier     ON tier_assignments(tier);

-- ============================================================================
-- Gamification
-- ============================================================================

CREATE TABLE IF NOT EXISTS leaderboard (
  api_key_id TEXT NOT NULL,
  scope      TEXT NOT NULL DEFAULT 'global',
  score      INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (api_key_id, scope)
);
CREATE INDEX IF NOT EXISTS idx_leaderboard_scope_score ON leaderboard (scope, score DESC, api_key_id);

CREATE TABLE IF NOT EXISTS user_levels (
  api_key_id    TEXT PRIMARY KEY,
  total_xp      INTEGER NOT NULL DEFAULT 0,
  current_level INTEGER NOT NULL DEFAULT 1,
  updated_at    TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS badge_definitions (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  icon        TEXT,
  category    TEXT,
  rarity      TEXT NOT NULL DEFAULT 'common',
  criteria    TEXT,
  hidden      INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS user_badges (
  api_key_id  TEXT NOT NULL,
  badge_id    TEXT NOT NULL,
  unlocked_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (api_key_id, badge_id)
);
CREATE INDEX IF NOT EXISTS idx_user_badges_badge_id ON user_badges (badge_id);

CREATE TABLE IF NOT EXISTS xp_audit_log (
  id         BIGSERIAL PRIMARY KEY,
  api_key_id TEXT NOT NULL,
  action     TEXT NOT NULL,
  xp_earned  INTEGER NOT NULL,
  metadata   TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_xp_audit_log_api_key_created ON xp_audit_log (api_key_id, created_at);

CREATE TABLE IF NOT EXISTS token_ledger (
  id              BIGSERIAL PRIMARY KEY,
  from_api_key_id TEXT NOT NULL,
  to_api_key_id   TEXT NOT NULL,
  amount          INTEGER NOT NULL CHECK (amount > 0),
  reason          TEXT,
  idempotency_key TEXT UNIQUE,
  created_at      TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS invite_tokens (
  id         TEXT PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  used_by    TEXT,
  server_url TEXT,
  max_uses   INTEGER NOT NULL DEFAULT 1,
  use_count  INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_invite_tokens_code       ON invite_tokens (code);
CREATE INDEX IF NOT EXISTS idx_invite_tokens_token_hash ON invite_tokens (token_hash);

CREATE TABLE IF NOT EXISTS community_servers (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  url           TEXT NOT NULL,
  api_key_hash  TEXT NOT NULL,
  connected_at  TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  last_sync_at  TEXT,
  status        TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'disconnected', 'error')),
  error_message TEXT
);

-- ============================================================================
-- Cloud agent credentials
-- ============================================================================

CREATE TABLE IF NOT EXISTS cloud_agent_credentials (
  provider_id       TEXT PRIMARY KEY,
  api_key_encrypted TEXT NOT NULL,
  base_url          TEXT,
  updated_at        TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

-- ============================================================================
-- Middleware hooks (+ logs FK -> hooks)
-- ============================================================================

CREATE TABLE IF NOT EXISTS middleware_hooks (
  name        TEXT PRIMARY KEY,
  description TEXT NOT NULL DEFAULT '',
  priority    INTEGER NOT NULL DEFAULT 200,
  scope_type  TEXT NOT NULL DEFAULT 'global' CHECK(scope_type IN ('global', 'combo')),
  combo_id    TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  code        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at  TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  run_count   INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT
);
CREATE INDEX IF NOT EXISTS idx_middleware_hooks_scope   ON middleware_hooks(scope_type, combo_id);
CREATE INDEX IF NOT EXISTS idx_middleware_hooks_enabled ON middleware_hooks(enabled, priority);

-- ============================================================================
-- API key groups (+ children FK)
-- ============================================================================

CREATE TABLE IF NOT EXISTS key_groups (
  id          TEXT PRIMARY KEY NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at  TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

-- ============================================================================
-- Serverless relay proxies (+ children FK)
-- ============================================================================

CREATE TABLE IF NOT EXISTS relay_tokens (
  id                      TEXT PRIMARY KEY,
  name                    TEXT NOT NULL,
  token_hash              TEXT NOT NULL UNIQUE,
  token_prefix            TEXT NOT NULL,
  description             TEXT DEFAULT '',
  combo_id                TEXT,
  allowed_models          TEXT DEFAULT '[]',
  max_tokens_per_request  INTEGER DEFAULT 128000,
  max_requests_per_minute INTEGER DEFAULT 60,
  max_requests_per_day    INTEGER DEFAULT 10000,
  max_cost_per_day        DOUBLE PRECISION DEFAULT 0,
  enabled                 INTEGER DEFAULT 1,
  created_at              BIGINT NOT NULL,
  updated_at              BIGINT NOT NULL,
  expires_at              BIGINT,
  last_used_at            BIGINT,
  metadata                TEXT DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_relay_tokens_prefix ON relay_tokens(token_prefix);

-- ============================================================================
-- Free proxies catalog
-- ============================================================================

CREATE TABLE IF NOT EXISTS free_proxies (
  id             TEXT PRIMARY KEY,
  source         TEXT NOT NULL,
  host           TEXT NOT NULL,
  port           INTEGER NOT NULL,
  type           TEXT NOT NULL DEFAULT 'http',
  country_code   TEXT,
  quality_score  INTEGER,
  latency_ms     INTEGER,
  anonymity      TEXT,
  last_validated TEXT,
  in_pool        INTEGER DEFAULT 0,
  pool_proxy_id  TEXT,
  created_at     TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at     TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE(source, host, port)
);
CREATE INDEX IF NOT EXISTS idx_free_proxies_source  ON free_proxies(source);
CREATE INDEX IF NOT EXISTS idx_free_proxies_quality ON free_proxies(quality_score DESC);
CREATE INDEX IF NOT EXISTS idx_free_proxies_in_pool ON free_proxies(in_pool);

-- ============================================================================
-- Discovery results
-- ============================================================================

CREATE TABLE IF NOT EXISTS discovery_results (
  id            BIGSERIAL PRIMARY KEY,
  provider_id   TEXT NOT NULL,
  method        TEXT NOT NULL CHECK(method IN ('free_tier', 'web_cookie', 'auto_register', 'trial', 'public_api')),
  endpoint      TEXT,
  auth_type     TEXT CHECK(auth_type IN ('none', 'cookie', 'api_key', 'oauth')),
  models        TEXT,
  rate_limit    TEXT,
  feasibility   INTEGER CHECK(feasibility BETWEEN 1 AND 5),
  risk_level    TEXT CHECK(risk_level IN ('none', 'low', 'medium', 'high', 'critical')),
  status        TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'testing', 'verified', 'rejected')),
  notes         TEXT,
  discovered_at TEXT DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  verified_at   TEXT,
  UNIQUE(provider_id, method, endpoint)
);
CREATE INDEX IF NOT EXISTS idx_discovery_results_provider ON discovery_results(provider_id);
CREATE INDEX IF NOT EXISTS idx_discovery_results_status   ON discovery_results(status);

-- ============================================================================
-- Plugins
-- ============================================================================

CREATE TABLE IF NOT EXISTS plugins (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  version       TEXT NOT NULL DEFAULT '1.0.0',
  description   TEXT,
  author        TEXT,
  license       TEXT DEFAULT 'MIT',
  main          TEXT NOT NULL DEFAULT 'index.js',
  source        TEXT NOT NULL DEFAULT 'local',
  tags          TEXT DEFAULT '[]',
  status        TEXT NOT NULL DEFAULT 'installed' CHECK (status IN ('installed', 'active', 'inactive', 'error')),
  enabled       INTEGER NOT NULL DEFAULT 0,
  manifest      TEXT NOT NULL,
  config        TEXT DEFAULT '{}',
  config_schema TEXT DEFAULT '{}',
  hooks         TEXT DEFAULT '[]',
  permissions   TEXT DEFAULT '[]',
  plugin_dir    TEXT NOT NULL,
  error_message TEXT,
  installed_at  TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at    TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  activated_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_plugins_status  ON plugins(status);
CREATE INDEX IF NOT EXISTS idx_plugins_enabled ON plugins(enabled);
CREATE INDEX IF NOT EXISTS idx_plugins_name    ON plugins(name);

-- ============================================================================
-- FK-dependent child tables (parents are all created above)
-- ============================================================================

CREATE TABLE IF NOT EXISTS proxy_assignments (
  id         BIGSERIAL PRIMARY KEY,
  proxy_id   TEXT NOT NULL,
  scope      TEXT NOT NULL,
  scope_id   TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE(scope, scope_id),
  FOREIGN KEY (proxy_id) REFERENCES proxy_registry(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_proxy_assignments_proxy_id ON proxy_assignments(proxy_id);
CREATE INDEX IF NOT EXISTS idx_proxy_assignments_scope    ON proxy_assignments(scope, scope_id);

CREATE TABLE IF NOT EXISTS model_combo_mappings (
  id          TEXT PRIMARY KEY,
  pattern     TEXT NOT NULL,
  combo_id    TEXT NOT NULL,
  priority    INTEGER DEFAULT 0,
  enabled     INTEGER DEFAULT 1,
  description TEXT DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  FOREIGN KEY (combo_id) REFERENCES combos(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_mcm_enabled  ON model_combo_mappings(enabled);
CREATE INDEX IF NOT EXISTS idx_mcm_priority ON model_combo_mappings(priority DESC);

CREATE TABLE IF NOT EXISTS skill_executions (
  id            TEXT PRIMARY KEY,
  skill_id      TEXT NOT NULL,
  api_key_id    TEXT NOT NULL,
  session_id    TEXT,
  input         TEXT NOT NULL,
  output        TEXT,
  status        TEXT NOT NULL CHECK(status IN ('pending', 'running', 'success', 'error', 'timeout')),
  error_message TEXT,
  duration_ms   INTEGER,
  created_at    TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_skill_executions_skill   ON skill_executions(skill_id);
CREATE INDEX IF NOT EXISTS idx_skill_executions_api_key ON skill_executions(api_key_id);
CREATE INDEX IF NOT EXISTS idx_skill_executions_status  ON skill_executions(status);
CREATE INDEX IF NOT EXISTS idx_skill_executions_created ON skill_executions(created_at);

CREATE TABLE IF NOT EXISTS compression_combo_assignments (
  id                   TEXT PRIMARY KEY,
  compression_combo_id TEXT NOT NULL REFERENCES compression_combos(id) ON DELETE CASCADE,
  routing_combo_id     TEXT NOT NULL,
  created_at           TEXT DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE(routing_combo_id)
);
CREATE INDEX IF NOT EXISTS idx_compression_combo_assignments_combo   ON compression_combo_assignments(compression_combo_id);
CREATE INDEX IF NOT EXISTS idx_compression_combo_assignments_routing ON compression_combo_assignments(routing_combo_id);

CREATE TABLE IF NOT EXISTS group_model_permissions (
  id            TEXT PRIMARY KEY NOT NULL,
  group_id      TEXT NOT NULL,
  model_pattern TEXT NOT NULL,
  provider      TEXT,
  access_type   TEXT NOT NULL DEFAULT 'allow' CHECK(access_type IN ('allow', 'deny')),
  created_at    TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  FOREIGN KEY (group_id) REFERENCES key_groups(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_group_permissions_group ON group_model_permissions(group_id);

CREATE TABLE IF NOT EXISTS key_group_members (
  key_id     TEXT NOT NULL,
  group_id   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (key_id, group_id),
  FOREIGN KEY (group_id) REFERENCES key_groups(id) ON DELETE CASCADE,
  FOREIGN KEY (key_id)   REFERENCES api_keys(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_group_members_key   ON key_group_members(key_id);
CREATE INDEX IF NOT EXISTS idx_group_members_group ON key_group_members(group_id);

CREATE TABLE IF NOT EXISTS middleware_logs (
  id          TEXT PRIMARY KEY NOT NULL,
  hook_name   TEXT NOT NULL,
  request_id  TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  mutated     INTEGER NOT NULL DEFAULT 0,
  skipped     INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  timestamp   TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  FOREIGN KEY (hook_name) REFERENCES middleware_hooks(name) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_middleware_logs_hook    ON middleware_logs(hook_name, timestamp);
CREATE INDEX IF NOT EXISTS idx_middleware_logs_request ON middleware_logs(request_id, timestamp);

CREATE TABLE IF NOT EXISTS relay_rate_limits (
  token_id      TEXT NOT NULL,
  window_start  BIGINT NOT NULL,
  request_count INTEGER DEFAULT 0,
  cost          DOUBLE PRECISION DEFAULT 0,
  PRIMARY KEY (token_id, window_start),
  FOREIGN KEY (token_id) REFERENCES relay_tokens(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_relay_rate_limits_window ON relay_rate_limits(token_id, window_start);

CREATE TABLE IF NOT EXISTS relay_logs (
  id                BIGSERIAL PRIMARY KEY,
  token_id          TEXT NOT NULL,
  request_id        TEXT,
  model             TEXT,
  prompt_tokens     INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  cost              DOUBLE PRECISION DEFAULT 0,
  status            TEXT DEFAULT 'success',
  status_code       INTEGER DEFAULT 200,
  latency_ms        INTEGER DEFAULT 0,
  client_ip         TEXT,
  user_agent        TEXT,
  created_at        BIGINT NOT NULL,
  FOREIGN KEY (token_id) REFERENCES relay_tokens(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_relay_logs_token   ON relay_logs(token_id, created_at);
CREATE INDEX IF NOT EXISTS idx_relay_logs_created ON relay_logs(created_at);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id               BIGSERIAL PRIMARY KEY,
  webhook_id       TEXT NOT NULL,
  event_type       TEXT NOT NULL,
  status           TEXT NOT NULL,
  http_status      INTEGER,
  latency_ms       INTEGER,
  error            TEXT,
  payload_snapshot TEXT,
  created_at       TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  FOREIGN KEY (webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook_created ON webhook_deliveries(webhook_id, created_at DESC);

CREATE TABLE IF NOT EXISTS api_key_token_limits (
  id             TEXT PRIMARY KEY,
  api_key_id     TEXT NOT NULL,
  scope_type     TEXT NOT NULL CHECK (scope_type IN ('model', 'provider', 'global')),
  scope_value    TEXT NOT NULL DEFAULT '',
  token_limit    INTEGER NOT NULL CHECK (token_limit > 0),
  reset_interval TEXT NOT NULL DEFAULT 'monthly' CHECK (reset_interval IN ('daily', 'weekly', 'monthly')),
  reset_time     TEXT,
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at     TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (api_key_id, scope_type, scope_value)
);
CREATE INDEX IF NOT EXISTS idx_aktl_api_key_id ON api_key_token_limits (api_key_id);

CREATE TABLE IF NOT EXISTS api_key_token_counters (
  limit_id     TEXT NOT NULL,
  window_start TEXT NOT NULL,
  tokens_used  INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (limit_id, window_start),
  FOREIGN KEY (limit_id) REFERENCES api_key_token_limits (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS api_key_token_limit_reset_logs (
  id           BIGSERIAL PRIMARY KEY,
  limit_id     TEXT NOT NULL,
  reset_at     TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  prev_tokens  INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL,
  FOREIGN KEY (limit_id) REFERENCES api_key_token_limits (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_aktlrl_limit_id ON api_key_token_limit_reset_logs (limit_id);

-- ============================================================================
-- Seed data
-- ============================================================================

-- Default compression combo (RTK + Caveman pipeline) — final state after 042/043.
INSERT INTO compression_combos (
  id, name, description, pipeline, language_packs, output_mode, output_mode_intensity, is_default
)
VALUES (
  'default-caveman',
  'Standard Savings',
  'Default RTK + Caveman compression pipeline',
  '[{"engine":"rtk","intensity":"standard"},{"engine":"caveman","intensity":"full"}]',
  '["en"]',
  0,
  'full',
  1
)
ON CONFLICT (id) DO NOTHING;

-- Schema version stamp.
INSERT INTO db_meta (key, value) VALUES ('schema_version', '1')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

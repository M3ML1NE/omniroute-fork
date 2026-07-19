-- 0014_purge_named_provider_data.sql
--
-- Hard-deletes every provider-linked row whose provider identifier is NOT one
-- of the two supported compatible types (`openai-compatible-*` /
-- `gigachat-compatible-*`). This is the destructive data-side counterpart to the
-- code-side named-provider purge — after this migration the database physically
-- refuses to retain data for any removed named provider.
--
-- Transaction semantics:
--   The migration runner (src/lib/db/migrationRunner.ts) wraps each file in its
--   own BEGIN/COMMIT (ROLLBACK on error) — do NOT add manual BEGIN/COMMIT here.
--   Every statement below therefore runs atomically as one unit.
--
-- Order (the audit record is written BEFORE any deletion):
--   1. Insert a `migration.purge_named_providers` audit_log row summarizing the
--      pre-deletion row counts per affected table (computed in a single CTE so
--      the counts reflect state before any DELETE runs).
--   2..9. DELETE the non-compatible rows from each provider-linked table.
--   10. DELETE the provider-linked historical audit_log rows (never the purge
--       record itself, never generic/administrative rows).
--
-- Idempotency guarantee:
--   Every DELETE ... WHERE is naturally idempotent — a second run finds zero
--   matching rows and performs no work. The audit INSERT is additive (a second
--   run simply appends another 'started' record documenting a zero-row purge).
--
-- Destructiveness warning:
--   Irreversible. There is intentionally NO down-migration (matching the 0012 /
--   0013 one-directional precedent). Recovery is only possible from a backup
--   taken before this migration.
--
-- Column names verified against 0001_baseline.sql:
--   provider_connections.provider, provider_nodes.type, usage_history.provider,
--   call_logs.provider, request_detail_logs.provider,
--   routing_decisions.provider_selected, combo_adaptation_state.provider_id,
--   registered_keys.provider, audit_log.(resource_type,target,action).
--
-- `proxy_logs` is absent by design: 0004_drop_dead_subsystems.sql drops it, and
-- this file runs afterwards, so any reference would raise
-- `relation "proxy_logs" does not exist`.
--
-- Not touched: quota_snapshots (already dropped in 0002), combos/combos.data,
-- and any audit_log row whose resource_type is not 'provider_connections'.

-- 1. Pre-deletion audit record with per-table row-count summary.
INSERT INTO audit_log (timestamp, action, actor, target, details, resource_type, status)
SELECT
  to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  'migration.purge_named_providers',
  'system',
  'provider_connections',
  json_build_object(
    'provider_connections', (
      SELECT COUNT(*) FROM provider_connections
      WHERE provider !~ '^(gigachat-compatible-|openai-compatible-).+'
    ),
    'provider_nodes', (
      SELECT COUNT(*) FROM provider_nodes
      WHERE type NOT IN ('gigachat-compatible', 'openai-compatible')
    ),
    'usage_history', (
      SELECT COUNT(*) FROM usage_history
      WHERE provider IS NOT NULL
        AND provider !~ '^(gigachat-compatible-|openai-compatible-).+'
    ),
    'call_logs', (
      SELECT COUNT(*) FROM call_logs
      WHERE provider IS NOT NULL
        AND provider !~ '^(gigachat-compatible-|openai-compatible-).+'
    ),
    'request_detail_logs', (
      SELECT COUNT(*) FROM request_detail_logs
      WHERE provider IS NOT NULL
        AND provider !~ '^(gigachat-compatible-|openai-compatible-).+'
    ),
    'routing_decisions', (
      SELECT COUNT(*) FROM routing_decisions
      WHERE provider_selected IS NOT NULL
        AND provider_selected !~ '^(gigachat-compatible-|openai-compatible-).+'
    ),
    'combo_adaptation_state', (
      SELECT COUNT(*) FROM combo_adaptation_state
      WHERE provider_id !~ '^(gigachat-compatible-|openai-compatible-).+'
    ),
    'registered_keys', (
      SELECT COUNT(*) FROM registered_keys
      WHERE provider <> ''
        AND provider !~ '^(gigachat-compatible-|openai-compatible-).+'
    ),
    'audit_log', (
      SELECT COUNT(*) FROM audit_log
      WHERE resource_type = 'provider_connections'
        AND target IS NOT NULL
        AND target !~ '^(gigachat-compatible-|openai-compatible-).+'
        AND action <> 'migration.purge_named_providers'
    )
  )::text,
  'provider_connections',
  'started';

-- 2. provider_connections — the primary provider registry.
DELETE FROM provider_connections
WHERE provider !~ '^(gigachat-compatible-|openai-compatible-).+';

-- 3. provider_nodes — keyed by the node `type`, not a provider string.
DELETE FROM provider_nodes
WHERE type NOT IN ('gigachat-compatible', 'openai-compatible');

-- 4. usage_history — provider may be NULL (aggregate rows); leave NULLs alone.
DELETE FROM usage_history
WHERE provider IS NOT NULL
  AND provider !~ '^(gigachat-compatible-|openai-compatible-).+';

-- 5. call_logs.
DELETE FROM call_logs
WHERE provider IS NOT NULL
  AND provider !~ '^(gigachat-compatible-|openai-compatible-).+';

-- 6. request_detail_logs.
DELETE FROM request_detail_logs
WHERE provider IS NOT NULL
  AND provider !~ '^(gigachat-compatible-|openai-compatible-).+';

-- 7. routing_decisions — provider column is `provider_selected`.
DELETE FROM routing_decisions
WHERE provider_selected IS NOT NULL
  AND provider_selected !~ '^(gigachat-compatible-|openai-compatible-).+';

-- 8. combo_adaptation_state — provider column is `provider_id` (NOT NULL).
DELETE FROM combo_adaptation_state
WHERE provider_id !~ '^(gigachat-compatible-|openai-compatible-).+';

-- 9. registered_keys — skip provider = '' (generic keys, not a purge target).
DELETE FROM registered_keys
WHERE provider <> ''
  AND provider !~ '^(gigachat-compatible-|openai-compatible-).+';

-- 10. audit_log — only provider-linked historical rows. Never the purge record
--     itself, never a row with any other resource_type.
DELETE FROM audit_log
WHERE resource_type = 'provider_connections'
  AND target !~ '^(gigachat-compatible-|openai-compatible-).+'
  AND action <> 'migration.purge_named_providers';

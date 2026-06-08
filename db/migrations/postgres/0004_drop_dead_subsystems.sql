-- 0004_drop_dead_subsystems.sql
-- Drop tables owned by subsystems removed from the GigaChat fork: the
-- proxy/1proxy/upstream-proxy registry, gamification, plugins, cloud agents,
-- and the CLI version-manager. Idempotent (IF EXISTS ... CASCADE), so it is
-- safe to re-run and on databases where the tables were never created.
--
-- KEPT (intentionally NOT dropped): eval_runs / eval_suites / eval_cases — the
-- eval-routing feature is live (combo target ordering via evalRouting).

-- Proxy subsystem
DROP TABLE IF EXISTS proxy_assignments CASCADE;
DROP TABLE IF EXISTS proxy_logs CASCADE;
DROP TABLE IF EXISTS proxy_registry CASCADE;
DROP TABLE IF EXISTS upstream_proxy_config CASCADE;
DROP TABLE IF EXISTS free_proxies CASCADE;

-- Gamification subsystem
DROP TABLE IF EXISTS leaderboard CASCADE;
DROP TABLE IF EXISTS user_levels CASCADE;
DROP TABLE IF EXISTS xp_audit_log CASCADE;
DROP TABLE IF EXISTS badge_definitions CASCADE;
DROP TABLE IF EXISTS user_badges CASCADE;
DROP TABLE IF EXISTS token_ledger CASCADE;
DROP TABLE IF EXISTS invite_tokens CASCADE;
DROP TABLE IF EXISTS community_servers CASCADE;
DROP TABLE IF EXISTS discovery_results CASCADE;

-- Plugins subsystem
DROP TABLE IF EXISTS plugins CASCADE;

-- Cloud agents subsystem
DROP TABLE IF EXISTS cloud_agent_credentials CASCADE;

-- CLI version-manager subsystem
DROP TABLE IF EXISTS version_manager CASCADE;

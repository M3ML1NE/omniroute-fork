-- 0002_drop_unused_features.sql
-- Drop tables for features removed from the GigaChat fork:
--   - Webhooks subsystem (webhooks, webhook_deliveries)
--   - Quota snapshots (quota_snapshots)
--   - Skills framework (skills, skill_executions)
--
-- CASCADE handles dependent indexes, foreign keys, and constraints automatically.
-- Idempotent: IF EXISTS ensures safe re-application.

DROP TABLE IF EXISTS webhook_deliveries CASCADE;
DROP TABLE IF EXISTS webhooks CASCADE;
DROP TABLE IF EXISTS quota_snapshots CASCADE;
DROP TABLE IF EXISTS skill_executions CASCADE;
DROP TABLE IF EXISTS skills CASCADE;

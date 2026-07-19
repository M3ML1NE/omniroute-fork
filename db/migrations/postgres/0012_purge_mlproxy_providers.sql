-- 0012_purge_mlproxy_providers.sql
-- Delete mlproxy and mlspace provider connections.
-- Idempotent: DELETE WHERE is a no-op when rows are absent.
-- Preserves openai-compatible and gigachat-compatible rows.

DELETE FROM provider_connections
WHERE provider IN ('mlproxy', 'mlspace');

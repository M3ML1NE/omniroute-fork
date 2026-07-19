-- 0016_provider_node_api_version.sql
-- Per-node GigaChat API version ("v1" | "v2") for gigachat-compatible provider
-- nodes. NULL means legacy behaviour (treated as v1 at read time), so existing
-- rows are untouched. Cascaded into each connection's providerSpecificData.
-- Idempotent.
ALTER TABLE provider_nodes ADD COLUMN IF NOT EXISTS api_version TEXT;

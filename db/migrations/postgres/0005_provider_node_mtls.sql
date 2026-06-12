-- 0005_provider_node_mtls.sql
-- GigaChat-compatible (mTLS) support for provider_nodes: mtls_json holds the
-- cert/key/ca file paths cascaded into each connection's providerSpecificData.
-- Idempotent.
ALTER TABLE provider_nodes ADD COLUMN IF NOT EXISTS mtls_json TEXT;

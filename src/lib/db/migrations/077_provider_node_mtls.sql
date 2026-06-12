-- GigaChat-compatible (mTLS) support for provider_nodes: mtls_json stores the
-- cert/key/ca file paths cascaded into each connection's providerSpecificData.
-- NULL = ordinary openai-compatible node (backward compatible).
ALTER TABLE provider_nodes ADD COLUMN mtls_json TEXT;

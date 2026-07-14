-- 0008_drop_tunnel_settings.sql
-- The tunnel toggles (Cloudflare/Tailscale/ngrok) were removed from the UI,
-- Settings type, and Zod schema (getSettings merges every row from key_value
-- blindly, so stale rows would keep resurrecting these fields even after the
-- code-level removal). Purge any persisted rows for the retired keys.
-- Schema-agnostic: no hardcoded schema prefix — the migration runner sets
-- search_path before running this file, so the unqualified table name
-- resolves through it. Idempotent: deleting already-deleted/absent rows is a
-- no-op, safe to re-run.
DELETE FROM key_value
WHERE namespace = 'settings'
  AND key IN (
    'hideEndpointCloudflaredTunnel',
    'hideEndpointTailscaleFunnel',
    'hideEndpointNgrokTunnel',
    'tailscaleEnabled',
    'tailscaleUrl'
  );

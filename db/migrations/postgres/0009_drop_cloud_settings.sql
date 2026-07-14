-- 0009_drop_cloud_settings.sql
-- The direct cloud-relay config surfaces (cloudEnabled/cloudUrl, plus the
-- src/shared/utils/cloud.ts helper that used them) were removed from the UI,
-- Settings type, and Zod schemas (getSettings merges every row from
-- key_value blindly, so stale rows would keep resurrecting these fields even
-- after the code-level removal — see 0008's identical rationale for the
-- tunnel toggles). Purge any persisted rows for the retired keys.
-- Schema-agnostic: no hardcoded schema prefix — the migration runner sets
-- search_path before running this file, so the unqualified table name
-- resolves through it. Idempotent: deleting already-deleted/absent rows is a
-- no-op, safe to re-run.
-- NOTE: created as a NEW file rather than extending 0008 because the runner
-- (src/lib/db/migrationRunner.ts) tracks applied migrations by filename only
-- (PRIMARY KEY(filename), INSERT ... ON CONFLICT (filename) DO NOTHING) — 0008
-- was already applied and recorded against omniroute_test in this session, so
-- editing its file content in place would NOT re-execute against that DB.
DELETE FROM key_value
WHERE namespace = 'settings'
  AND key IN (
    'cloudEnabled',
    'cloudUrl'
  );

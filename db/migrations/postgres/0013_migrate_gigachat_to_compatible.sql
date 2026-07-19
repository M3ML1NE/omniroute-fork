-- 0013_migrate_gigachat_to_compatible.sql
--
-- Converts every bare `gigachat` provider connection to
-- `gigachat-compatible-<connection-id>`, preserving all other fields.
--
-- Idempotency guarantee:
--   `WHERE provider = 'gigachat'` naturally excludes rows already renamed to
--   `gigachat-compatible-*` on a second run — no rows match, no-op.
--
-- Collision safety:
--   The target name is `gigachat-compatible-<id>`. If a row with that
--   provider value already exists (edge case: manual entry / prior partial
--   migration), a deterministic suffix `-2` is appended, then `-3`, then
--   `-4`. Final fallback `gigachat-compatible-<id>-<id>` is always unique
--   because `id` is the primary key. In practice `id` is a UUID/CUID so
--   collisions are astronomically unlikely; the ladder is belt-and-suspenders.

UPDATE provider_connections AS pc
SET
  provider = CASE
    -- Preferred target: gigachat-compatible-<id>
    WHEN NOT EXISTS (
      SELECT 1 FROM provider_connections AS chk
      WHERE chk.provider = 'gigachat-compatible-' || pc.id
        AND chk.id != pc.id
    )
      THEN 'gigachat-compatible-' || pc.id

    -- First collision: gigachat-compatible-<id>-2
    WHEN NOT EXISTS (
      SELECT 1 FROM provider_connections AS chk
      WHERE chk.provider = 'gigachat-compatible-' || pc.id || '-2'
        AND chk.id != pc.id
    )
      THEN 'gigachat-compatible-' || pc.id || '-2'

    -- Second collision: gigachat-compatible-<id>-3
    WHEN NOT EXISTS (
      SELECT 1 FROM provider_connections AS chk
      WHERE chk.provider = 'gigachat-compatible-' || pc.id || '-3'
        AND chk.id != pc.id
    )
      THEN 'gigachat-compatible-' || pc.id || '-3'

    -- Third collision: gigachat-compatible-<id>-4
    WHEN NOT EXISTS (
      SELECT 1 FROM provider_connections AS chk
      WHERE chk.provider = 'gigachat-compatible-' || pc.id || '-4'
        AND chk.id != pc.id
    )
      THEN 'gigachat-compatible-' || pc.id || '-4'

    -- Fallback (extremely unlikely): gigachat-compatible-<id>-<id>, always
    -- unique because id is the primary key.
    ELSE 'gigachat-compatible-' || pc.id || '-' || pc.id
  END,
  updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
WHERE pc.provider = 'gigachat';

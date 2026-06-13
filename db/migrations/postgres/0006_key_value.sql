-- 0006_key_value.sql
-- Backfill the key_value table for databases that recorded 0001_baseline.sql as
-- applied BEFORE key_value was added to that baseline (the migration runner
-- tracks files by filename, so an edited baseline is never re-applied). Without
-- this, getCustomModelRow / getModelIsHidden and every key_value-backed setting
-- fail with: relation "key_value" does not exist (42P01).
-- Idempotent (IF NOT EXISTS): a no-op on databases that already have the table.
CREATE TABLE IF NOT EXISTS key_value (
  namespace TEXT NOT NULL,
  key       TEXT NOT NULL,
  value     TEXT NOT NULL,
  PRIMARY KEY (namespace, key)
);

-- 0015_purge_combo_provider_steps.sql
--
-- Purge named-provider model steps from combo routing configs.
--
-- CONTEXT: `combos.data` is a TEXT column holding `JSON.stringify(combo)` — the
-- FULL combo object, not a bare steps array. The steps live under the top-level
-- `models` key (verified against real serialized rows: `createCombo()` /
-- `normalizeComboRecord()` in src/lib/combos/steps.ts write
-- `models: normalizeComboModels(...)`). Each element is either a
-- `ComboModelStep` (`kind: "model"`, with `providerId`) or a `ComboRefStep`
-- (`kind: "combo-ref"`, referencing another combo by name — NO providerId).
--
-- GOAL:
--   (1) Cast `combos.data` to jsonb.
--   (2) For every combo, drop any `models[]` element where
--       `kind = 'model'` AND `providerId` does NOT match
--       `^(gigachat-compatible-|openai-compatible-).+` (a purged named provider).
--   (3) Keep every `kind = 'combo-ref'` element untouched — combo-refs point at
--       other combos by name, not a provider; their validity is resolved at
--       runtime (catalog.ts) and is out of scope here.
--   (4) Write the filtered array back into `data->'models'`.
--   (5) Delete any combo left with zero remaining steps (zero model steps AND
--       zero combo-ref steps) after filtering.
--
-- IDEMPOTENCY:
--   Re-running is a no-op: surviving elements already match the keep-predicate,
--   so the UPDATE rewrites an identical `models` array and the DELETE finds no
--   zero-length arrays it did not already remove.
--
-- SAFETY:
--   `jsonb_typeof(... ->'models') = 'array'` guards against malformed rows whose
--   `models` key is absent or JSON `null` (a scalar) — `jsonb_array_elements`
--   raises "cannot extract elements from a scalar" on those, so they are skipped
--   entirely (neither filtered nor deleted). Only well-formed array combos are
--   touched. This migration touches ONLY the `combos` table.

-- (2)–(4): rebuild each combo's `models` array from the surviving elements.
-- A combo that loses ALL its elements aggregates to NULL (FILTER excludes every
-- row); COALESCE(..., '[]'::jsonb) normalizes that to an empty array so the
-- follow-up DELETE can surface it. `WITH ORDINALITY` + `ORDER BY ord` preserves
-- the original step order.
UPDATE combos AS c
SET data = jsonb_set(c.data::jsonb, '{models}', COALESCE(f.filtered_steps, '[]'::jsonb))::text
FROM (
  SELECT
    c2.id,
    jsonb_agg(elem ORDER BY ord) FILTER (
      WHERE elem->>'kind' <> 'model'
         OR elem->>'providerId' ~ '^(gigachat-compatible-|openai-compatible-).+'
    ) AS filtered_steps
  FROM combos AS c2,
       jsonb_array_elements(c2.data::jsonb->'models') WITH ORDINALITY AS a(elem, ord)
  WHERE jsonb_typeof(c2.data::jsonb->'models') = 'array'
  GROUP BY c2.id
) AS f
WHERE c.id = f.id;

-- (5): delete combos left with zero steps after filtering. Only well-formed
-- array-shaped `models` are considered — malformed (missing / null) rows are
-- left untouched rather than deleted.
DELETE FROM combos
WHERE jsonb_typeof(data::jsonb->'models') = 'array'
  AND jsonb_array_length(data::jsonb->'models') = 0;

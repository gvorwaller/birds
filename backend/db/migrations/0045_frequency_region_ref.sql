-- The region-reference invariant (refactor plan Phase 4,
-- docs/2026-08-30-regions-reference-data-refactor-plan.md).
--
-- Every loc_kind='region' row is anchored to seeded reference geography:
--   country / subnational1  -> itself must exist in regions
--   subnational2 (county)   -> its PARENT STATE must exist in regions
--   hotspots (L-ids)        -> NULL, outside the invariant
-- Anchoring counties to their parent (CODEX1 P1-4) covers all region rows
-- (3,664/3,664 on prod at design time) instead of the 205 a NULL-bypass
-- design would have covered; a county still never pretends to have its own
-- centroid. Verified on prod: every region code matches the 1-3 segment
-- grammar, every county's parent is a seeded subnational1, and ZERO hotspot
-- codes collide with the region grammar.
--
-- The shape CHECK makes the malformed-code escape hatch unrepresentable: a
-- region row whose code fits none of the CASE arms cannot exist at all.
--
-- ADD COLUMN ... STORED rewrites the table under AccessExclusiveLock —
-- ~8,400 rows, sub-second. textregexeq is IMMUTABLE (provolatile=i), so the
-- regexes are legal in a generated column. NO ON DELETE/ON UPDATE clause,
-- deliberately: PG17 rejects certain referential actions on constraints
-- containing generated columns; default NO ACTION is legal and is also the
-- semantics we want (a regions row referenced by data can never be deleted).
--
-- Pre-flight (run against prod, must return zero rows, BEFORE deploying):
--   SELECT DISTINCT CASE WHEN loc_code ~ '^[A-Z]{2}(-[A-Z0-9]+)?$' THEN loc_code
--                        ELSE substring(loc_code from '^[A-Z]{2}-[A-Z0-9]+') END
--     FROM frequency_fetch WHERE loc_kind='region'
--       AND (CASE WHEN loc_code ~ '^[A-Z]{2}(-[A-Z0-9]+)?$' THEN loc_code
--                 ELSE substring(loc_code from '^[A-Z]{2}-[A-Z0-9]+') END)
--           NOT IN (SELECT code FROM regions);
--
-- No BEGIN/COMMIT: migrate_pg.sh wraps each file (see 0043 header).

ALTER TABLE frequency_fetch
  ADD CONSTRAINT frequency_fetch_region_shape
    CHECK (loc_kind <> 'region' OR loc_code ~ '^[A-Z]{2}(-[A-Z0-9]+){0,2}$');

ALTER TABLE frequency_fetch ADD COLUMN region_ref TEXT GENERATED ALWAYS AS (
    CASE
      WHEN loc_kind <> 'region' THEN NULL
      WHEN loc_code ~ '^[A-Z]{2}(-[A-Z0-9]+)?$' THEN loc_code
      WHEN loc_code ~ '^[A-Z]{2}(-[A-Z0-9]+){2}$'
        THEN substring(loc_code from '^[A-Z]{2}-[A-Z0-9]+')
    END
) STORED;

ALTER TABLE frequency_fetch
  ADD CONSTRAINT frequency_fetch_region_fk
    FOREIGN KEY (region_ref) REFERENCES regions(code);

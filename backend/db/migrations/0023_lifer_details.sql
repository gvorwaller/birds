-- 0023: life-list detail columns (td-b5986c, plan
-- docs/2026-08-19-life-list-map-plan-CC1.md, GROK pin 3).
-- The eBird life-list CSV carries per-lifer location/checklist/state data the
-- parser used to drop. 1:1 with the seen_species row — no join table. All
-- nullable: manual and pre-migration rows simply have NULLs (no backfill).
-- loc_checked_at persists the negative when BOTH live lookups (hotspot info,
-- checklist view) failed for the row's loc_id, so later syncs don't retry
-- forever (GROK pin 2).

ALTER TABLE seen_species
    ADD COLUMN csv_row_num   integer,
    ADD COLUMN taxon_order   numeric,
    ADD COLUMN category      text,
    ADD COLUMN obs_count     integer,
    ADD COLUMN location_name text,
    ADD COLUMN loc_id        text,
    ADD COLUMN region_code   text,
    ADD COLUMN sub_id        text,
    ADD COLUMN exotic        text,
    ADD COLUMN countable     boolean,
    ADD COLUMN loc_checked_at timestamptz;

CREATE INDEX seen_species_loc_id_idx
    ON seen_species (loc_id) WHERE loc_id IS NOT NULL;

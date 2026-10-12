-- td-c2f2b2: durable coordinates for every downloaded hotspot (plan:
-- docs/2026-10-11-durable-hotspot-coordinates-plan.md, revision 2).
--
-- eBird's hotspot lists carry each hotspot's coordinates, but they lived only
-- in ebird_cache, which pruneEbirdCache deletes after 48 hours. 1,669 of 7,428
-- downloaded hotspots had durable coordinates (prod, 2026-10-12), so the Field
-- Guide and Hotspots & data map searches missed most of them.
--
--  1. Coordinate provenance on ebird_locations. updated_at is also moved by
--     observation feeds and Google place results, so it cannot order
--     coordinate writes (CODEX1 P1-1):
--       * coord_source      'official' (an eBird hotspot list or hotspot info)
--                           or 'observation' (observation feeds, a life-list
--                           checklist). Existing rows are 'observation': their
--                           source was not recorded, and the repair job
--                           upgrades every downloaded hotspot to 'official'.
--       * coord_fetched_at  when the official request that supplied the
--                           coordinate STARTED; NULL for observation rows.
--     Precedence (hotspot-coordinates.ts, the one writer): official replaces
--     observation always and official only when its request started later;
--     observation never replaces official.
--  2. hotspot_coord_misses: downloaded hotspots eBird no longer describes as a
--     hotspot (404, or info that is not a hotspot). Retried after 30 days;
--     removed when official coordinates arrive.
--  3. jobs_type_check gains repair_hotspot_coords.
--
-- Wrapped in one transaction by migrate_pg.sh. No table rewrite (constant
-- defaults). The jobs constraint swap and the misses FK take strong locks on
-- jobs and frequency_fetch; a 5 s lock_timeout aborts the whole migration
-- (nothing applied, deploy stops before the PM2 reload) instead of queueing
-- every reader behind a long wait. Retry the deploy.
SET LOCAL lock_timeout = '5s';

ALTER TABLE ebird_locations
	ADD COLUMN coord_source text NOT NULL DEFAULT 'observation'
		CONSTRAINT ebird_locations_coord_source_check CHECK (coord_source IN ('official', 'observation')),
	ADD COLUMN coord_fetched_at timestamptz,
	ADD CONSTRAINT ebird_locations_official_fetched_check
		CHECK ((coord_source = 'official') = (coord_fetched_at IS NOT NULL));

CREATE TABLE hotspot_coord_misses (
	loc_code text PRIMARY KEY REFERENCES frequency_fetch (loc_code) ON DELETE CASCADE,
	reason text NOT NULL CHECK (reason IN ('gone', 'not_hotspot')),
	checked_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON hotspot_coord_misses FROM birds_app, PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON hotspot_coord_misses TO birds_app;

ALTER TABLE jobs DROP CONSTRAINT jobs_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_type_check CHECK (type IN
	('load_hotspots','load_region','analyze_counties','refresh_loc','retry_loc','sync_lifelist',
	 'sync_taxonomy','scan_need_alerts','enrich_species','scan_enrichment','enrich_species_media',
	 'enrich_species_inat','enrich_families','tag_repair',
	 'tag_consistency','tag_stage','tag_benchmark','tag_activate','tag_retire','tag_rollback',
	 'tag_draft_rules','tag_design_simulation','tag_eval_create','tag_gate_report',
	 'tag_preview','tag_family_refs','refresh_species_counts','repair_hotspot_coords'));

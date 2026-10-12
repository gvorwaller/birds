-- Rolls back 0084_hotspot_coordinates.sql (td-c2f2b2). Not auto-applied: move
-- it into migrations/ (renumbered to the next free number) in the same commit
-- as the code revert (hotspot-coordinates.ts, the repair job and the C2 load
-- step), after cancelling any pending repair_hotspot_coords job.
--
-- Coordinates written by the feature stay in ebird_locations: they are valid
-- eBird hotspot coordinates, and the pre-0084 code reads them as before.
SET LOCAL lock_timeout = '5s';

DELETE FROM jobs WHERE type = 'repair_hotspot_coords';
ALTER TABLE jobs DROP CONSTRAINT jobs_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_type_check CHECK (type IN
	('load_hotspots','load_region','analyze_counties','refresh_loc','retry_loc','sync_lifelist',
	 'sync_taxonomy','scan_need_alerts','enrich_species','scan_enrichment','enrich_species_media',
	 'enrich_species_inat','enrich_families','tag_repair',
	 'tag_consistency','tag_stage','tag_benchmark','tag_activate','tag_retire','tag_rollback',
	 'tag_draft_rules','tag_design_simulation','tag_eval_create','tag_gate_report',
	 'tag_preview','tag_family_refs','refresh_species_counts'));

DROP TABLE hotspot_coord_misses;
ALTER TABLE ebird_locations
	DROP CONSTRAINT ebird_locations_official_fetched_check,
	DROP COLUMN coord_fetched_at,
	DROP COLUMN coord_source;

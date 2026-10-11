-- td-de2150: Hotspots & data species totals come from a published snapshot.
-- Page loads used to start the database-wide distinct-species aggregate (and a
-- revision hash) themselves; every completed load changed the revision, so
-- copies piled up and the page sat on "Counting species…". Now one worker job
-- (refresh_species_counts) builds the exact counts and publishes them here; a
-- page reads this one row and never computes anything.
--
-- One row (id = 1), created by the first refresh. Deploying with no row is
-- safe: the page says the counts are being prepared until it exists.
--
--  * counts            the published result {areas, regions, world}; NULL only
--                      while no build has ever succeeded (a status-only row
--                      recording a first failure);
--  * source_revision   the frequency/taxonomy revision the counts were built
--                      from (read in the same snapshot as the aggregate);
--  * built_at          when that read snapshot was taken ("Updated …");
--  * build_ms          how long the build took;
--  * last_attempt_at, last_error, consecutive_failures — refresh status. A
--                      failure keeps the last good counts;
--  * source_changed_at the worker saw newer source data than the published
--                      counts and a refresh is due ("Updating…"); NULL when
--                      the published counts are current.
--
-- Wrapped in one transaction by migrate_pg.sh.

ALTER TABLE jobs DROP CONSTRAINT jobs_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_type_check CHECK (type IN
	('load_hotspots','load_region','analyze_counties','refresh_loc','retry_loc','sync_lifelist',
	 'sync_taxonomy','scan_need_alerts','enrich_species','scan_enrichment','enrich_species_media',
	 'enrich_species_inat','enrich_families','tag_repair',
	 'tag_consistency','tag_stage','tag_benchmark','tag_activate','tag_retire','tag_rollback',
	 'tag_draft_rules','tag_design_simulation','tag_eval_create','tag_gate_report',
	 'tag_preview','tag_family_refs','refresh_species_counts'));

CREATE TABLE species_count_snapshot (
	id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
	counts jsonb CHECK (counts IS NULL OR jsonb_typeof(counts) = 'object'),
	source_revision text,
	built_at timestamptz,
	build_ms integer CHECK (build_ms >= 0),
	last_attempt_at timestamptz NOT NULL DEFAULT now(),
	last_error text,
	consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
	source_changed_at timestamptz,
	-- A published result is whole: counts, its revision, time and duration.
	CONSTRAINT species_count_snapshot_whole CHECK (
		(counts IS NULL) = (source_revision IS NULL)
		AND (counts IS NULL) = (built_at IS NULL)
		AND (counts IS NULL) = (build_ms IS NULL)
	)
);
-- 0002's default privileges would grant DELETE too; the runtime reads,
-- creates and updates the one row and never deletes it.
REVOKE ALL ON species_count_snapshot FROM birds_app, PUBLIC;
GRANT SELECT, INSERT, UPDATE ON species_count_snapshot TO birds_app;

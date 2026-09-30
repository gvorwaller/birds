-- td-894144 Release B3 (plan §B3, "Nightly tag consistency job", "Admin Tags
-- tab"): the operational job types and the consistency job's integrity data.
--
--  * job types: tag_consistency (recurring nightly singleton), tag_stage,
--    tag_benchmark, tag_activate, tag_retire, tag_rollback;
--  * tag_legacy_baseline: one row per species whose legacy_tags was set at
--    the Release-A cutover (legacy is immutable since 0065, so the state at
--    this migration IS the cutover state). The nightly integrity check proves
--    no legacy value changed and none was created afterwards;
--  * tag_consistency_run gains duration, a 'deferred' status (a repair
--    generation was pending, so the pass left the work to the tag_repair job)
--    and structured details.
--
-- Wrapped in one transaction by migrate_pg.sh.

ALTER TABLE jobs DROP CONSTRAINT jobs_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_type_check CHECK (type IN
	('load_hotspots','load_region','analyze_counties','refresh_loc','retry_loc','sync_lifelist',
	 'sync_taxonomy','scan_need_alerts','enrich_species','scan_enrichment','enrich_species_media',
	 'enrich_species_inat','enrich_families','tag_repair',
	 'tag_consistency','tag_stage','tag_benchmark','tag_activate','tag_retire','tag_rollback'));

-- ── the cutover legacy baseline (immutable) ────────────────────────────────
CREATE TABLE public.tag_legacy_baseline (
	species_code text PRIMARY KEY,
	legacy_sha256 text NOT NULL CHECK (public.tag_is_hex64(legacy_sha256))
);
CREATE FUNCTION public.tag_legacy_sha256(p_legacy text[]) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
	SELECT encode(sha256(convert_to(to_json(p_legacy)::text, 'UTF8')), 'hex')
$$;
INSERT INTO public.tag_legacy_baseline (species_code, legacy_sha256)
SELECT species_code, public.tag_legacy_sha256(legacy_tags)
  FROM public.species_enrichment
 WHERE legacy_tags IS NOT NULL;
CREATE TRIGGER tag_legacy_baseline_immutable
	BEFORE UPDATE OR DELETE ON public.tag_legacy_baseline
	FOR EACH ROW EXECUTE FUNCTION public.tag_reject_mutation();

-- ── consistency runs: duration, deferred status, details ───────────────────
ALTER TABLE public.tag_consistency_run
	ADD COLUMN duration_ms integer,
	ADD COLUMN details jsonb NOT NULL DEFAULT '{}'::jsonb,
	DROP CONSTRAINT tag_consistency_run_status_check,
	ADD CONSTRAINT tag_consistency_run_status_check CHECK (status IN ('clean', 'fixed', 'failed', 'deferred'));

DROP FUNCTION public.record_tag_consistency_run(timestamptz, integer, jsonb, jsonb, text);
CREATE FUNCTION public.record_tag_consistency_run(
	p_started_at timestamptz, p_checked integer, p_fixed jsonb, p_failures jsonb, p_status text,
	p_duration_ms integer, p_details jsonb
) RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
	INSERT INTO public.tag_consistency_run
		(started_at, finished_at, checked, fixed_by_reason, failures, status, duration_ms, details)
	VALUES (p_started_at, now(), p_checked, coalesce(p_fixed, '{}'::jsonb), coalesce(p_failures, '[]'::jsonb),
	        p_status, p_duration_ms, coalesce(p_details, '{}'::jsonb))
	RETURNING id
$$;

-- ── integrity (read-only; definer so it can see the catalog as the owner) ──
-- Returns one row per violation: legacy drift against the baseline, and any
-- runtime-role privilege beyond the Release A/B matrix.
CREATE FUNCTION public.tag_integrity_violations() RETURNS TABLE (kind text, detail text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
	SELECT 'legacy_changed', se.species_code
	  FROM public.species_enrichment se
	  JOIN public.tag_legacy_baseline b ON b.species_code = se.species_code
	 WHERE public.tag_legacy_sha256(se.legacy_tags) IS DISTINCT FROM b.legacy_sha256
	UNION ALL
	SELECT 'legacy_created_after_cutover', se.species_code
	  FROM public.species_enrichment se
	 WHERE se.legacy_tags IS NOT NULL
	   AND NOT EXISTS (SELECT 1 FROM public.tag_legacy_baseline b WHERE b.species_code = se.species_code)
	UNION ALL
	SELECT 'grant', 'birds_app can ' || p.priv || ' species_enrichment.' || c.col
	  FROM unnest(ARRAY['tags', 'legacy_tags', 'search_tsv']) c(col)
	 CROSS JOIN unnest(ARRAY['INSERT', 'UPDATE']) p(priv)
	 WHERE has_column_privilege('birds_app', 'public.species_enrichment', c.col, p.priv)
	UNION ALL
	SELECT 'grant', 'birds_app can ' || p.priv || ' ' || t.tbl
	  FROM unnest(ARRAY[
		'tag_lexicon_state', 'species_tag_input', 'tag_crosscheck', 'tag_revision', 'tag_report',
		'tag_activation', 'tag_ownership', 'species_tag_state', 'tag_materialization_failure',
		'tag_consistency_run', 'tag_legacy_baseline']) t(tbl)
	 CROSS JOIN unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p(priv)
	 WHERE has_table_privilege('birds_app', 'public.' || t.tbl, p.priv)
	UNION ALL
	SELECT 'grant', 'birds_app can ' || p.priv || ' tag_rule_proposal'
	  FROM unnest(ARRAY['UPDATE', 'DELETE', 'TRUNCATE']) p(priv)
	 WHERE has_table_privilege('birds_app', 'public.tag_rule_proposal', p.priv)
$$;

REVOKE ALL ON public.tag_legacy_baseline FROM birds_app, PUBLIC;
GRANT SELECT ON public.tag_legacy_baseline TO birds_app;
DO $$
DECLARE
	f text;
BEGIN
	FOREACH f IN ARRAY ARRAY[
		'public.tag_legacy_sha256(text[])',
		'public.record_tag_consistency_run(timestamptz, integer, jsonb, jsonb, text, integer, jsonb)',
		'public.tag_integrity_violations()'
	] LOOP
		EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
		EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO birds_app', f);
	END LOOP;
END $$;

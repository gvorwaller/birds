-- td-894144 Release B3 hostile-review repair. 0068 was already applied to
-- birds_test before review, so amend its integrity definer forward rather
-- than editing an applied migration.
--
-- tag_legacy_baseline deliberately has no FK to species_enrichment: the
-- baseline must survive deletion of a protected legacy row so consistency can
-- report that loss. The 0068 inner join omitted that case.

CREATE OR REPLACE FUNCTION public.tag_integrity_violations() RETURNS TABLE (kind text, detail text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
	SELECT 'legacy_changed', se.species_code
	  FROM public.species_enrichment se
	  JOIN public.tag_legacy_baseline b ON b.species_code = se.species_code
	 WHERE public.tag_legacy_sha256(se.legacy_tags) IS DISTINCT FROM b.legacy_sha256
	UNION ALL
	SELECT 'legacy_missing', b.species_code
	  FROM public.tag_legacy_baseline b
	  LEFT JOIN public.species_enrichment se ON se.species_code = b.species_code
	 WHERE se.species_code IS NULL
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

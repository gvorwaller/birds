-- td-894144 Release B (plan rev 21 §B2 "Taxonomy name change while tags are
-- owned"): generation-keyed batched repair.
--
-- When replaceTaxonomy changes the other-taxon lexicon while any tag is owned,
-- re-deriving every input and owned state in one exclusive transaction would
-- exceed the lock budget. Instead it bumps a repair GENERATION and inserts a
-- `tag_repair` job for it in the same transaction; the job repairs the
-- workset in short exclusive batches and completes the generation with a
-- compare-and-swap whose predicate is exactly "workset empty".
--
-- Pending ⇔ repaired_generation < repair_generation. While pending,
-- activation and revision rollback are refused; retiring a tag to legacy is
-- always available (emergency escape, lexicon-independent).
--
-- Wrapped in one transaction by migrate_pg.sh.

ALTER TABLE public.tag_lexicon_state
	ADD COLUMN repair_generation bigint NOT NULL DEFAULT 0,
	ADD COLUMN repaired_generation bigint NOT NULL DEFAULT 0,
	ADD COLUMN repair_target_lexicon_hash text
		CHECK (repair_target_lexicon_hash IS NULL OR public.tag_is_hex64(repair_target_lexicon_hash)),
	ADD CONSTRAINT tag_lexicon_state_generations CHECK (repaired_generation <= repair_generation);

-- The repair job type: non-recurring, cancellable between batches.
ALTER TABLE jobs DROP CONSTRAINT jobs_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_type_check CHECK (type IN
	('load_hotspots','load_region','analyze_counties','refresh_loc','retry_loc','sync_lifelist',
	 'sync_taxonomy','scan_need_alerts','enrich_species','scan_enrichment','enrich_species_media',
	 'enrich_species_inat','enrich_families','tag_repair'));

-- ── the exclusive engine lock, asserted by every repair routine ────────────
-- TAG_ENGINE_KEY is positive and below 2^32: the single-bigint advisory lock
-- appears in pg_locks as classid=0, objid=894144.
CREATE FUNCTION public.tag_assert_exclusive_engine_lock(p_context text) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_locks
		 WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND mode = 'ExclusiveLock' AND granted
		   AND ((classid::bigint << 32) | objid::bigint) = 894144::bigint
	) THEN
		RAISE EXCEPTION '%: exclusive tag_engine lock not held', p_context;
	END IF;
END $$;

-- ── the workset: every code whose input/state is not what the target says ──
-- (a) member without an input pointer; (b) pointer with a stale lexicon or
-- scanner revision; (c) current pointer missing a state for an owned tag;
-- (d) pointer for a non-member (row iff member). The universe is written out
-- inline (not via tag_universe_codes(), which as a definer is never inlined).
CREATE FUNCTION public.tag_repair_workset(p_target text, p_scanner_rev text, p_limit integer)
RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
	WITH universe AS MATERIALIZED (
		SELECT se.species_code AS code
		  FROM public.species_enrichment se
		  JOIN public.taxonomy_cache tc ON tc.species_code = se.species_code AND tc.category = 'species'
		 WHERE se.wikipedia_extract IS NOT NULL
	), owned AS MATERIALIZED (
		SELECT o.tag, a.revision_id
		  FROM public.tag_ownership o
		  JOIN public.tag_activation a ON a.id = o.activation_id AND a.revision_id IS NOT NULL
	), w AS (
		SELECT u.code
		  FROM universe u
		  LEFT JOIN public.species_tag_input i ON i.species_code = u.code
		 WHERE i.species_code IS NULL
		    OR i.lexicon_hash <> p_target
		    OR i.scanner_rev <> p_scanner_rev
		    OR EXISTS (
		         SELECT 1 FROM owned ow
		          WHERE NOT EXISTS (
		                SELECT 1 FROM public.species_tag_state s
		                 WHERE s.revision_id = ow.revision_id AND s.species_code = u.code
		                   AND s.input_hash = i.input_hash AND s.tag = ow.tag))
		UNION
		SELECT i.species_code
		  FROM public.species_tag_input i
		 WHERE NOT EXISTS (SELECT 1 FROM universe u WHERE u.code = i.species_code)
	)
	SELECT code FROM w ORDER BY code LIMIT greatest(p_limit, 0)
$$;

-- Start a repair generation for the current lexicon (replaceTaxonomy).
CREATE FUNCTION public.begin_tag_repair(p_target text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
	v_gen bigint;
BEGIN
	PERFORM public.tag_assert_exclusive_engine_lock('begin_tag_repair');
	UPDATE public.tag_lexicon_state
	   SET repair_generation = repair_generation + 1, repair_target_lexicon_hash = p_target
	 WHERE id = 1 AND lexicon_hash = p_target
	RETURNING repair_generation INTO v_gen;
	IF v_gen IS NULL THEN
		RAISE EXCEPTION 'begin_tag_repair: target % is not the current lexicon', p_target;
	END IF;
	RETURN v_gen;
END $$;

-- Compare-and-swap completion. FALSE: this generation is superseded (or the
-- lexicon moved). RAISE: the workset is not empty (never completes early).
CREATE FUNCTION public.complete_tag_repair(p_generation bigint, p_scanner_rev text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
	v public.tag_lexicon_state%ROWTYPE;
BEGIN
	PERFORM public.tag_assert_exclusive_engine_lock('complete_tag_repair');
	SELECT * INTO v FROM public.tag_lexicon_state WHERE id = 1 FOR UPDATE;
	IF NOT FOUND OR v.repair_generation <> p_generation
	   OR v.lexicon_hash IS DISTINCT FROM v.repair_target_lexicon_hash THEN
		RETURN false;
	END IF;
	IF EXISTS (SELECT 1 FROM public.tag_repair_workset(v.repair_target_lexicon_hash, p_scanner_rev, 1)) THEN
		RAISE EXCEPTION 'complete_tag_repair: generation % has not converged (workset not empty)', p_generation
			USING ERRCODE = 'integrity_constraint_violation';
	END IF;
	UPDATE public.tag_lexicon_state SET repaired_generation = p_generation WHERE id = 1;
	RETURN true;
END $$;

-- ── activation and revision rollback wait for the repair ───────────────────
CREATE FUNCTION public.tag_activation_repair_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
	v public.tag_lexicon_state%ROWTYPE;
BEGIN
	IF NEW.action IN ('activate', 'rollback') THEN
		SELECT * INTO v FROM public.tag_lexicon_state WHERE id = 1;
		IF FOUND AND v.repaired_generation < v.repair_generation THEN
			RAISE EXCEPTION 'tag repair generation % is pending: activation and revision rollback wait until it converges (retire to legacy is still available)',
				v.repair_generation
				USING ERRCODE = 'object_not_in_prerequisite_state';
		END IF;
	END IF;
	RETURN NEW;
END $$;
CREATE TRIGGER tag_activation_repair_guard
	BEFORE INSERT ON public.tag_activation
	FOR EACH ROW EXECUTE FUNCTION public.tag_activation_repair_guard();

-- ── retire a tag to legacy: always available ───────────────────────────────
-- Removes ownership and re-applies the candidate set in the same (exclusive)
-- transaction. Lexicon-independent: every row is re-derived from its legacy
-- baseline plus the surviving owned tags' states for its one current input.
CREATE FUNCTION public.retire_tag_to_legacy(p_tag text, p_user_id integer, p_engine_key bigint) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
	v_act bigint;
	r record;
BEGIN
	IF p_engine_key IS DISTINCT FROM 894144::bigint THEN
		RAISE EXCEPTION 'retire: wrong tag_engine lock key %', p_engine_key;
	END IF;
	PERFORM public.tag_assert_exclusive_engine_lock('retire');
	IF NOT EXISTS (SELECT 1 FROM public.tag_ownership WHERE tag = p_tag) THEN
		RAISE EXCEPTION 'retire: % is not owned', p_tag;
	END IF;
	INSERT INTO public.tag_activation (tag, revision_id, action, previous_activation_id, activated_by)
	VALUES (p_tag, NULL, 'to_legacy', NULL, p_user_id) RETURNING id INTO v_act;
	DELETE FROM public.tag_ownership WHERE tag = p_tag;
	FOR r IN
		SELECT se.species_code FROM public.species_enrichment se
		 WHERE p_tag = ANY (se.tags) OR p_tag = ANY (coalesce(se.legacy_tags, '{}'))
	LOOP
		PERFORM public.apply_effective_tags(r.species_code);
	END LOOP;
	-- NULL legacy baseline: the engine result must not survive as "legacy".
	UPDATE public.species_enrichment
	   SET tags = array_remove(tags, p_tag)
	 WHERE legacy_tags IS NULL AND p_tag = ANY (tags);
	RETURN v_act;
END $$;

DO $$
DECLARE
	f text;
BEGIN
	FOREACH f IN ARRAY ARRAY[
		'public.tag_assert_exclusive_engine_lock(text)',
		'public.tag_repair_workset(text, text, integer)',
		'public.begin_tag_repair(text)',
		'public.complete_tag_repair(bigint, text)',
		'public.retire_tag_to_legacy(text, integer, bigint)'
	] LOOP
		EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
		EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO birds_app', f);
	END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.tag_activation_repair_guard() FROM PUBLIC;

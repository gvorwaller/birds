-- td-894144 (owner 2026-10-04): accept a blind test that did not pass.
--
-- The open-ocean blind test (set 4) measured precision 86.0% (cautious
-- 82.6%) against the 95% / 85% gates, keeping 99.0% of the old AI's correct
-- tags. By the owner's own answers the old AI tags were about 58% right, the
-- rules about 86%. The owner's decision: use revision 1 as it is ("Use
-- what's there and move on") rather than label another revision.
--
-- switch_tag_ownership gains p_accept_failed_gate (default false). With it,
-- a gate report that did NOT pass is accepted only when:
--   * it is a real gate report for this tag revision (passed = false, a
--     namedCaseViolations array) with NO must-not violation: accepting a
--     measured shortfall never lets a known-wrong bird (American Kestrel,
--     Egyptian Goose, Osprey) be tagged;
--   * the requesting user is an admin.
-- Every other check is unchanged: the gate names this revision's frozen set
-- and its confirmed gates, the frame is recomputed under the exclusive lock
-- and must equal the set's, and a passing switch benchmark is required.
-- tag_activation records the acceptance (gate_accepted_failed).
--
-- The function is otherwise byte-identical to 0071's. Wrapped in one
-- transaction by migrate_pg.sh.

ALTER TABLE public.tag_activation
	ADD COLUMN gate_accepted_failed boolean NOT NULL DEFAULT false,
	ADD CONSTRAINT tag_activation_gate_accepted_only_on_activate
		CHECK (NOT gate_accepted_failed OR action = 'activate');

DROP FUNCTION public.switch_tag_ownership(text, bigint, bigint, bigint, integer, bigint, boolean);
CREATE FUNCTION public.switch_tag_ownership(
	p_tag text, p_revision_id bigint, p_gate_report_id bigint, p_benchmark_report_id bigint,
	p_user_id integer, p_engine_key bigint, p_dry_run boolean DEFAULT false,
	p_accept_failed_gate boolean DEFAULT false
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
	v_rev public.tag_revision%ROWTYPE;
	v_gate public.tag_report%ROWTYPE;
	v_set public.tag_eval_set%ROWTYPE;
	v_marine text[];
	v_prev bigint;
	v_act bigint;
	v_missing integer;
	v_extra integer;
	v_universe text;
	v_accepted boolean := false;
	r record;
BEGIN
	IF p_engine_key IS DISTINCT FROM 894144::bigint THEN
		RAISE EXCEPTION 'switch: wrong tag_engine lock key %', p_engine_key;
	END IF;
	PERFORM public.tag_assert_exclusive_engine_lock('switch');
	-- A pending taxonomy repair refuses first (its message says what to do);
	-- the tag_activation trigger enforces the same rule as a backstop.
	IF EXISTS (SELECT 1 FROM public.tag_lexicon_state WHERE id = 1 AND repaired_generation < repair_generation) THEN
		RAISE EXCEPTION 'tag repair generation % is pending: activation and revision rollback wait until it converges (retire to legacy is still available)',
			(SELECT repair_generation FROM public.tag_lexicon_state WHERE id = 1)
			USING ERRCODE = 'object_not_in_prerequisite_state';
	END IF;
	SELECT * INTO v_rev FROM public.tag_revision WHERE id = p_revision_id AND tag = p_tag;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'switch: revision % is not an approved revision of %', p_revision_id, p_tag;
	END IF;
	IF public.tag_artifact_sha256(v_rev.artifact) IS DISTINCT FROM v_rev.artifact_sha256 THEN
		RAISE EXCEPTION 'switch: revision artifact hash mismatch (integrity)';
	END IF;
	IF NOT p_dry_run THEN
		SELECT * INTO v_gate FROM public.tag_report
		 WHERE id = p_gate_report_id AND kind = 'gate' AND tag = p_tag AND revision_id = p_revision_id;
		IF NOT FOUND OR (v_gate.body->>'passed' IS DISTINCT FROM 'true' AND NOT p_accept_failed_gate) THEN
			RAISE EXCEPTION 'switch: no passing gate report % for % rev %', p_gate_report_id, p_tag, p_revision_id;
		END IF;
		IF v_gate.body->>'passed' IS DISTINCT FROM 'true' THEN
			-- 0078: the owner accepts a blind test that did not pass its
			-- precision/retention gates — never one that tags a must-not bird.
			IF v_gate.body->>'passed' IS DISTINCT FROM 'false'
			   OR jsonb_typeof(v_gate.body->'namedCaseViolations') IS DISTINCT FROM 'array'
			   OR jsonb_array_length(v_gate.body->'namedCaseViolations') > 0 THEN
				RAISE EXCEPTION 'switch: gate report % cannot be accepted (a must-not bird is tagged, or the report is malformed)', p_gate_report_id;
			END IF;
			IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_user_id AND role = 'admin') THEN
				RAISE EXCEPTION 'switch: user % is not an admin; only an admin may accept a gate that did not pass', p_user_id;
			END IF;
			v_accepted := true;
		END IF;
		SELECT * INTO v_set FROM public.tag_eval_set
		 WHERE id = (v_gate.body->>'setId')::bigint AND tag = p_tag AND revision_id = p_revision_id AND status = 'frozen';
		IF NOT FOUND OR v_set.gates_sha256 IS DISTINCT FROM v_gate.body->>'gatesSha256'
		   OR v_set.gates_sha256 IS DISTINCT FROM encode(sha256(convert_to(v_set.gates::text, 'UTF8')), 'hex') THEN
			RAISE EXCEPTION 'switch: the gate report does not name this revision''s frozen blind-test set and its confirmed gates';
		END IF;
		SELECT array_agg(x) INTO v_marine FROM jsonb_array_elements_text(v_set.design->'marineOrders') x;
		-- Recomputed NOW: after the activation's drift completion, under the exclusive lock.
		IF public.tag_eval_frame_hash(p_tag, p_revision_id, v_marine, v_set.design->>'designHash') IS DISTINCT FROM v_set.frame_hash THEN
			RAISE EXCEPTION 'switch: frame changed since the blind test — run a new blind test'
				USING ERRCODE = 'object_not_in_prerequisite_state';
		END IF;
		IF NOT EXISTS (SELECT 1 FROM public.tag_report WHERE id = p_benchmark_report_id AND kind = 'benchmark'
		                AND tag = p_tag AND revision_id = p_revision_id AND body->>'passed' = 'true') THEN
			RAISE EXCEPTION 'switch: no passing benchmark report % for % rev %', p_benchmark_report_id, p_tag, p_revision_id;
		END IF;
	END IF;
	IF EXISTS (
		SELECT 1 FROM unnest(v_rev.dependency_activation_ids) d(aid)
		 WHERE NOT EXISTS (SELECT 1 FROM public.tag_ownership o WHERE o.activation_id = d.aid)
	) THEN
		RAISE EXCEPTION 'switch: a dependency activation is not active';
	END IF;
	SELECT count(*) INTO v_missing
	  FROM public.tag_universe_codes() u(code)
	  LEFT JOIN public.species_tag_input i ON i.species_code = u.code
	  LEFT JOIN public.species_tag_state s
	    ON s.species_code = u.code AND s.tag = p_tag AND s.revision_id = p_revision_id AND s.input_hash = i.input_hash
	 WHERE s.state_id IS NULL;
	SELECT count(*) INTO v_extra
	  FROM public.species_tag_input i
	  LEFT JOIN public.tag_universe_codes() u(code) ON u.code = i.species_code
	 WHERE u.code IS NULL;
	IF v_missing > 0 OR v_extra > 0 THEN
		RAISE EXCEPTION 'switch: coverage failed (% members without a current state, % inputs for non-members)', v_missing, v_extra;
	END IF;
	SELECT encode(sha256(convert_to(coalesce(string_agg(code || ':' || input_hash, E'\n' ORDER BY code), ''), 'UTF8')), 'hex')
	  INTO v_universe
	  FROM (SELECT u.code, i.input_hash FROM public.tag_universe_codes() u(code)
	          JOIN public.species_tag_input i ON i.species_code = u.code) x;
	SELECT activation_id INTO v_prev FROM public.tag_ownership WHERE tag = p_tag;
	INSERT INTO public.tag_activation
		(tag, revision_id, action, previous_activation_id, gate_report_id, benchmark_report_id, universe_hash, activated_by,
		 gate_accepted_failed)
	VALUES (p_tag, p_revision_id, 'activate', v_prev,
	        CASE WHEN p_dry_run THEN NULL ELSE p_gate_report_id END,
	        CASE WHEN p_dry_run THEN NULL ELSE p_benchmark_report_id END,
	        v_universe, p_user_id,
	        v_accepted AND NOT p_dry_run)
	RETURNING id INTO v_act;
	INSERT INTO public.tag_ownership (tag, activation_id) VALUES (p_tag, v_act)
	ON CONFLICT (tag) DO UPDATE SET activation_id = EXCLUDED.activation_id;
	FOR r IN
		SELECT se.species_code FROM public.species_enrichment se WHERE p_tag = ANY (se.tags)
		UNION
		SELECT s.species_code FROM public.species_tag_state s
		  JOIN public.species_tag_input i ON i.species_code = s.species_code AND i.input_hash = s.input_hash
		 WHERE s.tag = p_tag AND s.revision_id = p_revision_id AND s.status = 'assigned'
	LOOP
		PERFORM public.apply_effective_tags(r.species_code);
	END LOOP;
	IF p_dry_run THEN
		-- A dry run can never commit: everything above is rolled back with it.
		RAISE EXCEPTION 'TAG_DRY_RUN' USING ERRCODE = 'P0001', DETAIL = v_act::text;
	END IF;
	RETURN v_act;
END $$;

REVOKE ALL ON FUNCTION public.switch_tag_ownership(text, bigint, bigint, bigint, integer, bigint, boolean, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.switch_tag_ownership(text, bigint, bigint, bigint, integer, bigint, boolean, boolean) TO birds_app;

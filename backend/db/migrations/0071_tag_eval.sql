-- td-894144 Release B4 (plan rev 25 §B4a–B4i): the open-ocean pilot's
-- authoring set, cross-check recording, blind-test sets and gate-checked
-- activation.
--
--  * tag_authoring_example — frozen AI-draft examples (first draft wins);
--  * record_tag_crosscheck — OWNER ROLE ONLY: no app path can mint an
--    approving cross-check; the hash is recomputed here, never supplied;
--  * tag_eval_frame_rows / tag_eval_frame_hash — the single SQL definition
--    of a revision's evaluation frame and its canonical byte hash
--    (mirrored exactly by eval-frame.ts canonicalFrameHash);
--  * tag_eval_set / tag_eval_item — a sample the DB itself re-derives from the
--    stored seed (no operator substitution); tag_eval_label — write-once,
--    keyed by the page the owner read (tag, species, eval_text_hash) and
--    reused across sets; every write through a definer;
--  * switch_tag_ownership — verifies, INSIDE the exclusive activation
--    transaction, gate report → frozen set → gates hash → frame hash
--    recomputed now; p_dry_run always raises at the end (benchmarks).
--
-- Wrapped in one transaction by migrate_pg.sh.

ALTER TABLE jobs DROP CONSTRAINT jobs_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_type_check CHECK (type IN
	('load_hotspots','load_region','analyze_counties','refresh_loc','retry_loc','sync_lifelist',
	 'sync_taxonomy','scan_need_alerts','enrich_species','scan_enrichment','enrich_species_media',
	 'enrich_species_inat','enrich_families','tag_repair',
	 'tag_consistency','tag_stage','tag_benchmark','tag_activate','tag_retire','tag_rollback',
	 'tag_draft_rules','tag_design_simulation','tag_eval_create','tag_gate_report'));

-- ── B4a authoring set ──────────────────────────────────────────────────────
CREATE TABLE public.tag_authoring_example (
	tag text NOT NULL,
	species_code text NOT NULL,
	genus text NOT NULL,
	frozen_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (tag, species_code)
);
CREATE TRIGGER tag_authoring_example_immutable
	BEFORE UPDATE OR DELETE ON public.tag_authoring_example
	FOR EACH ROW EXECUTE FUNCTION public.tag_reject_mutation();

CREATE FUNCTION public.freeze_tag_authoring_set(p_tag text, p_codes text[]) RETURNS SETOF text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
	PERFORM pg_advisory_xact_lock(894146, hashtext(p_tag));
	IF NOT EXISTS (SELECT 1 FROM public.tag_authoring_example WHERE tag = p_tag) THEN
		IF coalesce(cardinality(p_codes), 0) = 0 THEN
			RAISE EXCEPTION 'freeze_tag_authoring_set: no codes for %', p_tag;
		END IF;
		INSERT INTO public.tag_authoring_example (tag, species_code, genus)
		SELECT p_tag, c, split_part(tc.sci_name, ' ', 1)
		  FROM unnest(p_codes) c JOIN public.taxonomy_cache tc ON tc.species_code = c;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'freeze_tag_authoring_set: none of the codes are in the taxonomy';
		END IF;
	END IF;
	RETURN QUERY SELECT species_code FROM public.tag_authoring_example WHERE tag = p_tag ORDER BY species_code;
END $$;

-- ── B4c cross-check (owner role only; see grants) ──────────────────────────
CREATE FUNCTION public.record_tag_crosscheck(
	p_proposal_id uuid, p_reviewer text, p_verdict text, p_text text
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
	v_prop public.tag_rule_proposal%ROWTYPE;
	v_id bigint;
BEGIN
	IF p_reviewer NOT IN ('CODEX1', 'CODEX') THEN
		RAISE EXCEPTION 'crosscheck: reviewer must be CODEX1 or CODEX';
	END IF;
	IF p_verdict NOT IN ('approve', 'changes', 'reject') THEN
		RAISE EXCEPTION 'crosscheck: bad verdict %', p_verdict;
	END IF;
	IF coalesce(btrim(p_text), '') = '' THEN
		RAISE EXCEPTION 'crosscheck: the review text is required';
	END IF;
	SELECT * INTO v_prop FROM public.tag_rule_proposal WHERE id = p_proposal_id FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'crosscheck: no proposal %', p_proposal_id;
	END IF;
	IF v_prop.status NOT IN ('proposed', 'crosschecked') THEN
		RAISE EXCEPTION 'crosscheck: proposal is %', v_prop.status;
	END IF;
	-- The reviewed hash is the stored artifact's hash, recomputed now.
	INSERT INTO public.tag_crosscheck (proposal_id, reviewer, verdict, text, reviewed_sha256)
	VALUES (p_proposal_id, p_reviewer, p_verdict, p_text, public.tag_artifact_sha256(v_prop.artifact))
	RETURNING id INTO v_id;
	UPDATE public.tag_rule_proposal SET status = 'crosschecked' WHERE id = p_proposal_id AND status = 'proposed';
	RETURN v_id;
END $$;

-- ── B4d/B4i the evaluation frame: one SQL definition ───────────────────────
CREATE FUNCTION public.tag_eval_frame_rows(p_tag text, p_revision_id bigint, p_marine text[])
RETURNS TABLE (species_code text, stratum text, input_hash text, rules_yes boolean, legacy_yes boolean,
               rules_status text, marine boolean, com_name text, sci_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
	WITH f AS (
		SELECT se.species_code, s.status, i.input_hash,
		       coalesce(p_tag = ANY (se.legacy_tags), false) AS legacy_yes,
		       coalesce(tc.order_name = ANY (p_marine), false) AS marine,
		       coalesce(tc.com_name, '') AS com_name, coalesce(tc.sci_name, '') AS sci_name
		  FROM public.species_enrichment se
		  JOIN public.taxonomy_cache tc ON tc.species_code = se.species_code AND tc.category = 'species'
		  JOIN public.species_tag_input i ON i.species_code = se.species_code
		  JOIN public.species_tag_state s
		    ON s.species_code = se.species_code AND s.tag = p_tag AND s.revision_id = p_revision_id
		   AND s.input_hash = i.input_hash
		 WHERE se.wikipedia_extract IS NOT NULL
		   AND (s.status = 'assigned' OR coalesce(p_tag = ANY (se.legacy_tags), false))
	)
	SELECT f.species_code,
	       CASE WHEN f.status = 'assigned' THEN CASE WHEN f.legacy_yes THEN 'A' ELSE 'B' END
	            WHEN f.status = 'unevaluated' THEN 'U'
	            WHEN f.marine THEN 'C1' ELSE 'C2' END,
	       f.input_hash, f.status = 'assigned', f.legacy_yes, f.status, f.marine, f.com_name, f.sci_name
	  FROM f
$$;

-- Canonical bytes (mirrored by eval-frame.ts canonicalFrameHash):
-- "tagframe-v1|" + design_sha256 + "|" + per row, ordered by code COLLATE "C":
-- len:code|len:stratum|len:input_hash|len:com_name|len:sci_name|r|l|
-- (lengths in UTF-8 octets; r,l ∈ {0,1}; missing names ''). The names are
-- what the evaluator page masks, so a rename changes the frame (rev 26).
CREATE FUNCTION public.tag_eval_frame_hash(p_tag text, p_revision_id bigint, p_marine text[], p_design_sha256 text)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
	SELECT encode(sha256(convert_to(
		'tagframe-v1|' || p_design_sha256 || '|' ||
		coalesce(string_agg(
			octet_length(r.species_code) || ':' || r.species_code || '|' ||
			octet_length(r.stratum) || ':' || r.stratum || '|' ||
			octet_length(r.input_hash) || ':' || r.input_hash || '|' ||
			octet_length(r.com_name) || ':' || r.com_name || '|' ||
			octet_length(r.sci_name) || ':' || r.sci_name || '|' ||
			CASE WHEN r.rules_yes THEN '1' ELSE '0' END || '|' ||
			CASE WHEN r.legacy_yes THEN '1' ELSE '0' END || '|',
			'' ORDER BY r.species_code COLLATE "C"), ''),
		'UTF8')), 'hex')
	  FROM public.tag_eval_frame_rows(p_tag, p_revision_id, p_marine) r
$$;

-- ── B4f/g/h eval sets, items, labels ───────────────────────────────────────
CREATE TABLE public.tag_eval_set (
	id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	tag text NOT NULL,
	revision_id bigint NOT NULL,
	status text NOT NULL DEFAULT 'labelling' CHECK (status IN ('labelling', 'frozen', 'abandoned')),
	design jsonb NOT NULL,
	frame_hash text NOT NULL CHECK (public.tag_is_hex64(frame_hash)),
	gates jsonb NOT NULL,
	gates_sha256 text NOT NULL CHECK (public.tag_is_hex64(gates_sha256)),
	gates_confirmed_by integer NOT NULL,
	gates_confirmed_at timestamptz NOT NULL DEFAULT now(),
	created_at timestamptz NOT NULL DEFAULT now(),
	frozen_by integer,
	frozen_at timestamptz,
	abandoned_at timestamptz,
	FOREIGN KEY (revision_id, tag) REFERENCES public.tag_revision (id, tag),
	UNIQUE (id, tag)
);
-- At most one set in labelling per revision; frozen/abandoned sets are history.
CREATE UNIQUE INDEX tag_eval_set_one_labelling ON public.tag_eval_set (revision_id) WHERE status = 'labelling';

CREATE FUNCTION public.tag_eval_set_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		IF pg_trigger_depth() >= 2
		   OR (current_database() = 'birds_test' AND current_user = 'birds_owner'
		       AND coalesce(current_setting('birds.tag_fixture', true), '') = 'on') THEN
			RETURN OLD;
		END IF;
		RAISE EXCEPTION 'tag_eval_set rows are immutable (td-894144)' USING ERRCODE = 'insufficient_privilege';
	END IF;
	IF (NEW.id, NEW.tag, NEW.revision_id, NEW.design, NEW.frame_hash, NEW.gates, NEW.gates_sha256,
	    NEW.gates_confirmed_by, NEW.gates_confirmed_at, NEW.created_at)
	   IS DISTINCT FROM (OLD.id, OLD.tag, OLD.revision_id, OLD.design, OLD.frame_hash, OLD.gates, OLD.gates_sha256,
	    OLD.gates_confirmed_by, OLD.gates_confirmed_at, OLD.created_at) THEN
		RAISE EXCEPTION 'tag_eval_set: only its lifecycle may change' USING ERRCODE = 'insufficient_privilege';
	END IF;
	IF NOT (OLD.status = 'labelling' AND NEW.status IN ('frozen', 'abandoned')) THEN
		RAISE EXCEPTION 'tag_eval_set: % → % is not allowed', OLD.status, NEW.status USING ERRCODE = 'insufficient_privilege';
	END IF;
	RETURN NEW;
END $$;
CREATE TRIGGER tag_eval_set_guard
	BEFORE UPDATE OR DELETE ON public.tag_eval_set
	FOR EACH ROW EXECUTE FUNCTION public.tag_eval_set_guard();

CREATE TABLE public.tag_eval_item (
	id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	set_id bigint NOT NULL REFERENCES public.tag_eval_set (id) ON DELETE CASCADE,
	species_code text NOT NULL,
	stratum text NOT NULL CHECK (stratum IN ('A', 'B', 'C1', 'C2', 'U')),
	rules_yes boolean NOT NULL,
	legacy_yes boolean NOT NULL,
	rules_status text NOT NULL CHECK (rules_status IN ('assigned', 'not_assigned', 'unevaluated')),
	marine boolean NOT NULL,
	inclusion_prob double precision NOT NULL CHECK (inclusion_prob > 0 AND inclusion_prob <= 1),
	display_position integer NOT NULL,
	input_hash text NOT NULL CHECK (public.tag_is_hex64(input_hash)),
	eval_text_hash text NOT NULL CHECK (public.tag_is_hex64(eval_text_hash)),
	article jsonb NOT NULL CHECK (jsonb_typeof(article) = 'array'),
	UNIQUE (set_id, species_code),
	UNIQUE (set_id, display_position)
);
CREATE TRIGGER tag_eval_item_immutable
	BEFORE UPDATE OR DELETE ON public.tag_eval_item
	FOR EACH ROW EXECUTE FUNCTION public.tag_reject_mutation();

-- A label belongs to the PAGE the owner read, not to a set: reused by any
-- later set whose item shows the identical page. Write-once.
CREATE TABLE public.tag_eval_label (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	tag text NOT NULL,
	species_code text NOT NULL,
	eval_text_hash text NOT NULL CHECK (public.tag_is_hex64(eval_text_hash)),
	label text NOT NULL CHECK (label IN ('yes', 'no', 'unsure')),
	labeled_by integer NOT NULL,
	first_set_id bigint NOT NULL REFERENCES public.tag_eval_set (id) ON DELETE CASCADE,
	created_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (tag, species_code, eval_text_hash)
);
CREATE TRIGGER tag_eval_label_immutable
	BEFORE UPDATE OR DELETE ON public.tag_eval_label
	FOR EACH ROW EXECUTE FUNCTION public.tag_reject_mutation();

-- ── B4g2 create a set: the DB re-derives the sample itself ─────────────────
-- p_design: {seed (64 hex), algorithm "sha256-rank-v1", marineOrders[],
--   designHash, frameHash, N{A..U}, n{A..U}, ...}. p_items: [{species_code,
--   stratum, rules_yes, legacy_yes, rules_status, marine, display_position,
--   eval_text_hash, article}] — only display fields are trusted from the job.
CREATE FUNCTION public.create_tag_eval_set(
	p_tag text, p_revision_id bigint, p_design jsonb, p_items jsonb, p_gates jsonb, p_user_id integer
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
	v_marine text[];
	v_seed text := p_design->>'seed';
	v_frame text;
	v_id bigint;
	v_mismatch integer;
	v_items integer;
BEGIN
	IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_user_id AND role = 'admin') THEN
		RAISE EXCEPTION 'eval set: user % is not an admin (audit check)', p_user_id;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM public.tag_revision WHERE id = p_revision_id AND tag = p_tag) THEN
		RAISE EXCEPTION 'eval set: revision % is not a revision of %', p_revision_id, p_tag;
	END IF;
	IF p_design->>'algorithm' IS DISTINCT FROM 'sha256-rank-v1' OR v_seed !~ '^[0-9a-f]{64}$'
	   OR NOT public.tag_is_hex64(p_design->>'designHash') OR NOT public.tag_is_hex64(p_design->>'frameHash')
	   OR jsonb_typeof(p_design->'marineOrders') <> 'array' OR jsonb_typeof(p_design->'n') <> 'object'
	   OR jsonb_typeof(p_gates) <> 'object' OR (p_gates->>'version') IS DISTINCT FROM '1' THEN
		RAISE EXCEPTION 'eval set: malformed design or gates';
	END IF;
	SELECT array_agg(x) INTO v_marine FROM jsonb_array_elements_text(p_design->'marineOrders') x;
	-- 1. The frame, recomputed here, must be the one the design was sized on.
	v_frame := public.tag_eval_frame_hash(p_tag, p_revision_id, v_marine, p_design->>'designHash');
	IF v_frame IS DISTINCT FROM p_design->>'frameHash' THEN
		RAISE EXCEPTION 'eval set: the frame changed since the design was computed — run the design again'
			USING ERRCODE = 'serialization_failure';
	END IF;
	-- 2. N_h in the design must be the frame's.
	IF EXISTS (
		SELECT 1 FROM (VALUES ('A'), ('B'), ('C1'), ('C2'), ('U')) h(stratum)
		 WHERE (p_design->'N'->>h.stratum)::integer IS DISTINCT FROM
		       (SELECT count(*)::integer FROM public.tag_eval_frame_rows(p_tag, p_revision_id, v_marine) r WHERE r.stratum = h.stratum)
		    OR coalesce((p_design->'n'->>h.stratum)::integer, -1) < 0
		    OR (p_design->'n'->>h.stratum)::integer > (p_design->'N'->>h.stratum)::integer
	) THEN
		RAISE EXCEPTION 'eval set: design N/n do not match the frame';
	END IF;
	-- 3. The expected selection: per stratum, the first n_h by sha256 rank of
	--    seed|v1|tag|revision|stratum|code, ties by code COLLATE "C".
	CREATE TEMP TABLE IF NOT EXISTS pg_temp.tag_eval_expected (
		species_code text PRIMARY KEY, stratum text, rules_yes boolean, legacy_yes boolean,
		rules_status text, marine boolean, input_hash text) ON COMMIT DROP;
	DELETE FROM pg_temp.tag_eval_expected;
	INSERT INTO pg_temp.tag_eval_expected
	SELECT species_code, stratum, rules_yes, legacy_yes, rules_status, marine, input_hash
	  FROM (
		SELECT r.*, row_number() OVER (
			PARTITION BY r.stratum
			ORDER BY encode(sha256(convert_to(v_seed || '|v1|' || p_tag || '|' || p_revision_id || '|' || r.stratum || '|' || r.species_code, 'UTF8')), 'hex'),
			         r.species_code COLLATE "C") AS rk
		  FROM public.tag_eval_frame_rows(p_tag, p_revision_id, v_marine) r
	  ) ranked
	 WHERE rk <= (p_design->'n'->>stratum)::integer;
	-- 4. The job's items must be exactly that selection, attribute for attribute.
	SELECT count(*) INTO v_items FROM jsonb_array_elements(p_items);
	SELECT count(*) INTO v_mismatch FROM (
		(SELECT species_code, stratum, rules_yes, legacy_yes, rules_status, marine FROM pg_temp.tag_eval_expected
		 EXCEPT
		 SELECT x.species_code, x.stratum, x.rules_yes, x.legacy_yes, x.rules_status, x.marine
		   FROM jsonb_to_recordset(p_items) AS x(species_code text, stratum text, rules_yes boolean, legacy_yes boolean,
		                                         rules_status text, marine boolean))
		UNION ALL
		(SELECT x.species_code, x.stratum, x.rules_yes, x.legacy_yes, x.rules_status, x.marine
		   FROM jsonb_to_recordset(p_items) AS x(species_code text, stratum text, rules_yes boolean, legacy_yes boolean,
		                                         rules_status text, marine boolean)
		 EXCEPT
		 SELECT species_code, stratum, rules_yes, legacy_yes, rules_status, marine FROM pg_temp.tag_eval_expected)
	) d;
	IF v_mismatch > 0 OR v_items <> (SELECT count(*) FROM pg_temp.tag_eval_expected) THEN
		RAISE EXCEPTION 'eval set: the items are not the seeded selection (% differ)', v_mismatch
			USING ERRCODE = 'integrity_constraint_violation';
	END IF;
	-- 5. The design records the selection and π_h; both must be exactly this.
	IF (SELECT coalesce(array_agg(species_code ORDER BY species_code COLLATE "C"), '{}') FROM pg_temp.tag_eval_expected)
	   IS DISTINCT FROM (SELECT coalesce(array_agg(x ORDER BY x COLLATE "C"), '{}') FROM jsonb_array_elements_text(p_design->'selectedCodes') x)
	   OR EXISTS (
		SELECT 1 FROM (VALUES ('A'), ('B'), ('C1'), ('C2'), ('U')) h(stratum)
		 WHERE (p_design->'N'->>h.stratum)::integer > 0
		   AND abs(coalesce((p_design->'pi'->>h.stratum)::double precision, -1)
		           - (p_design->'n'->>h.stratum)::double precision / (p_design->'N'->>h.stratum)::double precision) > 1e-12)
	THEN
		RAISE EXCEPTION 'eval set: design.selectedCodes / design.pi do not match the seeded selection'
			USING ERRCODE = 'integrity_constraint_violation';
	END IF;
	INSERT INTO public.tag_eval_set (tag, revision_id, design, frame_hash, gates, gates_sha256, gates_confirmed_by)
	VALUES (p_tag, p_revision_id, p_design, v_frame, p_gates,
	        encode(sha256(convert_to(p_gates::text, 'UTF8')), 'hex'), p_user_id)
	RETURNING id INTO v_id;
	INSERT INTO public.tag_eval_item
		(set_id, species_code, stratum, rules_yes, legacy_yes, rules_status, marine, inclusion_prob,
		 display_position, input_hash, eval_text_hash, article)
	SELECT v_id, e.species_code, e.stratum, e.rules_yes, e.legacy_yes, e.rules_status, e.marine,
	       (p_design->'n'->>e.stratum)::double precision / (p_design->'N'->>e.stratum)::double precision,
	       x.display_position, e.input_hash, x.eval_text_hash, x.article
	  FROM pg_temp.tag_eval_expected e
	  JOIN jsonb_to_recordset(p_items) AS x(species_code text, display_position integer, eval_text_hash text, article jsonb)
	    ON x.species_code = e.species_code;
	RETURN v_id;
END $$;

-- Write-once label for the page an item shows; only while its set labels.
CREATE FUNCTION public.record_tag_eval_label(p_set_id bigint, p_item_id bigint, p_user_id integer, p_label text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
	v_set public.tag_eval_set%ROWTYPE;
	v_item public.tag_eval_item%ROWTYPE;
	v_id uuid;
BEGIN
	IF p_label NOT IN ('yes', 'no', 'unsure') THEN
		RAISE EXCEPTION 'label: bad value %', p_label;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_user_id AND role = 'admin') THEN
		RAISE EXCEPTION 'label: user % is not an admin (audit check)', p_user_id;
	END IF;
	-- FOR SHARE: a freeze (FOR UPDATE) waits for in-flight labels, and vice versa.
	SELECT * INTO v_set FROM public.tag_eval_set WHERE id = p_set_id FOR SHARE;
	IF NOT FOUND OR v_set.status <> 'labelling' THEN
		RAISE EXCEPTION 'label: set % is not labelling', p_set_id;
	END IF;
	SELECT * INTO v_item FROM public.tag_eval_item WHERE id = p_item_id AND set_id = p_set_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'label: item % is not in set %', p_item_id, p_set_id;
	END IF;
	INSERT INTO public.tag_eval_label (tag, species_code, eval_text_hash, label, labeled_by, first_set_id)
	VALUES (v_set.tag, v_item.species_code, v_item.eval_text_hash, p_label, p_user_id, p_set_id)
	ON CONFLICT (tag, species_code, eval_text_hash) DO NOTHING
	RETURNING id INTO v_id;
	IF v_id IS NULL THEN
		RAISE EXCEPTION 'label: this page is already labelled (labels are write-once)'
			USING ERRCODE = 'unique_violation';
	END IF;
	RETURN v_id;
END $$;

CREATE FUNCTION public.freeze_tag_eval_set(p_set_id bigint, p_user_id integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
	v_set public.tag_eval_set%ROWTYPE;
	v_missing integer;
BEGIN
	IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_user_id AND role = 'admin') THEN
		RAISE EXCEPTION 'freeze: user % is not an admin (audit check)', p_user_id;
	END IF;
	SELECT * INTO v_set FROM public.tag_eval_set WHERE id = p_set_id FOR UPDATE;
	IF NOT FOUND OR v_set.status <> 'labelling' THEN
		RAISE EXCEPTION 'freeze: set % is not labelling', p_set_id;
	END IF;
	SELECT count(*) INTO v_missing
	  FROM public.tag_eval_item i
	  LEFT JOIN public.tag_eval_label l
	    ON l.tag = v_set.tag AND l.species_code = i.species_code AND l.eval_text_hash = i.eval_text_hash
	 WHERE i.set_id = p_set_id AND l.id IS NULL;
	IF v_missing > 0 THEN
		RAISE EXCEPTION 'freeze: % item(s) are not labelled', v_missing;
	END IF;
	UPDATE public.tag_eval_set SET status = 'frozen', frozen_by = p_user_id, frozen_at = now() WHERE id = p_set_id;
END $$;

CREATE FUNCTION public.abandon_tag_eval_set(p_set_id bigint, p_user_id integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_user_id AND role = 'admin') THEN
		RAISE EXCEPTION 'abandon: user % is not an admin (audit check)', p_user_id;
	END IF;
	UPDATE public.tag_eval_set SET status = 'abandoned', abandoned_at = now()
	 WHERE id = p_set_id AND status = 'labelling';
	IF NOT FOUND THEN
		RAISE EXCEPTION 'abandon: set % is not labelling', p_set_id;
	END IF;
END $$;

-- A gate report must name a frozen set of the same tag and revision and
-- carry that set's gates hash (no provisional exemption: benchmarks use the
-- dry-run switch instead of fake reports).
CREATE FUNCTION public.tag_report_gate_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
	IF NEW.kind = 'gate' AND NOT EXISTS (
		SELECT 1 FROM public.tag_eval_set s
		 WHERE s.id = (NEW.body->>'setId')::bigint AND s.status = 'frozen'
		   AND s.tag = NEW.tag AND s.revision_id = NEW.revision_id
		   AND s.gates_sha256 = NEW.body->>'gatesSha256'
	) THEN
		RAISE EXCEPTION 'gate report: body must name a frozen eval set of % revision % and its gates hash', NEW.tag, NEW.revision_id
			USING ERRCODE = 'integrity_constraint_violation';
	END IF;
	RETURN NEW;
END $$;
CREATE TRIGGER tag_report_gate_guard
	BEFORE INSERT ON public.tag_report
	FOR EACH ROW EXECUTE FUNCTION public.tag_report_gate_guard();

-- ── B4i activation: the gate is verified inside the exclusive switch ───────
DROP FUNCTION IF EXISTS public.switch_tag_ownership(text, bigint, bigint, bigint, integer, bigint);
CREATE FUNCTION public.switch_tag_ownership(
	p_tag text, p_revision_id bigint, p_gate_report_id bigint, p_benchmark_report_id bigint,
	p_user_id integer, p_engine_key bigint, p_dry_run boolean DEFAULT false
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
		 WHERE id = p_gate_report_id AND kind = 'gate' AND tag = p_tag AND revision_id = p_revision_id
		   AND body->>'passed' = 'true';
		IF NOT FOUND THEN
			RAISE EXCEPTION 'switch: no passing gate report % for % rev %', p_gate_report_id, p_tag, p_revision_id;
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
		(tag, revision_id, action, previous_activation_id, gate_report_id, benchmark_report_id, universe_hash, activated_by)
	VALUES (p_tag, p_revision_id, 'activate', v_prev,
	        CASE WHEN p_dry_run THEN NULL ELSE p_gate_report_id END,
	        CASE WHEN p_dry_run THEN NULL ELSE p_benchmark_report_id END,
	        v_universe, p_user_id)
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

-- ══ grants ═════════════════════════════════════════════════════════════════
DO $$
DECLARE
	t text;
BEGIN
	FOREACH t IN ARRAY ARRAY['tag_authoring_example', 'tag_eval_set', 'tag_eval_item', 'tag_eval_label'] LOOP
		EXECUTE format('REVOKE ALL ON public.%I FROM birds_app, PUBLIC', t);
		EXECUTE format('GRANT SELECT ON public.%I TO birds_app', t);
	END LOOP;
END $$;
DO $$
DECLARE
	s text;
BEGIN
	FOR s IN
		SELECT quote_ident(n.nspname) || '.' || quote_ident(c.relname)
		  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		 WHERE c.relkind = 'S' AND n.nspname = 'public' AND c.relname LIKE 'tag\_eval\_%\_seq'
	LOOP
		EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM birds_app, PUBLIC', s);
	END LOOP;
END $$;
DO $$
DECLARE
	f text;
BEGIN
	FOREACH f IN ARRAY ARRAY[
		'public.freeze_tag_authoring_set(text, text[])',
		'public.tag_eval_frame_hash(text, bigint, text[], text)',
		'public.create_tag_eval_set(text, bigint, jsonb, jsonb, jsonb, integer)',
		'public.record_tag_eval_label(bigint, bigint, integer, text)',
		'public.freeze_tag_eval_set(bigint, integer)',
		'public.abandon_tag_eval_set(bigint, integer)',
		'public.switch_tag_ownership(text, bigint, bigint, bigint, integer, bigint, boolean)'
	] LOOP
		EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
		EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO birds_app', f);
	END LOOP;
END $$;
-- Internal to the definers above; functions start PUBLIC-executable, so an
-- explicit revoke (CODEX1 rev-26 #2).
REVOKE ALL ON FUNCTION public.tag_eval_frame_rows(text, bigint, text[]) FROM PUBLIC, birds_app;
-- Owner role only: no app path may mint a cross-check.
REVOKE ALL ON FUNCTION public.record_tag_crosscheck(uuid, text, text, text) FROM PUBLIC, birds_app;
REVOKE ALL ON FUNCTION public.tag_eval_set_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tag_report_gate_guard() FROM PUBLIC;

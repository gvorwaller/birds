-- Release B (B2) of td-894144: the tag engine's database side.
-- Plan: docs/2026-09-26-ai-tag-accuracy-plan-CC.md rev 18, "Release B
-- implementation spec" §B2 (CODEX1: "B2: implement").
--
-- Owner principle: AI is never used to generate, drop or change a species
-- tag; only an approved, cross-checked, blind-tested ruleset does.
--
-- TRUST BOUNDARY (owner decision 2026-09-29, Option A): the web app and the
-- worker share birds_app and the app's own code is trusted. Everything below
-- — definer routines, CHECKs, immutability triggers, grants — is an
-- INTEGRITY guardrail against bugs, malformed data and AI output reaching
-- tags. It is not protection against hostile code running as birds_app.
--
-- Nothing here changes any tag: no tag is owned until an activation, which
-- requires an approved revision plus passing gate and benchmark reports.
--
-- Blind-labelling tables (tag_eval_*) arrive with B4's migration, where they
-- are first used.
--
-- Wrapped in one transaction by migrate_pg.sh.

-- ── helpers ───────────────────────────────────────────────────────────────
CREATE FUNCTION public.tag_is_hex64(v text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
	SELECT v ~ '^[0-9a-f]{64}$'
$$;

-- Immutability for append-only history tables. A cascade from
-- species_enrichment (fixture cleanup, retired species) is a trigger-driven
-- delete (depth ≥ 2) and is allowed; a direct UPDATE/DELETE is not.
--
-- Owned TEST fixtures only: in the birds_test database, the owner role with
-- the transaction-local flag birds.tag_fixture = 'on' may delete (same
-- triple key as Release A's legacy guard). Production's database name fails
-- the first condition.
CREATE FUNCTION public.tag_reject_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
	IF TG_OP = 'DELETE' AND pg_trigger_depth() >= 2 THEN
		RETURN OLD;
	END IF;
	IF TG_OP = 'DELETE' AND current_database() = 'birds_test' AND current_user = 'birds_owner'
	   AND coalesce(current_setting('birds.tag_fixture', true), '') = 'on' THEN
		RETURN OLD;
	END IF;
	RAISE EXCEPTION '% rows are immutable (td-894144)', TG_TABLE_NAME
		USING ERRCODE = 'insufficient_privilege';
END $$;

-- ── attempt numbers (failure-log ordering) ────────────────────────────────
CREATE SEQUENCE public.tag_attempt_seq;

-- ── the other-taxon lexicon fingerprint (singleton) ───────────────────────
-- Maintained by replaceTaxonomy (exclusive lock) and bootstrap; read by the
-- wiki entry points (shared lock) so they need not re-read the taxonomy.
CREATE TABLE public.tag_lexicon_state (
	id smallint PRIMARY KEY CHECK (id = 1),
	lexicon_hash text NOT NULL CHECK (public.tag_is_hex64(lexicon_hash)),
	scanner_rev text NOT NULL,
	built_at timestamptz NOT NULL DEFAULT now()
);

-- ── authoritative current input per universe member ───────────────────────
CREATE TABLE public.species_tag_input (
	species_code text PRIMARY KEY REFERENCES public.species_enrichment (species_code) ON DELETE CASCADE,
	input_hash text NOT NULL CHECK (public.tag_is_hex64(input_hash)),
	text_hash text NOT NULL CHECK (public.tag_is_hex64(text_hash)),
	order_name text,
	family_sci_name text,
	lexicon_hash text NOT NULL CHECK (public.tag_is_hex64(lexicon_hash)),
	focal_exempt_hash text NOT NULL CHECK (public.tag_is_hex64(focal_exempt_hash)),
	scanner_rev text NOT NULL,
	updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── proposals (AI or human drafts; never executed) ────────────────────────
CREATE TABLE public.tag_rule_proposal (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	tag text NOT NULL,
	artifact jsonb NOT NULL,
	artifact_sha256 text,
	source text NOT NULL CHECK (source IN ('ai', 'human')),
	status text NOT NULL DEFAULT 'proposed'
		CHECK (status IN ('proposed', 'crosschecked', 'approved', 'rejected')),
	ai_usage_call_id uuid,
	created_at timestamptz NOT NULL DEFAULT now(),
	CHECK (artifact_sha256 IS NULL OR public.tag_is_hex64(artifact_sha256))
);

-- The hash is the PostgreSQL-normalized STORAGE identity of the jsonb value
-- (plan rev 13 hash-byte contract): encode(sha256(convert_to(artifact::text,
-- 'UTF8')),'hex'). Not a generated column: convert_to() is STABLE in PG17.
CREATE FUNCTION public.tag_artifact_sha256(a jsonb) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
	SELECT encode(sha256(convert_to(a::text, 'UTF8')), 'hex')
$$;

CREATE FUNCTION public.tag_rule_proposal_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		NEW.artifact_sha256 := public.tag_artifact_sha256(NEW.artifact);
		NEW.status := 'proposed';
		RETURN NEW;
	END IF;
	IF NEW.artifact IS DISTINCT FROM OLD.artifact
	   OR NEW.artifact_sha256 IS DISTINCT FROM OLD.artifact_sha256
	   OR NEW.tag IS DISTINCT FROM OLD.tag
	   OR NEW.source IS DISTINCT FROM OLD.source
	   OR NEW.id IS DISTINCT FROM OLD.id
	   OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
		RAISE EXCEPTION 'tag_rule_proposal: only status may change (td-894144)'
			USING ERRCODE = 'insufficient_privilege';
	END IF;
	RETURN NEW;
END $$;
CREATE TRIGGER tag_rule_proposal_guard
	BEFORE INSERT OR UPDATE ON public.tag_rule_proposal
	FOR EACH ROW EXECUTE FUNCTION public.tag_rule_proposal_guard();
CREATE TRIGGER tag_rule_proposal_no_delete
	BEFORE DELETE ON public.tag_rule_proposal
	FOR EACH ROW EXECUTE FUNCTION public.tag_reject_mutation();

-- ── cross-checks (recorded by the agent session, owner role) ───────────────
CREATE TABLE public.tag_crosscheck (
	id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	proposal_id uuid NOT NULL REFERENCES public.tag_rule_proposal (id),
	reviewer text NOT NULL,
	verdict text NOT NULL CHECK (verdict IN ('approve', 'changes', 'reject')),
	text text NOT NULL,
	reviewed_sha256 text NOT NULL CHECK (public.tag_is_hex64(reviewed_sha256)),
	created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER tag_crosscheck_immutable
	BEFORE UPDATE OR DELETE ON public.tag_crosscheck
	FOR EACH ROW EXECUTE FUNCTION public.tag_reject_mutation();

-- ── approved revisions (immutable) ────────────────────────────────────────
CREATE TABLE public.tag_revision (
	id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	tag text NOT NULL,
	source text NOT NULL CHECK (source IN ('rules', 'model')),
	artifact jsonb NOT NULL,
	artifact_sha256 text NOT NULL CHECK (public.tag_is_hex64(artifact_sha256)),
	proposal_id uuid REFERENCES public.tag_rule_proposal (id),
	crosscheck_id bigint REFERENCES public.tag_crosscheck (id),
	approved_by integer NOT NULL,
	approved_at timestamptz NOT NULL DEFAULT now(),
	dependency_activation_ids bigint[] NOT NULL DEFAULT '{}',
	UNIQUE (id, tag)
);
CREATE TRIGGER tag_revision_immutable
	BEFORE UPDATE OR DELETE ON public.tag_revision
	FOR EACH ROW EXECUTE FUNCTION public.tag_reject_mutation();

-- ── reports (stage, simulation, gate, benchmark, consistency) ─────────────
CREATE TABLE public.tag_report (
	id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	kind text NOT NULL CHECK (kind IN ('stage', 'simulation', 'gate', 'benchmark', 'consistency')),
	tag text NOT NULL,
	revision_id bigint,
	body jsonb NOT NULL,
	body_sha256 text NOT NULL CHECK (public.tag_is_hex64(body_sha256)),
	created_at timestamptz NOT NULL DEFAULT now(),
	FOREIGN KEY (revision_id, tag) REFERENCES public.tag_revision (id, tag)
);
CREATE TRIGGER tag_report_immutable
	BEFORE UPDATE OR DELETE ON public.tag_report
	FOR EACH ROW EXECUTE FUNCTION public.tag_reject_mutation();

-- ── activation history (append-only) and the ownership pointer ────────────
CREATE TABLE public.tag_activation (
	id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	tag text NOT NULL,
	revision_id bigint,
	action text NOT NULL CHECK (action IN ('activate', 'rollback', 'to_legacy')),
	previous_activation_id bigint REFERENCES public.tag_activation (id),
	gate_report_id bigint REFERENCES public.tag_report (id),
	benchmark_report_id bigint REFERENCES public.tag_report (id),
	universe_hash text CHECK (universe_hash IS NULL OR public.tag_is_hex64(universe_hash)),
	activated_by integer NOT NULL,
	activated_at timestamptz NOT NULL DEFAULT now(),
	FOREIGN KEY (revision_id, tag) REFERENCES public.tag_revision (id, tag),
	CHECK ((action = 'to_legacy') = (revision_id IS NULL))
);
CREATE TRIGGER tag_activation_immutable
	BEFORE UPDATE OR DELETE ON public.tag_activation
	FOR EACH ROW EXECUTE FUNCTION public.tag_reject_mutation();

CREATE TABLE public.tag_ownership (
	tag text PRIMARY KEY,
	activation_id bigint NOT NULL REFERENCES public.tag_activation (id)
);

-- ── per-species, per-revision, per-input results (immutable) ───────────────
CREATE TABLE public.species_tag_state (
	state_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	species_code text NOT NULL REFERENCES public.species_enrichment (species_code) ON DELETE CASCADE,
	tag text NOT NULL,
	revision_id bigint NOT NULL,
	input_hash text NOT NULL CHECK (public.tag_is_hex64(input_hash)),
	status text NOT NULL CHECK (status IN ('assigned', 'not_assigned', 'unevaluated')),
	reason text,
	evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
	scanner_rev text NOT NULL,
	materialized_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (species_code, tag, revision_id, input_hash),
	FOREIGN KEY (revision_id, tag) REFERENCES public.tag_revision (id, tag),
	CHECK (jsonb_typeof(evidence) = 'array'),
	CHECK (
		(status = 'assigned' AND reason IS NULL
		   AND jsonb_array_length(evidence) BETWEEN 1 AND 3)
		OR (status = 'not_assigned' AND jsonb_array_length(evidence) = 0
		   AND reason ~ '^(no_support|no_focal_support|excluded:[\w:.-]+|taxon_forbid:[\w.-]+|requires_unmet:[\w.-]+|below_threshold|evidence_gate_failed)$')
		OR (status = 'unevaluated' AND jsonb_array_length(evidence) = 0
		   AND reason IN ('no_article', 'wiki_not_ok', 'taxon_unknown', 'dependency_unevaluated', 'awaiting_model_score'))
	)
);
CREATE INDEX species_tag_state_rev_input_idx ON public.species_tag_state (revision_id, species_code, input_hash);
CREATE TRIGGER species_tag_state_immutable
	BEFORE UPDATE OR DELETE ON public.species_tag_state
	FOR EACH ROW EXECUTE FUNCTION public.tag_reject_mutation();

-- ── materialization failures (monotone by attempt number) ─────────────────
CREATE TABLE public.tag_materialization_failure (
	key text PRIMARY KEY,
	species_code text,
	entry_point text,
	error text,
	first_failed_at timestamptz,
	last_failed_at timestamptz,
	last_attempt_no bigint NOT NULL DEFAULT 0,
	attempts integer NOT NULL DEFAULT 0,
	cleared_at timestamptz,
	cleared_by_attempt_no bigint NOT NULL DEFAULT 0
);

-- ── nightly consistency runs (immutable) ──────────────────────────────────
CREATE TABLE public.tag_consistency_run (
	id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	started_at timestamptz NOT NULL,
	finished_at timestamptz NOT NULL,
	checked integer NOT NULL,
	fixed_by_reason jsonb NOT NULL DEFAULT '{}'::jsonb,
	failures jsonb NOT NULL DEFAULT '[]'::jsonb,
	status text NOT NULL CHECK (status IN ('clean', 'fixed', 'failed'))
);
CREATE TRIGGER tag_consistency_run_immutable
	BEFORE UPDATE OR DELETE ON public.tag_consistency_run
	FOR EACH ROW EXECUTE FUNCTION public.tag_reject_mutation();

-- ══ definer routines ═══════════════════════════════════════════════════════
-- All: SECURITY DEFINER (owner birds_owner), pinned search_path, schema-
-- qualified objects, EXECUTE revoked from PUBLIC and granted to birds_app.

CREATE FUNCTION public.begin_tag_attempt() RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
	SELECT nextval('public.tag_attempt_seq')
$$;

CREATE FUNCTION public.record_materialization_failure(
	p_key text, p_species_code text, p_entry_point text, p_error text, p_attempt_no bigint
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
	INSERT INTO public.tag_materialization_failure AS f
		(key, species_code, entry_point, error, first_failed_at, last_failed_at, last_attempt_no, attempts, cleared_at)
	VALUES (p_key, p_species_code, p_entry_point, left(p_error, 500), now(), now(), p_attempt_no, 1, NULL)
	ON CONFLICT (key) DO UPDATE SET
		species_code = EXCLUDED.species_code,
		entry_point = EXCLUDED.entry_point,
		error = EXCLUDED.error,
		first_failed_at = CASE WHEN f.cleared_at IS NOT NULL OR f.first_failed_at IS NULL THEN now() ELSE f.first_failed_at END,
		last_failed_at = now(),
		last_attempt_no = p_attempt_no,
		attempts = CASE WHEN f.cleared_at IS NOT NULL THEN 1 ELSE f.attempts + 1 END,
		cleared_at = NULL
	-- Monotone: a stamp older than the latest failure OR the latest clear is ignored.
	WHERE p_attempt_no > f.last_attempt_no AND p_attempt_no > f.cleared_by_attempt_no;
END $$;

CREATE FUNCTION public.clear_materialization_failure(p_key text, p_attempt_no bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
	-- A tombstone even when no failure row exists, so an older failure stamp
	-- that lands later can never resurrect a failure this success superseded.
	INSERT INTO public.tag_materialization_failure AS f (key, cleared_at, cleared_by_attempt_no)
	VALUES (p_key, now(), p_attempt_no)
	ON CONFLICT (key) DO UPDATE SET
		cleared_at = CASE WHEN p_attempt_no > f.last_attempt_no THEN now() ELSE f.cleared_at END,
		cleared_by_attempt_no = greatest(f.cleared_by_attempt_no, p_attempt_no);
END $$;

CREATE FUNCTION public.set_tag_lexicon_state(p_lexicon_hash text, p_scanner_rev text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
	IF NOT public.tag_is_hex64(p_lexicon_hash) THEN
		RAISE EXCEPTION 'bad lexicon hash';
	END IF;
	INSERT INTO public.tag_lexicon_state (id, lexicon_hash, scanner_rev, built_at)
	VALUES (1, p_lexicon_hash, p_scanner_rev, now())
	ON CONFLICT (id) DO UPDATE SET lexicon_hash = EXCLUDED.lexicon_hash,
		scanner_rev = EXCLUDED.scanner_rev, built_at = now()
	WHERE public.tag_lexicon_state.lexicon_hash IS DISTINCT FROM EXCLUDED.lexicon_hash
	   OR public.tag_lexicon_state.scanner_rev IS DISTINCT FROM EXCLUDED.scanner_rev;
END $$;

-- input_hash is computed HERE from the canonical jsonb text of the context.
CREATE FUNCTION public.record_tag_input(
	p_code text, p_text_hash text, p_order_name text, p_family_sci_name text,
	p_lexicon_hash text, p_focal_exempt_hash text, p_scanner_rev text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
	v_hash text;
BEGIN
	IF NOT (public.tag_is_hex64(p_text_hash) AND public.tag_is_hex64(p_lexicon_hash)
	        AND public.tag_is_hex64(p_focal_exempt_hash)) OR coalesce(p_scanner_rev, '') = '' THEN
		RAISE EXCEPTION 'record_tag_input: malformed input context for %', p_code;
	END IF;
	v_hash := encode(sha256(convert_to(jsonb_build_object(
		'text_hash', p_text_hash, 'order', p_order_name, 'family', p_family_sci_name,
		'lexicon_hash', p_lexicon_hash, 'focal_exempt_hash', p_focal_exempt_hash,
		'scanner_rev', p_scanner_rev)::text, 'UTF8')), 'hex');
	INSERT INTO public.species_tag_input AS i
		(species_code, input_hash, text_hash, order_name, family_sci_name, lexicon_hash, focal_exempt_hash, scanner_rev, updated_at)
	VALUES (p_code, v_hash, p_text_hash, p_order_name, p_family_sci_name, p_lexicon_hash, p_focal_exempt_hash, p_scanner_rev, now())
	ON CONFLICT (species_code) DO UPDATE SET
		input_hash = EXCLUDED.input_hash, text_hash = EXCLUDED.text_hash,
		order_name = EXCLUDED.order_name, family_sci_name = EXCLUDED.family_sci_name,
		lexicon_hash = EXCLUDED.lexicon_hash, focal_exempt_hash = EXCLUDED.focal_exempt_hash,
		scanner_rev = EXCLUDED.scanner_rev, updated_at = now()
	WHERE i.input_hash IS DISTINCT FROM EXCLUDED.input_hash;
	RETURN v_hash;
END $$;

CREATE FUNCTION public.delete_tag_input(p_code text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
	DELETE FROM public.species_tag_input WHERE species_code = p_code
$$;

CREATE FUNCTION public.record_tag_state(
	p_code text, p_revision_id bigint, p_tag text, p_input_hash text,
	p_status text, p_reason text, p_evidence jsonb, p_scanner_rev text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
	v_current text;
	v_current_scanner text;
	v_existing public.species_tag_state%ROWTYPE;
BEGIN
	SELECT input_hash, scanner_rev INTO v_current, v_current_scanner
	  FROM public.species_tag_input WHERE species_code = p_code;
	IF v_current IS DISTINCT FROM p_input_hash THEN
		RAISE EXCEPTION 'record_tag_state: stale or missing input for % (have %, got %)', p_code, v_current, p_input_hash
			USING ERRCODE = 'serialization_failure';
	END IF;
	IF v_current_scanner IS DISTINCT FROM p_scanner_rev THEN
		RAISE EXCEPTION 'record_tag_state: scanner revision does not match current input for % (have %, got %)',
			p_code, v_current_scanner, p_scanner_rev
			USING ERRCODE = 'integrity_constraint_violation';
	END IF;
	SELECT * INTO v_existing FROM public.species_tag_state
	 WHERE species_code = p_code AND tag = p_tag AND revision_id = p_revision_id AND input_hash = p_input_hash;
	IF FOUND THEN
		IF v_existing.status IS DISTINCT FROM p_status
		   OR v_existing.reason IS DISTINCT FROM p_reason
		   OR v_existing.evidence IS DISTINCT FROM coalesce(p_evidence, '[]'::jsonb)
		   OR v_existing.scanner_rev IS DISTINCT FROM p_scanner_rev THEN
			RAISE EXCEPTION 'record_tag_state: conflicting result for % % rev % (integrity)', p_code, p_tag, p_revision_id
				USING ERRCODE = 'integrity_constraint_violation';
		END IF;
		RETURN;
	END IF;
	-- The composite FK checks the revision exists and belongs to p_tag.
	INSERT INTO public.species_tag_state
		(species_code, tag, revision_id, input_hash, status, reason, evidence, scanner_rev)
	VALUES (p_code, p_tag, p_revision_id, p_input_hash, p_status, p_reason, coalesce(p_evidence, '[]'::jsonb), p_scanner_rev);
END $$;

-- The one writer of `tags` (plus the Release A owner fixtures). Ordered
-- merge: base = legacy_tags when present, else current tags; remove every
-- OWNED tag (order kept); append owned tags whose CURRENT state — joined
-- through species_tag_input — is 'assigned', alphabetically. Writes only on
-- change, so an unchanged row never fires the search-vector trigger.
CREATE FUNCTION public.apply_effective_tags(p_code text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
	v_base text[];
	v_new text[];
BEGIN
	SELECT coalesce(se.legacy_tags, se.tags) INTO v_base
	  FROM public.species_enrichment se WHERE se.species_code = p_code;
	IF NOT FOUND THEN
		RETURN;
	END IF;
	SELECT coalesce(array_agg(t ORDER BY ord), '{}')
	  INTO v_new
	  FROM (
		SELECT t, ord FROM unnest(v_base) WITH ORDINALITY AS b(t, ord)
		 WHERE NOT EXISTS (SELECT 1 FROM public.tag_ownership o WHERE o.tag = b.t)
		UNION ALL
		SELECT s.tag, 1000000 + row_number() OVER (ORDER BY s.tag)
		  FROM public.tag_ownership o
		  JOIN public.tag_activation a ON a.id = o.activation_id AND a.revision_id IS NOT NULL
		  JOIN public.species_tag_input i ON i.species_code = p_code
		  JOIN public.species_tag_state s
		    ON s.species_code = p_code AND s.tag = o.tag AND s.revision_id = a.revision_id
		   AND s.input_hash = i.input_hash AND s.status = 'assigned'
	  ) merged;
	UPDATE public.species_enrichment SET tags = v_new
	 WHERE species_code = p_code AND tags IS DISTINCT FROM v_new;
END $$;

CREATE FUNCTION public.record_tag_report(p_kind text, p_tag text, p_revision_id bigint, p_body jsonb)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
	v_id bigint;
BEGIN
	INSERT INTO public.tag_report (kind, tag, revision_id, body, body_sha256)
	VALUES (p_kind, p_tag, p_revision_id, p_body, public.tag_artifact_sha256(p_body))
	RETURNING id INTO v_id;
	RETURN v_id;
END $$;

-- user_id is AUDIT data, not authentication (Option A): the admin route and
-- the worker's execution-time role recheck are the auth boundary.
CREATE FUNCTION public.approve_tag_proposal(p_proposal_id uuid, p_user_id integer) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
	v_prop public.tag_rule_proposal%ROWTYPE;
	v_hash text;
	v_check public.tag_crosscheck%ROWTYPE;
	v_rev bigint;
BEGIN
	SELECT * INTO v_prop FROM public.tag_rule_proposal WHERE id = p_proposal_id FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'approve: no proposal %', p_proposal_id;
	END IF;
	IF v_prop.status NOT IN ('proposed', 'crosschecked') THEN
		RAISE EXCEPTION 'approve: proposal is %', v_prop.status;
	END IF;
	v_hash := public.tag_artifact_sha256(v_prop.artifact);
	IF v_hash IS DISTINCT FROM v_prop.artifact_sha256 THEN
		RAISE EXCEPTION 'approve: artifact hash mismatch (integrity)';
	END IF;
	IF v_prop.tag IS DISTINCT FROM v_prop.artifact->>'tag' THEN
		RAISE EXCEPTION 'approve: proposal tag % does not match artifact tag %', v_prop.tag, v_prop.artifact->>'tag';
	END IF;
	SELECT * INTO v_check FROM public.tag_crosscheck
	 WHERE proposal_id = p_proposal_id AND reviewed_sha256 = v_hash AND verdict = 'approve'
	 ORDER BY id DESC LIMIT 1;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'approve: no approving cross-check for this exact artifact';
	END IF;
	IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_user_id AND role = 'admin') THEN
		RAISE EXCEPTION 'approve: user % is not an admin (audit check)', p_user_id;
	END IF;
	INSERT INTO public.tag_revision (tag, source, artifact, artifact_sha256, proposal_id, crosscheck_id, approved_by)
	VALUES (v_prop.tag, 'rules', v_prop.artifact, v_hash, p_proposal_id, v_check.id, p_user_id)
	RETURNING id INTO v_rev;
	UPDATE public.tag_rule_proposal SET status = 'approved' WHERE id = p_proposal_id;
	RETURN v_rev;
END $$;

-- Universe: species with a stored article and a current species taxonomy row.
CREATE FUNCTION public.tag_universe_codes() RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
	SELECT se.species_code
	  FROM public.species_enrichment se
	  JOIN public.taxonomy_cache tc ON tc.species_code = se.species_code AND tc.category = 'species'
	 WHERE se.wikipedia_extract IS NOT NULL
$$;

-- Must run inside a transaction holding the EXCLUSIVE tag_engine lock (the
-- worker's withTagWriteTx path); it re-asserts that and every precondition.
CREATE FUNCTION public.switch_tag_ownership(
	p_tag text, p_revision_id bigint, p_gate_report_id bigint, p_benchmark_report_id bigint,
	p_user_id integer, p_engine_key bigint
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
	v_rev public.tag_revision%ROWTYPE;
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
	IF NOT EXISTS (
		SELECT 1 FROM pg_locks
		 WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND mode = 'ExclusiveLock' AND granted
		   -- TAG_ENGINE_KEY is deliberately positive and below 2^32, so the
		   -- single-bigint lock appears as classid=0,objid=894144.
		   AND ((classid::bigint << 32) | objid::bigint) = 894144::bigint
	) THEN
		RAISE EXCEPTION 'switch: exclusive tag_engine lock not held';
	END IF;
	SELECT * INTO v_rev FROM public.tag_revision WHERE id = p_revision_id AND tag = p_tag;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'switch: revision % is not an approved revision of %', p_revision_id, p_tag;
	END IF;
	IF public.tag_artifact_sha256(v_rev.artifact) IS DISTINCT FROM v_rev.artifact_sha256 THEN
		RAISE EXCEPTION 'switch: revision artifact hash mismatch (integrity)';
	END IF;
	IF NOT EXISTS (SELECT 1 FROM public.tag_report WHERE id = p_gate_report_id AND kind = 'gate'
	                AND tag = p_tag AND revision_id = p_revision_id AND body->>'passed' = 'true') THEN
		RAISE EXCEPTION 'switch: no passing gate report % for % rev %', p_gate_report_id, p_tag, p_revision_id;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM public.tag_report WHERE id = p_benchmark_report_id AND kind = 'benchmark'
	                AND tag = p_tag AND revision_id = p_revision_id AND body->>'passed' = 'true') THEN
		RAISE EXCEPTION 'switch: no passing benchmark report % for % rev %', p_benchmark_report_id, p_tag, p_revision_id;
	END IF;
	IF EXISTS (
		SELECT 1 FROM unnest(v_rev.dependency_activation_ids) d(aid)
		 WHERE NOT EXISTS (SELECT 1 FROM public.tag_ownership o WHERE o.activation_id = d.aid)
	) THEN
		RAISE EXCEPTION 'switch: a dependency activation is not active';
	END IF;
	-- Coverage: every member has a current input and exactly one state for
	-- (revision, current input). Pointers for non-members are extras.
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
	VALUES (p_tag, p_revision_id, 'activate', v_prev, p_gate_report_id, p_benchmark_report_id, v_universe, p_user_id)
	RETURNING id INTO v_act;
	INSERT INTO public.tag_ownership (tag, activation_id) VALUES (p_tag, v_act)
	ON CONFLICT (tag) DO UPDATE SET activation_id = EXCLUDED.activation_id;
	-- Candidate set: species whose tags contain the tag ∪ newly assigned.
	FOR r IN
		SELECT se.species_code FROM public.species_enrichment se WHERE p_tag = ANY (se.tags)
		UNION
		SELECT s.species_code FROM public.species_tag_state s
		  JOIN public.species_tag_input i ON i.species_code = s.species_code AND i.input_hash = s.input_hash
		 WHERE s.tag = p_tag AND s.revision_id = p_revision_id AND s.status = 'assigned'
	LOOP
		PERFORM public.apply_effective_tags(r.species_code);
	END LOOP;
	RETURN v_act;
END $$;

-- Roll back to the previous activation's revision, or to legacy.
CREATE FUNCTION public.rollback_tag(p_tag text, p_user_id integer, p_engine_key bigint) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
	v_cur public.tag_activation%ROWTYPE;
	v_prev public.tag_activation%ROWTYPE;
	v_act bigint;
	r record;
BEGIN
	IF p_engine_key IS DISTINCT FROM 894144::bigint THEN
		RAISE EXCEPTION 'rollback: wrong tag_engine lock key %', p_engine_key;
	END IF;
	IF NOT EXISTS (
		SELECT 1 FROM pg_locks
		 WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND mode = 'ExclusiveLock' AND granted
		   AND ((classid::bigint << 32) | objid::bigint) = 894144::bigint
	) THEN
		RAISE EXCEPTION 'rollback: exclusive tag_engine lock not held';
	END IF;
	SELECT a.* INTO v_cur FROM public.tag_ownership o JOIN public.tag_activation a ON a.id = o.activation_id WHERE o.tag = p_tag;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'rollback: % is not owned', p_tag;
	END IF;
	IF v_cur.previous_activation_id IS NOT NULL THEN
		SELECT * INTO v_prev FROM public.tag_activation WHERE id = v_cur.previous_activation_id;
	END IF;
	-- previous_activation_id means "where a rollback of THIS row returns to".
	-- A rollback row inherits its target's predecessor, so rolling back twice
	-- steps further back (R2 → R1 → legacy) instead of bouncing to R2.
	IF v_prev.id IS NOT NULL AND v_prev.revision_id IS NOT NULL THEN
		INSERT INTO public.tag_activation (tag, revision_id, action, previous_activation_id, activated_by)
		VALUES (p_tag, v_prev.revision_id, 'rollback', v_prev.previous_activation_id, p_user_id) RETURNING id INTO v_act;
		UPDATE public.tag_ownership SET activation_id = v_act WHERE tag = p_tag;
	ELSE
		INSERT INTO public.tag_activation (tag, revision_id, action, previous_activation_id, activated_by)
		VALUES (p_tag, NULL, 'to_legacy', NULL, p_user_id) RETURNING id INTO v_act;
		DELETE FROM public.tag_ownership WHERE tag = p_tag;
	END IF;
	-- Candidate set: species carrying the tag now ∪ assigned under the target
	-- revision ∪ carrying it in legacy (a return to legacy restores it).
	FOR r IN
		SELECT se.species_code FROM public.species_enrichment se
		 WHERE p_tag = ANY (se.tags) OR p_tag = ANY (coalesce(se.legacy_tags, '{}'))
		UNION
		SELECT s.species_code FROM public.species_tag_state s
		  JOIN public.species_tag_input i ON i.species_code = s.species_code AND i.input_hash = s.input_hash
		 WHERE s.tag = p_tag AND s.revision_id = v_prev.revision_id AND s.status = 'assigned'
	LOOP
		PERFORM public.apply_effective_tags(r.species_code);
	END LOOP;
	-- A NULL legacy_tags means this species had no legacy tag result at the
	-- Release-A cutover. Once ownership is removed, apply_effective_tags falls
	-- back to the current tags array; without this explicit removal it would
	-- preserve the just-retired engine result as though it were legacy.
	IF v_prev.id IS NULL OR v_prev.revision_id IS NULL THEN
		UPDATE public.species_enrichment
		   SET tags = array_remove(tags, p_tag)
		 WHERE legacy_tags IS NULL AND p_tag = ANY (tags);
	END IF;
	RETURN v_act;
END $$;

CREATE FUNCTION public.record_tag_consistency_run(
	p_started_at timestamptz, p_checked integer, p_fixed jsonb, p_failures jsonb, p_status text
) RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
	INSERT INTO public.tag_consistency_run (started_at, finished_at, checked, fixed_by_reason, failures, status)
	VALUES (p_started_at, now(), p_checked, p_fixed, p_failures, p_status)
	RETURNING id
$$;

-- ══ grants: undo 0002's default privileges first, then the exact matrix ══
DO $$
DECLARE
	t text;
BEGIN
	FOREACH t IN ARRAY ARRAY[
		'tag_lexicon_state', 'species_tag_input', 'tag_rule_proposal', 'tag_crosscheck',
		'tag_revision', 'tag_report', 'tag_activation', 'tag_ownership', 'species_tag_state',
		'tag_materialization_failure', 'tag_consistency_run'
	] LOOP
		EXECUTE format('REVOKE ALL ON public.%I FROM birds_app, PUBLIC', t);
		EXECUTE format('GRANT SELECT ON public.%I TO birds_app', t);
	END LOOP;
END $$;
-- Every identity sequence and the attempt sequence: no access (definers only).
DO $$
DECLARE
	s text;
BEGIN
	FOR s IN
		SELECT quote_ident(n.nspname) || '.' || quote_ident(c.relname)
		  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		 WHERE c.relkind = 'S' AND n.nspname = 'public'
		   AND (c.relname = 'tag_attempt_seq' OR c.relname LIKE 'tag\_%\_id\_seq' OR c.relname LIKE 'species\_tag\_%\_seq')
	LOOP
		EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM birds_app, PUBLIC', s);
	END LOOP;
END $$;
-- The one directly writable table for the app: AI/human drafts.
GRANT INSERT (tag, artifact, source, ai_usage_call_id) ON public.tag_rule_proposal TO birds_app;

DO $$
DECLARE
	f text;
BEGIN
	FOREACH f IN ARRAY ARRAY[
		'public.tag_is_hex64(text)',
		'public.tag_artifact_sha256(jsonb)',
		'public.begin_tag_attempt()',
		'public.record_materialization_failure(text, text, text, text, bigint)',
		'public.clear_materialization_failure(text, bigint)',
		'public.set_tag_lexicon_state(text, text)',
		'public.record_tag_input(text, text, text, text, text, text, text)',
		'public.delete_tag_input(text)',
		'public.record_tag_state(text, bigint, text, text, text, text, jsonb, text)',
		'public.apply_effective_tags(text)',
		'public.record_tag_report(text, text, bigint, jsonb)',
		'public.approve_tag_proposal(uuid, integer)',
		'public.tag_universe_codes()',
		'public.switch_tag_ownership(text, bigint, bigint, bigint, integer, bigint)',
		'public.rollback_tag(text, integer, bigint)',
		'public.record_tag_consistency_run(timestamptz, integer, jsonb, jsonb, text)'
	] LOOP
		EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
		EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO birds_app', f);
	END LOOP;
END $$;

-- td-894144 B5 Phase 1 (plan docs/2026-09-30-open-ocean-rules-v2-plan.md,
-- rev 14, CODEX1 PASS): schema-2 rules (taxon assign, genus, scoped
-- support), Preview, the family reference for blind tests, and per-claim job
-- fencing.
--
--  * jobs.claim_seq — a per-claim identity (incremented by every claim, never
--    refunded) that the holder's fenced transitions carry (§3z);
--  * species_tag_input.genus + tag_input_hash(): ONE SQL encoder for the input
--    hash, used by record_tag_input and by Preview's currentness check (§3k);
--  * species_tag_state evidence shapes validated at the boundary (§3e);
--  * tag_rule_proposal.schema_version NOT NULL CHECK IN (1, 2) (§3n) and a
--    definer for human proposals (§3x; the AI path keeps its column INSERT
--    until Phase 2 adds round-bound AI proposals);
--  * Preview: tag_preview_design (DB-authoritative, pinned per tag),
--    tag_corpus_fingerprint(), tag_proposal_preview (immutable, completed
--    only) and its one writer record_tag_preview (§3d/§3j/§3o/§3t);
--  * the cross-check binds the one current Preview; approval re-verifies it
--    under the exclusive engine lock (§3g);
--  * tag_family_reference + frame v2 + tag_eval_item.family_reference: each
--    blind-test page carries a frozen copy of its family's Wikipedia lead,
--    bound into the frame hash (§4, owner decision (b));
--  * integrity: taxon_overlap for owned schema-2 revisions; new tables in the
--    runtime-role grant audit.
--
-- Wrapped in one transaction by migrate_pg.sh.

-- ── job types and the claim identity ───────────────────────────────────────
ALTER TABLE jobs DROP CONSTRAINT jobs_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_type_check CHECK (type IN
	('load_hotspots','load_region','analyze_counties','refresh_loc','retry_loc','sync_lifelist',
	 'sync_taxonomy','scan_need_alerts','enrich_species','scan_enrichment','enrich_species_media',
	 'enrich_species_inat','enrich_families','tag_repair',
	 'tag_consistency','tag_stage','tag_benchmark','tag_activate','tag_retire','tag_rollback',
	 'tag_draft_rules','tag_design_simulation','tag_eval_create','tag_gate_report',
	 'tag_preview','tag_family_refs'));

ALTER TABLE jobs ADD COLUMN claim_seq bigint NOT NULL DEFAULT 0;

-- ── the shared engine lock assertion (mirror of the exclusive one) ─────────
CREATE FUNCTION public.tag_assert_shared_engine_lock(p_context text) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_locks
		 WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND mode IN ('ShareLock', 'ExclusiveLock') AND granted
		   AND ((classid::bigint << 32) | objid::bigint) = 894144::bigint
	) THEN
		RAISE EXCEPTION '%: tag_engine lock not held', p_context;
	END IF;
END $$;

-- ── genus in the input, one input-hash encoder ─────────────────────────────
ALTER TABLE public.species_tag_input ADD COLUMN genus text;

-- The canonical input hash. record_tag_input stores it; Preview recomputes it
-- for every universe member and refuses unless it equals the stored one.
CREATE FUNCTION public.tag_input_hash(
	p_text_hash text, p_order_name text, p_family_sci_name text, p_genus text,
	p_lexicon_hash text, p_focal_exempt_hash text, p_scanner_rev text
) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
	SELECT encode(sha256(convert_to(jsonb_build_object(
		'text_hash', p_text_hash, 'order', p_order_name, 'family', p_family_sci_name,
		'genus', p_genus, 'lexicon_hash', p_lexicon_hash,
		'focal_exempt_hash', p_focal_exempt_hash, 'scanner_rev', p_scanner_rev)::text, 'UTF8')), 'hex')
$$;

DROP FUNCTION public.record_tag_input(text, text, text, text, text, text, text);
CREATE FUNCTION public.record_tag_input(
	p_code text, p_text_hash text, p_order_name text, p_family_sci_name text, p_genus text,
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
	v_hash := public.tag_input_hash(p_text_hash, p_order_name, p_family_sci_name, p_genus,
	                                p_lexicon_hash, p_focal_exempt_hash, p_scanner_rev);
	INSERT INTO public.species_tag_input AS i
		(species_code, input_hash, text_hash, order_name, family_sci_name, genus, lexicon_hash, focal_exempt_hash, scanner_rev, updated_at)
	VALUES (p_code, v_hash, p_text_hash, p_order_name, p_family_sci_name, p_genus, p_lexicon_hash, p_focal_exempt_hash, p_scanner_rev, now())
	ON CONFLICT (species_code) DO UPDATE SET
		input_hash = EXCLUDED.input_hash, text_hash = EXCLUDED.text_hash,
		order_name = EXCLUDED.order_name, family_sci_name = EXCLUDED.family_sci_name, genus = EXCLUDED.genus,
		lexicon_hash = EXCLUDED.lexicon_hash, focal_exempt_hash = EXCLUDED.focal_exempt_hash,
		scanner_rev = EXCLUDED.scanner_rev, updated_at = now()
	WHERE i.input_hash IS DISTINCT FROM EXCLUDED.input_hash;
	RETURN v_hash;
END $$;

-- ── evidence shapes (plan §3e) ─────────────────────────────────────────────
-- text:  {section, sentence, matchStart, matchEnd, ruleId[, scopes: 1–3 {rank, value}]}
-- taxon: {kind:"taxon", matchedCount ≥ 1, matchedRules: 1–5 {ruleId, rank, value}} — only item.
CREATE FUNCTION public.tag_evidence_ok(p_evidence jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE
	e jsonb;
	s jsonb;
	n integer := jsonb_array_length(p_evidence);
	keys text[];
BEGIN
	FOR e IN SELECT * FROM jsonb_array_elements(p_evidence) LOOP
		IF jsonb_typeof(e) <> 'object' THEN RETURN false; END IF;
		keys := ARRAY(SELECT k FROM jsonb_object_keys(e) k ORDER BY k COLLATE "C");
		IF e ? 'kind' THEN
			IF n <> 1 OR e->>'kind' <> 'taxon'
			   OR keys <> ARRAY['kind', 'matchedCount', 'matchedRules']
			   OR jsonb_typeof(e->'matchedCount') <> 'number'
			   OR jsonb_typeof(e->'matchedRules') <> 'array'
			   OR jsonb_array_length(e->'matchedRules') NOT BETWEEN 1 AND 5
			   OR (e->>'matchedCount')::numeric <> floor((e->>'matchedCount')::numeric)
			   OR (e->>'matchedCount')::numeric < jsonb_array_length(e->'matchedRules') THEN
				RETURN false;
			END IF;
			FOR s IN SELECT * FROM jsonb_array_elements(e->'matchedRules') LOOP
				IF jsonb_typeof(s) <> 'object'
				   OR ARRAY(SELECT k FROM jsonb_object_keys(s) k ORDER BY k COLLATE "C") <> ARRAY['rank', 'ruleId', 'value']
				   OR s->>'rank' NOT IN ('order', 'family', 'genus')
				   OR jsonb_typeof(s->'ruleId') <> 'string' OR jsonb_typeof(s->'value') <> 'string' THEN
					RETURN false;
				END IF;
			END LOOP;
		ELSE
			IF NOT (keys = ARRAY['matchEnd', 'matchStart', 'ruleId', 'section', 'sentence']
			        OR keys = ARRAY['matchEnd', 'matchStart', 'ruleId', 'scopes', 'section', 'sentence'])
			   OR jsonb_typeof(e->'section') <> 'string' OR jsonb_typeof(e->'sentence') <> 'string'
			   OR jsonb_typeof(e->'ruleId') <> 'string'
			   OR jsonb_typeof(e->'matchStart') <> 'number' OR jsonb_typeof(e->'matchEnd') <> 'number' THEN
				RETURN false;
			END IF;
			IF e ? 'scopes' THEN
				IF jsonb_typeof(e->'scopes') <> 'array' OR jsonb_array_length(e->'scopes') NOT BETWEEN 1 AND 3 THEN
					RETURN false;
				END IF;
				FOR s IN SELECT * FROM jsonb_array_elements(e->'scopes') LOOP
					IF jsonb_typeof(s) <> 'object'
					   OR ARRAY(SELECT k FROM jsonb_object_keys(s) k ORDER BY k COLLATE "C") <> ARRAY['rank', 'value']
					   OR s->>'rank' NOT IN ('order', 'family', 'genus') OR jsonb_typeof(s->'value') <> 'string' THEN
						RETURN false;
					END IF;
				END LOOP;
			END IF;
		END IF;
	END LOOP;
	RETURN true;
END $$;
ALTER TABLE public.species_tag_state
	ADD CONSTRAINT species_tag_state_evidence_shape CHECK (public.tag_evidence_ok(evidence));

-- ── proposals: schema version, human proposals ─────────────────────────────
ALTER TABLE public.tag_rule_proposal
	ADD COLUMN schema_version integer GENERATED ALWAYS AS (
		CASE WHEN jsonb_typeof(artifact->'schema') = 'number' AND artifact->>'schema' IN ('1', '2')
		     THEN (artifact->>'schema')::integer END) STORED;
ALTER TABLE public.tag_rule_proposal
	ALTER COLUMN schema_version SET NOT NULL,
	ADD CONSTRAINT tag_rule_proposal_schema_version CHECK (schema_version IN (1, 2));

-- A hand-written proposal (the loader and taxonomy checks run in the caller
-- first; approval re-validates). user_id is audit data (Option A).
CREATE FUNCTION public.create_human_tag_proposal(p_tag text, p_artifact jsonb, p_user_id integer) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
	v_id uuid;
BEGIN
	IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_user_id AND role = 'admin') THEN
		RAISE EXCEPTION 'proposal: user % is not an admin (audit check)', p_user_id;
	END IF;
	IF p_tag IS DISTINCT FROM p_artifact->>'tag' THEN
		RAISE EXCEPTION 'proposal: tag % does not match the artifact tag %', p_tag, p_artifact->>'tag';
	END IF;
	INSERT INTO public.tag_rule_proposal (tag, artifact, source) VALUES (p_tag, p_artifact, 'human')
	RETURNING id INTO v_id;
	RETURN v_id;
END $$;

-- ── Preview (plan §3d/§3j/§3o/§3t) ─────────────────────────────────────────
-- The preview design per tag: pinned here, recomputed by the TS source and
-- compared in a test (the PROPOSED_GATES pattern). Re-pinned only by a
-- migration, which makes every older Preview non-current.
CREATE TABLE public.tag_preview_design (
	tag text PRIMARY KEY,
	design_hash text NOT NULL CHECK (public.tag_is_hex64(design_hash)),
	pinned_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.tag_preview_design (tag, design_hash)
VALUES ('habitat:open-ocean', 'a486eb88565dcd141c1596df19c7df1f29cd8113884e92d8489d4fc4e02d20e3');

-- Canonical bytes: "tagcorpus-v1|" lexicon_hash "|" scanner_rev "|" then per
-- universe member in code COLLATE "C" order: len:code|len:input_hash|
-- (lengths in UTF-8 octets; a member without an input contributes "0:").
CREATE FUNCTION public.tag_corpus_fingerprint() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
	SELECT encode(sha256(convert_to(
		'tagcorpus-v1|' || coalesce(l.lexicon_hash, '') || '|' || coalesce(l.scanner_rev, '') || '|' ||
		coalesce((
			SELECT string_agg(
				octet_length(u.code) || ':' || u.code || '|' ||
				octet_length(coalesce(i.input_hash, '')) || ':' || coalesce(i.input_hash, '') || '|',
				'' ORDER BY u.code COLLATE "C")
			  FROM public.tag_universe_codes() u(code)
			  LEFT JOIN public.species_tag_input i ON i.species_code = u.code), ''),
		'UTF8')), 'hex')
	  FROM (SELECT 1) one
	  LEFT JOIN public.tag_lexicon_state l ON l.id = 1
$$;

CREATE TABLE public.tag_proposal_preview (
	id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	proposal_id uuid NOT NULL REFERENCES public.tag_rule_proposal (id),
	artifact_sha256 text NOT NULL CHECK (public.tag_is_hex64(artifact_sha256)),
	corpus_fingerprint text NOT NULL CHECK (public.tag_is_hex64(corpus_fingerprint)),
	preview_design_hash text NOT NULL CHECK (public.tag_is_hex64(preview_design_hash)),
	job_id bigint NOT NULL,
	body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object' AND octet_length(body::text) <= 1048576),
	body_sha256 text NOT NULL CHECK (public.tag_is_hex64(body_sha256)),
	created_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (proposal_id, artifact_sha256, corpus_fingerprint, preview_design_hash)
);
CREATE TRIGGER tag_proposal_preview_immutable
	BEFORE UPDATE OR DELETE ON public.tag_proposal_preview
	FOR EACH ROW EXECUTE FUNCTION public.tag_reject_mutation();

-- The one current Preview of a proposal, or NULL (live recomputation).
CREATE FUNCTION public.tag_current_preview_id(p_proposal_id uuid) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
	SELECT pv.id
	  FROM public.tag_rule_proposal p
	  JOIN public.tag_preview_design d ON d.tag = p.tag
	  JOIN public.tag_proposal_preview pv
	    ON pv.proposal_id = p.id
	   AND pv.artifact_sha256 = public.tag_artifact_sha256(p.artifact)
	   AND pv.corpus_fingerprint = public.tag_corpus_fingerprint()
	   AND pv.preview_design_hash = d.design_hash
	 WHERE p.id = p_proposal_id
$$;

-- The ONLY writer of Preview rows. The job scans in one REPEATABLE READ
-- snapshot and reads tag_corpus_fingerprint() in that same snapshot; this
-- short shared-lock transaction then locks the job row under the claim fence
-- and stores the body ONLY if the live fingerprint still equals the scanned
-- one — so a stored Preview always describes the corpus it names, and a
-- corpus that moved mid-scan stores nothing. Every hash is computed here.
CREATE FUNCTION public.record_tag_preview(
	p_proposal_id uuid, p_job_id bigint, p_expected_attempts integer, p_claim_seq bigint,
	p_scanned_fingerprint text, p_body jsonb
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
	v_prop public.tag_rule_proposal%ROWTYPE;
	v_design text;
	v_body_sha text;
	v_id bigint;
	v_existing text;
BEGIN
	PERFORM public.tag_assert_shared_engine_lock('record_tag_preview');
	PERFORM 1 FROM public.jobs
	 WHERE id = p_job_id AND type = 'tag_preview' AND status = 'running'
	   AND attempts = p_expected_attempts AND claim_seq = p_claim_seq
	   AND payload->>'proposalId' = p_proposal_id::text
	   FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'stale claim: preview job % is not the running claim for proposal %', p_job_id, p_proposal_id
			USING ERRCODE = 'object_not_in_prerequisite_state';
	END IF;
	SELECT * INTO v_prop FROM public.tag_rule_proposal WHERE id = p_proposal_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'record_tag_preview: no proposal %', p_proposal_id;
	END IF;
	SELECT design_hash INTO v_design FROM public.tag_preview_design WHERE tag = v_prop.tag;
	IF v_design IS NULL THEN
		RAISE EXCEPTION 'record_tag_preview: no preview design is pinned for %', v_prop.tag;
	END IF;
	IF jsonb_typeof(p_body) <> 'object' OR octet_length(p_body::text) > 1048576 THEN
		RAISE EXCEPTION 'record_tag_preview: the body must be an object of at most 1 MB';
	END IF;
	IF p_scanned_fingerprint IS DISTINCT FROM public.tag_corpus_fingerprint() THEN
		RAISE EXCEPTION 'tag_preview: the species data changed during the Preview — run Preview again'
			USING ERRCODE = 'serialization_failure';
	END IF;
	v_body_sha := public.tag_artifact_sha256(p_body);
	INSERT INTO public.tag_proposal_preview
		(proposal_id, artifact_sha256, corpus_fingerprint, preview_design_hash, job_id, body, body_sha256)
	VALUES (p_proposal_id, public.tag_artifact_sha256(v_prop.artifact), public.tag_corpus_fingerprint(),
	        v_design, p_job_id, p_body, v_body_sha)
	ON CONFLICT (proposal_id, artifact_sha256, corpus_fingerprint, preview_design_hash) DO NOTHING
	RETURNING id INTO v_id;
	IF v_id IS NULL THEN
		SELECT id, body_sha256 INTO v_id, v_existing FROM public.tag_proposal_preview
		 WHERE proposal_id = p_proposal_id AND artifact_sha256 = public.tag_artifact_sha256(v_prop.artifact)
		   AND corpus_fingerprint = public.tag_corpus_fingerprint() AND preview_design_hash = v_design;
		IF v_existing IS DISTINCT FROM v_body_sha THEN
			RAISE EXCEPTION 'tag_preview: nondeterministic body for an identical key (integrity)'
				USING ERRCODE = 'integrity_constraint_violation';
		END IF;
	END IF;
	RETURN v_id;
END $$;

-- ── cross-check bound to a Preview (plan §3g) ──────────────────────────────
ALTER TABLE public.tag_crosscheck ADD COLUMN preview_id bigint REFERENCES public.tag_proposal_preview (id);

CREATE FUNCTION public.tag_crosscheck_preview_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
	v_schema integer;
BEGIN
	SELECT schema_version INTO v_schema FROM public.tag_rule_proposal WHERE id = NEW.proposal_id;
	IF v_schema = 2 AND NEW.preview_id IS NULL THEN
		RAISE EXCEPTION 'crosscheck: a schema-2 proposal needs its current Preview (run Preview first)'
			USING ERRCODE = 'integrity_constraint_violation';
	END IF;
	IF NEW.preview_id IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM public.tag_proposal_preview pv
		 WHERE pv.id = NEW.preview_id AND pv.proposal_id = NEW.proposal_id
		   AND pv.artifact_sha256 = NEW.reviewed_sha256
	) THEN
		RAISE EXCEPTION 'crosscheck: the Preview is not of this proposal''s artifact'
			USING ERRCODE = 'integrity_constraint_violation';
	END IF;
	RETURN NEW;
END $$;
CREATE TRIGGER tag_crosscheck_preview_guard
	BEFORE INSERT ON public.tag_crosscheck
	FOR EACH ROW EXECUTE FUNCTION public.tag_crosscheck_preview_guard();

-- Owner role only (unchanged grant). Now under the EXCLUSIVE engine lock, and
-- binding the one current Preview (required for schema 2).
CREATE OR REPLACE FUNCTION public.record_tag_crosscheck(
	p_proposal_id uuid, p_reviewer text, p_verdict text, p_text text
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
	v_prop public.tag_rule_proposal%ROWTYPE;
	v_preview bigint;
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
	PERFORM set_config('lock_timeout', '10s', true);
	PERFORM pg_advisory_xact_lock(894144::bigint);
	SELECT * INTO v_prop FROM public.tag_rule_proposal WHERE id = p_proposal_id FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'crosscheck: no proposal %', p_proposal_id;
	END IF;
	IF v_prop.status NOT IN ('proposed', 'crosschecked') THEN
		RAISE EXCEPTION 'crosscheck: proposal is %', v_prop.status;
	END IF;
	IF v_prop.schema_version NOT IN (1, 2) THEN
		RAISE EXCEPTION 'crosscheck: unsupported schema %', v_prop.schema_version;
	END IF;
	v_preview := public.tag_current_preview_id(p_proposal_id);
	IF v_prop.schema_version = 2 AND v_preview IS NULL THEN
		RAISE EXCEPTION 'crosscheck: no current Preview for this proposal — run Preview, review it, then record'
			USING ERRCODE = 'object_not_in_prerequisite_state';
	END IF;
	INSERT INTO public.tag_crosscheck (proposal_id, reviewer, verdict, text, reviewed_sha256, preview_id)
	VALUES (p_proposal_id, p_reviewer, p_verdict, p_text, public.tag_artifact_sha256(v_prop.artifact), v_preview)
	RETURNING id INTO v_id;
	UPDATE public.tag_rule_proposal SET status = 'crosschecked' WHERE id = p_proposal_id AND status = 'proposed';
	RETURN v_id;
END $$;

-- Approval: under the exclusive engine lock; a schema-2 proposal needs an
-- approving cross-check bound to the Preview that is current NOW.
CREATE OR REPLACE FUNCTION public.approve_tag_proposal(p_proposal_id uuid, p_user_id integer) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
	v_prop public.tag_rule_proposal%ROWTYPE;
	v_hash text;
	v_check public.tag_crosscheck%ROWTYPE;
	v_rev bigint;
BEGIN
	PERFORM set_config('lock_timeout', '10s', true);
	PERFORM pg_advisory_xact_lock(894144::bigint);
	SELECT * INTO v_prop FROM public.tag_rule_proposal WHERE id = p_proposal_id FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'approve: no proposal %', p_proposal_id;
	END IF;
	IF v_prop.status NOT IN ('proposed', 'crosschecked') THEN
		RAISE EXCEPTION 'approve: proposal is %', v_prop.status;
	END IF;
	IF v_prop.schema_version NOT IN (1, 2) THEN
		RAISE EXCEPTION 'approve: unsupported schema %', v_prop.schema_version;
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
	IF v_prop.schema_version = 2 AND v_check.preview_id IS DISTINCT FROM public.tag_current_preview_id(p_proposal_id) THEN
		RAISE EXCEPTION 'approve: the data changed since the cross-check — run Preview again and get a new cross-check'
			USING ERRCODE = 'object_not_in_prerequisite_state';
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

-- ── family references for blind tests (plan §4, option b) ──────────────────
CREATE TABLE public.tag_family_reference (
	family_code text PRIMARY KEY,
	family_sci_name text NOT NULL,
	status text NOT NULL CHECK (status IN ('ok', 'missing', 'ambiguous', 'failed')),
	wiki_title text,
	rev_id bigint,
	lead text,
	reference_sha text CHECK (reference_sha IS NULL OR public.tag_is_hex64(reference_sha)),
	error text,
	fetched_at timestamptz NOT NULL DEFAULT now(),
	CHECK ((status = 'ok') = (wiki_title IS NOT NULL AND rev_id IS NOT NULL AND coalesce(lead, '') <> '' AND reference_sha IS NOT NULL))
);

-- reference_sha = sha256("tagref-v1|" len:family_code| len:wiki_title| rev_id "|" len:lead|lead)
-- (lengths in UTF-8 octets; the lead exactly as stored).
CREATE FUNCTION public.tag_reference_sha(p_family_code text, p_title text, p_rev_id bigint, p_lead text) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
	SELECT encode(sha256(convert_to(
		'tagref-v1|' || octet_length(p_family_code) || ':' || p_family_code || '|' ||
		octet_length(p_title) || ':' || p_title || '|' || p_rev_id::text || '|' ||
		octet_length(p_lead) || ':' || p_lead, 'UTF8')), 'hex')
$$;

CREATE FUNCTION public.record_tag_family_reference(
	p_family_code text, p_family_sci_name text, p_status text, p_title text, p_rev_id bigint, p_lead text, p_error text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
	INSERT INTO public.tag_family_reference AS f
		(family_code, family_sci_name, status, wiki_title, rev_id, lead, reference_sha, error, fetched_at)
	VALUES (p_family_code, p_family_sci_name, p_status,
	        CASE WHEN p_status = 'ok' THEN p_title END,
	        CASE WHEN p_status = 'ok' THEN p_rev_id END,
	        CASE WHEN p_status = 'ok' THEN p_lead END,
	        CASE WHEN p_status = 'ok' THEN public.tag_reference_sha(p_family_code, p_title, p_rev_id, p_lead) END,
	        left(p_error, 500), now())
	ON CONFLICT (family_code) DO UPDATE SET
		family_sci_name = EXCLUDED.family_sci_name, status = EXCLUDED.status, wiki_title = EXCLUDED.wiki_title,
		rev_id = EXCLUDED.rev_id, lead = EXCLUDED.lead, reference_sha = EXCLUDED.reference_sha,
		error = EXCLUDED.error, fetched_at = now();
END $$;

-- ── frame v2: each row carries its family reference (plan §4) ──────────────
DROP FUNCTION public.tag_eval_frame_hash(text, bigint, text[], text);
DROP FUNCTION public.tag_eval_frame_rows(text, bigint, text[]);
CREATE FUNCTION public.tag_eval_frame_rows(p_tag text, p_revision_id bigint, p_marine text[])
RETURNS TABLE (species_code text, stratum text, input_hash text, rules_yes boolean, legacy_yes boolean,
               rules_status text, marine boolean, com_name text, sci_name text,
               family_code text, reference_sha text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
	WITH f AS (
		SELECT se.species_code, s.status, i.input_hash,
		       coalesce(p_tag = ANY (se.legacy_tags), false) AS legacy_yes,
		       coalesce(tc.order_name = ANY (p_marine), false) AS marine,
		       coalesce(tc.com_name, '') AS com_name, coalesce(tc.sci_name, '') AS sci_name,
		       coalesce(tc.family_code, '') AS family_code,
		       coalesce(fr.reference_sha, '') AS reference_sha
		  FROM public.species_enrichment se
		  JOIN public.taxonomy_cache tc ON tc.species_code = se.species_code AND tc.category = 'species'
		  JOIN public.species_tag_input i ON i.species_code = se.species_code
		  JOIN public.species_tag_state s
		    ON s.species_code = se.species_code AND s.tag = p_tag AND s.revision_id = p_revision_id
		   AND s.input_hash = i.input_hash
		  LEFT JOIN public.tag_family_reference fr ON fr.family_code = tc.family_code AND fr.status = 'ok'
		 WHERE se.wikipedia_extract IS NOT NULL
		   AND (s.status = 'assigned' OR coalesce(p_tag = ANY (se.legacy_tags), false))
	)
	SELECT f.species_code,
	       CASE WHEN f.status = 'assigned' THEN CASE WHEN f.legacy_yes THEN 'A' ELSE 'B' END
	            WHEN f.status = 'unevaluated' THEN 'U'
	            WHEN f.marine THEN 'C1' ELSE 'C2' END,
	       f.input_hash, f.status = 'assigned', f.legacy_yes, f.status, f.marine, f.com_name, f.sci_name,
	       f.family_code, f.reference_sha
	  FROM f
$$;

-- Canonical bytes (mirrored by eval-frame.ts canonicalFrameHash):
-- "tagframe-v2|" + design_sha256 + "|" + per row, ordered by code COLLATE "C":
-- len:code|len:stratum|len:input_hash|len:com_name|len:sci_name|r|l|len:family_code|len:reference_sha|
-- (lengths in UTF-8 octets; r,l ∈ {0,1}; missing values ''). A family-code
-- remap or a new reference revision changes the frame (plan §4).
CREATE FUNCTION public.tag_eval_frame_hash(p_tag text, p_revision_id bigint, p_marine text[], p_design_sha256 text)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
	SELECT encode(sha256(convert_to(
		'tagframe-v2|' || p_design_sha256 || '|' ||
		coalesce(string_agg(
			octet_length(r.species_code) || ':' || r.species_code || '|' ||
			octet_length(r.stratum) || ':' || r.stratum || '|' ||
			octet_length(r.input_hash) || ':' || r.input_hash || '|' ||
			octet_length(r.com_name) || ':' || r.com_name || '|' ||
			octet_length(r.sci_name) || ':' || r.sci_name || '|' ||
			CASE WHEN r.rules_yes THEN '1' ELSE '0' END || '|' ||
			CASE WHEN r.legacy_yes THEN '1' ELSE '0' END || '|' ||
			octet_length(r.family_code) || ':' || r.family_code || '|' ||
			octet_length(r.reference_sha) || ':' || r.reference_sha || '|',
			'' ORDER BY r.species_code COLLATE "C"), ''),
		'UTF8')), 'hex')
	  FROM public.tag_eval_frame_rows(p_tag, p_revision_id, p_marine) r
$$;

-- The frozen copy of the family reference the page shows:
-- {familyCode, title, revId, lead, displayLead}. Its identity is
-- tag_reference_sha(familyCode, title, revId, lead), verified at creation.
ALTER TABLE public.tag_eval_item ADD COLUMN family_reference jsonb
	CHECK (family_reference IS NULL OR jsonb_typeof(family_reference) = 'object');

CREATE OR REPLACE FUNCTION public.create_tag_eval_set(
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
	v_noref integer;
	v_badref integer;
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
	-- 0. Every frame species must have its family reference (hard stop, plan §4).
	SELECT count(*) INTO v_noref FROM public.tag_eval_frame_rows(p_tag, p_revision_id, v_marine) r
	 WHERE r.reference_sha = '';
	IF v_noref > 0 THEN
		RAISE EXCEPTION 'eval set: % species in the frame have no family reference — fetch family articles first', v_noref
			USING ERRCODE = 'object_not_in_prerequisite_state';
	END IF;
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
	CREATE TEMP TABLE IF NOT EXISTS pg_temp.tag_eval_expected2 (
		species_code text PRIMARY KEY, stratum text, rules_yes boolean, legacy_yes boolean,
		rules_status text, marine boolean, input_hash text, reference_sha text) ON COMMIT DROP;
	DELETE FROM pg_temp.tag_eval_expected2;
	INSERT INTO pg_temp.tag_eval_expected2
	SELECT species_code, stratum, rules_yes, legacy_yes, rules_status, marine, input_hash, reference_sha
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
		(SELECT species_code, stratum, rules_yes, legacy_yes, rules_status, marine FROM pg_temp.tag_eval_expected2
		 EXCEPT
		 SELECT x.species_code, x.stratum, x.rules_yes, x.legacy_yes, x.rules_status, x.marine
		   FROM jsonb_to_recordset(p_items) AS x(species_code text, stratum text, rules_yes boolean, legacy_yes boolean,
		                                         rules_status text, marine boolean))
		UNION ALL
		(SELECT x.species_code, x.stratum, x.rules_yes, x.legacy_yes, x.rules_status, x.marine
		   FROM jsonb_to_recordset(p_items) AS x(species_code text, stratum text, rules_yes boolean, legacy_yes boolean,
		                                         rules_status text, marine boolean)
		 EXCEPT
		 SELECT species_code, stratum, rules_yes, legacy_yes, rules_status, marine FROM pg_temp.tag_eval_expected2)
	) d;
	IF v_mismatch > 0 OR v_items <> (SELECT count(*) FROM pg_temp.tag_eval_expected2) THEN
		RAISE EXCEPTION 'eval set: the items are not the seeded selection (% differ)', v_mismatch
			USING ERRCODE = 'integrity_constraint_violation';
	END IF;
	-- 4b. Each item's frozen family reference must be exactly its frame row's.
	SELECT count(*) INTO v_badref
	  FROM pg_temp.tag_eval_expected2 e
	  JOIN jsonb_to_recordset(p_items) AS x(species_code text, family_reference jsonb) ON x.species_code = e.species_code
	 WHERE x.family_reference IS NULL OR jsonb_typeof(x.family_reference) <> 'object'
	    OR public.tag_reference_sha(x.family_reference->>'familyCode', x.family_reference->>'title',
	                                (x.family_reference->>'revId')::bigint, x.family_reference->>'lead')
	       IS DISTINCT FROM e.reference_sha;
	IF v_badref > 0 THEN
		RAISE EXCEPTION 'eval set: % item(s) carry a family reference that is not their frame row''s', v_badref
			USING ERRCODE = 'integrity_constraint_violation';
	END IF;
	-- 5. The design records the selection and π_h; both must be exactly this.
	IF (SELECT coalesce(array_agg(species_code ORDER BY species_code COLLATE "C"), '{}') FROM pg_temp.tag_eval_expected2)
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
		 display_position, input_hash, eval_text_hash, article, family_reference)
	SELECT v_id, e.species_code, e.stratum, e.rules_yes, e.legacy_yes, e.rules_status, e.marine,
	       (p_design->'n'->>e.stratum)::double precision / (p_design->'N'->>e.stratum)::double precision,
	       x.display_position, e.input_hash, x.eval_text_hash, x.article, x.family_reference
	  FROM pg_temp.tag_eval_expected2 e
	  JOIN jsonb_to_recordset(p_items) AS x(species_code text, display_position integer, eval_text_hash text,
	                                        article jsonb, family_reference jsonb)
	    ON x.species_code = e.species_code;
	RETURN v_id;
END $$;

-- ── integrity: taxon overlaps and the new tables' grants ───────────────────
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
		'tag_consistency_run', 'tag_legacy_baseline', 'tag_preview_design', 'tag_proposal_preview',
		'tag_family_reference']) t(tbl)
	 CROSS JOIN unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p(priv)
	 WHERE has_table_privilege('birds_app', 'public.' || t.tbl, p.priv)
	UNION ALL
	SELECT 'grant', 'birds_app can ' || p.priv || ' tag_rule_proposal'
	  FROM unnest(ARRAY['UPDATE', 'DELETE', 'TRUNCATE']) p(priv)
	 WHERE has_table_privilege('birds_app', 'public.tag_rule_proposal', p.priv)
	UNION ALL
	-- An owned schema-2 revision whose assign now overlaps a forbid or an unmet
	-- require (a later reclassification; the loader refused it at approval).
	SELECT 'taxon_overlap', x.tag || ': ' || x.species_code || ' (' || x.assign_id || ' vs ' || x.dq_id || ')'
	  FROM (
		WITH owned AS (
			SELECT o.tag, r.artifact
			  FROM public.tag_ownership o
			  JOIN public.tag_activation a ON a.id = o.activation_id AND a.revision_id IS NOT NULL
			  JOIN public.tag_revision r ON r.id = a.revision_id AND r.tag = o.tag
			 WHERE r.artifact->>'schema' = '2'
		), rules AS (
			SELECT ow.tag, t->>'id' AS id, t->>'rank' AS rank, t->>'action' AS action,
			       ARRAY(SELECT jsonb_array_elements_text(t->'values')) AS vals
			  FROM owned ow, jsonb_array_elements(ow.artifact->'taxon') t
		), sp AS (
			SELECT i.species_code, i.order_name, i.family_sci_name, i.genus FROM public.species_tag_input i
		)
		SELECT DISTINCT ON (a.tag, sp.species_code) a.tag, sp.species_code, a.id AS assign_id, d.id AS dq_id
		  FROM rules a
		  JOIN sp ON (CASE a.rank WHEN 'order' THEN sp.order_name WHEN 'family' THEN sp.family_sci_name ELSE sp.genus END) = ANY (a.vals)
		  JOIN rules d ON d.tag = a.tag AND (
		       (d.action = 'forbid'
		        AND (CASE d.rank WHEN 'order' THEN sp.order_name WHEN 'family' THEN sp.family_sci_name ELSE sp.genus END) = ANY (d.vals))
		    OR (d.action = 'require_one_of'
		        AND (CASE d.rank WHEN 'order' THEN sp.order_name WHEN 'family' THEN sp.family_sci_name ELSE sp.genus END) IS NOT NULL
		        AND NOT ((CASE d.rank WHEN 'order' THEN sp.order_name WHEN 'family' THEN sp.family_sci_name ELSE sp.genus END) = ANY (d.vals))))
		 WHERE a.action = 'assign'
		 ORDER BY a.tag, sp.species_code, a.id, d.id
	  ) x
$$;

-- ══ grants ═════════════════════════════════════════════════════════════════
DO $$
DECLARE
	t text;
BEGIN
	FOREACH t IN ARRAY ARRAY['tag_preview_design', 'tag_proposal_preview', 'tag_family_reference'] LOOP
		EXECUTE format('REVOKE ALL ON public.%I FROM birds_app, PUBLIC', t);
		EXECUTE format('GRANT SELECT ON public.%I TO birds_app', t);
	END LOOP;
END $$;
REVOKE ALL ON SEQUENCE public.tag_proposal_preview_id_seq FROM birds_app, PUBLIC;
DO $$
DECLARE
	f text;
BEGIN
	FOREACH f IN ARRAY ARRAY[
		'public.tag_assert_shared_engine_lock(text)',
		'public.tag_input_hash(text, text, text, text, text, text, text)',
		'public.record_tag_input(text, text, text, text, text, text, text, text)',
		'public.tag_evidence_ok(jsonb)',
		'public.create_human_tag_proposal(text, jsonb, integer)',
		'public.tag_corpus_fingerprint()',
		'public.tag_current_preview_id(uuid)',
		'public.record_tag_preview(uuid, bigint, integer, bigint, text, jsonb)',
		'public.approve_tag_proposal(uuid, integer)',
		'public.tag_reference_sha(text, text, bigint, text)',
		'public.record_tag_family_reference(text, text, text, text, bigint, text, text)',
		'public.tag_eval_frame_hash(text, bigint, text[], text)',
		'public.create_tag_eval_set(text, bigint, jsonb, jsonb, jsonb, integer)',
		'public.tag_integrity_violations()'
	] LOOP
		EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
		EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO birds_app', f);
	END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.tag_eval_frame_rows(text, bigint, text[]) FROM PUBLIC, birds_app;
-- Owner role only: no app path may mint a cross-check (unchanged).
REVOKE ALL ON FUNCTION public.record_tag_crosscheck(uuid, text, text, text) FROM PUBLIC, birds_app;
REVOKE ALL ON FUNCTION public.tag_crosscheck_preview_guard() FROM PUBLIC;

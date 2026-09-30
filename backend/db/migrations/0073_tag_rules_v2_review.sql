-- td-894144 B5 Phase 1 — CODEX1 code-review repair (2 P1, 3 P2). 0072 was
-- already applied to birds_test before review, so amend forward (the 0070
-- pattern) rather than editing an applied migration.
--
--  * P1-2: approval uses the NEWEST cross-check of the exact artifact; a later
--    "changes"/"reject" revokes an earlier "approve".
--  * P1-1: a schema-2 approval requires its bound current Preview to have
--    recorded a clean taxonomy check (no problems, no assign overlaps), so
--    even a direct definer call cannot approve rules the check refused. The
--    app additionally re-runs the loader + taxonomy check inside the same
--    exclusive-lock transaction as this call (tag-admin.ts approveProposal).
--  * P2-2: the family-reference write from the job is fenced to the job's
--    live claim and its requester's admin role; the unfenced writer becomes
--    owner-only (fixtures, manual repair).
--  * P2-3: the Preview source guard now covers taxon-check.ts (its output is
--    in the Preview body) — re-pin the open-ocean preview design.
--
-- Wrapped in one transaction by migrate_pg.sh.

CREATE OR REPLACE FUNCTION public.approve_tag_proposal(p_proposal_id uuid, p_user_id integer) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
	v_prop public.tag_rule_proposal%ROWTYPE;
	v_hash text;
	v_check public.tag_crosscheck%ROWTYPE;
	v_body jsonb;
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
	-- The NEWEST cross-check of this exact artifact decides (P1-2).
	SELECT * INTO v_check FROM public.tag_crosscheck
	 WHERE proposal_id = p_proposal_id AND reviewed_sha256 = v_hash
	 ORDER BY id DESC LIMIT 1;
	IF NOT FOUND OR v_check.verdict IS DISTINCT FROM 'approve' THEN
		RAISE EXCEPTION 'approve: the latest cross-check of this exact artifact did not approve it';
	END IF;
	IF v_prop.schema_version = 2 THEN
		IF v_check.preview_id IS DISTINCT FROM public.tag_current_preview_id(p_proposal_id) THEN
			RAISE EXCEPTION 'approve: the data changed since the cross-check — run Preview again and get a new cross-check'
				USING ERRCODE = 'object_not_in_prerequisite_state';
		END IF;
		-- The bound Preview's taxonomy check must be clean (P1-1).
		SELECT body INTO v_body FROM public.tag_proposal_preview WHERE id = v_check.preview_id;
		IF jsonb_typeof(v_body->'taxonCheck'->'problems') IS DISTINCT FROM 'array'
		   OR jsonb_array_length(v_body->'taxonCheck'->'problems') > 0
		   OR coalesce((v_body->'taxonCheck'->>'overlapCount')::integer, -1) <> 0 THEN
			RAISE EXCEPTION 'approve: these rules do not fit the current taxonomy (see the Preview)';
		END IF;
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

-- The job's writer: fenced to the job's live claim and its requester (P2-2).
CREATE FUNCTION public.record_tag_family_reference_for_job(
	p_job_id bigint, p_expected_attempts integer, p_claim_seq bigint,
	p_family_code text, p_family_sci_name text, p_status text, p_title text, p_rev_id bigint, p_lead text, p_error text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
	v_requester integer;
BEGIN
	SELECT requested_by INTO v_requester FROM public.jobs
	 WHERE id = p_job_id AND type = 'tag_family_refs' AND status = 'running'
	   AND attempts = p_expected_attempts AND claim_seq = p_claim_seq
	   FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'stale claim: family-reference job % is not the running claim', p_job_id
			USING ERRCODE = 'object_not_in_prerequisite_state';
	END IF;
	IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = v_requester AND role = 'admin') THEN
		RAISE EXCEPTION 'family references: the requester is no longer an admin';
	END IF;
	PERFORM public.record_tag_family_reference(p_family_code, p_family_sci_name, p_status, p_title, p_rev_id, p_lead, p_error);
END $$;

-- Re-pin (P2-3): PREVIEW_SOURCE_HASH now also covers taxon-check.ts.
UPDATE public.tag_preview_design
   SET design_hash = '3b12220fa4875c0aac4c61d30dc48bf72d7e5618a0b14e7a586234b16c829540', pinned_at = now()
 WHERE tag = 'habitat:open-ocean';

REVOKE ALL ON FUNCTION public.approve_tag_proposal(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve_tag_proposal(uuid, integer) TO birds_app;
REVOKE ALL ON FUNCTION public.record_tag_family_reference_for_job(bigint, integer, bigint, text, text, text, text, bigint, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_tag_family_reference_for_job(bigint, integer, bigint, text, text, text, text, bigint, text, text) TO birds_app;
-- The unfenced writer: owner only from now on.
REVOKE ALL ON FUNCTION public.record_tag_family_reference(text, text, text, text, bigint, text, text) FROM PUBLIC, birds_app;

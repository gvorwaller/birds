-- td-894144: whole-family confirmations in a blind test (owner request
-- 2026-10-03: "I have more things to do than clear make-work").
--
-- With family lists in the rules, a blind test's rules-yes pages are mostly
-- members of the listed families: 98 of the 222 open-ocean pages were
-- albatrosses, petrels and storm-petrels, which is one owner decision asked 98
-- times. Now, while a set is labelling, the owner may confirm a listed taxon
-- ONCE. Every still-unanswered page of that set whose species is in the taxon
-- gets the owner's 'yes', recorded with basis 'taxon:<rank>:<value>' so the gate
-- report can say how many answers came from confirmations.
--
--  * Only taxa the set's revision LISTS (assign rules) can be confirmed: a
--    confirmation endorses a list, and is never a shortcut past the
--    per-species wording rules.
--  * Only unanswered pages are written. Labels stay write-once, and a page
--    answered on its own keeps that answer.
--  * Statistics are unchanged: these are the owner's answers, given per taxon.
--
-- Wrapped in one transaction by migrate_pg.sh.

ALTER TABLE public.tag_eval_label
	ADD COLUMN basis text NOT NULL DEFAULT 'page'
	CONSTRAINT tag_eval_label_basis_ok
	CHECK (basis = 'page' OR basis ~ '^taxon:(order|family|genus):[A-Za-z]+$');

CREATE FUNCTION public.confirm_tag_eval_taxa(p_set_id bigint, p_user_id integer, p_taxa jsonb)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
	v_set public.tag_eval_set%ROWTYPE;
	v_listed text[];
	v_req text[];
	v_n integer;
BEGIN
	IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_user_id AND role = 'admin') THEN
		RAISE EXCEPTION 'confirm: user % is not an admin (audit check)', p_user_id;
	END IF;
	-- FOR SHARE, as record_tag_eval_label: a freeze (FOR UPDATE) waits for us.
	SELECT * INTO v_set FROM public.tag_eval_set WHERE id = p_set_id FOR SHARE;
	IF NOT FOUND OR v_set.status <> 'labelling' THEN
		RAISE EXCEPTION 'confirm: set % is not labelling', p_set_id;
	END IF;
	IF jsonb_typeof(p_taxa) IS DISTINCT FROM 'array' OR jsonb_array_length(p_taxa) = 0 THEN
		RAISE EXCEPTION 'confirm: no taxa given';
	END IF;
	SELECT array_agg(DISTINCT (x->>'rank') || ':' || (x->>'value'))
	  INTO v_req
	  FROM jsonb_array_elements(p_taxa) x;
	SELECT array_agg(DISTINCT (t->>'rank') || ':' || v)
	  INTO v_listed
	  FROM public.tag_revision r,
	       jsonb_array_elements(r.artifact->'taxon') t,
	       jsonb_array_elements_text(t->'values') v
	 WHERE r.id = v_set.revision_id AND r.tag = v_set.tag AND t->>'action' = 'assign';
	IF v_req IS NULL OR NOT (v_req <@ coalesce(v_listed, '{}')) THEN
		RAISE EXCEPTION 'confirm: only taxa the revision lists can be confirmed';
	END IF;
	-- Membership from the species' CURRENT input (the engine's own order,
	-- family and genus). A species in two confirmed taxa takes the first in
	-- C order (lowest rank name first), for a deterministic basis.
	INSERT INTO public.tag_eval_label (tag, species_code, eval_text_hash, label, labeled_by, first_set_id, basis)
	SELECT v_set.tag, i.species_code, i.eval_text_hash, 'yes', p_user_id, p_set_id, 'taxon:' || m.taxon
	  FROM public.tag_eval_item i
	  JOIN public.species_tag_input si ON si.species_code = i.species_code
	  CROSS JOIN LATERAL (
		SELECT r FROM unnest(v_req) r
		 WHERE r IN ('order:' || si.order_name, 'family:' || si.family_sci_name, 'genus:' || si.genus)
		 ORDER BY r COLLATE "C" LIMIT 1
	  ) m(taxon)
	  LEFT JOIN public.tag_eval_label l
	    ON l.tag = v_set.tag AND l.species_code = i.species_code AND l.eval_text_hash = i.eval_text_hash
	 WHERE i.set_id = p_set_id AND l.id IS NULL
	ON CONFLICT (tag, species_code, eval_text_hash) DO NOTHING;
	GET DIAGNOSTICS v_n = ROW_COUNT;
	RETURN v_n;
END $$;

REVOKE ALL ON FUNCTION public.confirm_tag_eval_taxa(bigint, integer, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.confirm_tag_eval_taxa(bigint, integer, jsonb) TO birds_app;

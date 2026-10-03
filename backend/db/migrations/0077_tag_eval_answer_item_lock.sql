-- td-894144: CODEX1 re-review of 0076 (P1). confirm_tag_eval_taxa and
-- record_tag_eval_label both take only FOR SHARE on the set, which is
-- compatible with itself. Each checked the OTHER answer table and then
-- inserted into its own, so a direct page answer and a family confirmation for
-- the same item, running concurrently, could both see no answer and both
-- commit. (0075's single unique key had serialized that by accident.)
--
-- Both paths now lock the target tag_eval_item rows (FOR UPDATE; the rows are
-- never updated, so the immutability trigger is not involved). The
-- confirmation locks in id order, so two confirmations cannot deadlock and a
-- single-item label cannot form a cycle. The absence check and the insert run
-- as LATER statements, so READ COMMITTED gives them a snapshot taken after the
-- lock is held: whichever commits first wins, and the other sees its answer.
--
-- 0076 is applied on birds_test only, never on prod; amended forward.
-- Wrapped in one transaction by migrate_pg.sh.

CREATE OR REPLACE FUNCTION public.confirm_tag_eval_taxa(p_set_id bigint, p_user_id integer, p_taxa jsonb)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
	v_set public.tag_eval_set%ROWTYPE;
	v_listed text[];
	v_req text[];
	v_marine text[];
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
	-- The sample must still describe the live frame (activation's own check).
	SELECT array_agg(x) INTO v_marine FROM jsonb_array_elements_text(v_set.design->'marineOrders') x;
	IF public.tag_eval_frame_hash(v_set.tag, v_set.revision_id, v_marine, v_set.design->>'designHash')
	   IS DISTINCT FROM v_set.frame_hash THEN
		RAISE EXCEPTION 'confirm: the species data changed since this blind test started; abandon it and start a new one'
			USING ERRCODE = 'object_not_in_prerequisite_state';
	END IF;
	-- Lock every item this confirmation could answer, in id order, BEFORE the
	-- absence check (one answer per item: see the header).
	PERFORM 1
	   FROM public.tag_eval_item i
	   JOIN public.species_tag_input si
	     ON si.species_code = i.species_code AND si.input_hash = i.input_hash
	  WHERE i.set_id = p_set_id
	    AND ARRAY['order:' || si.order_name, 'family:' || si.family_sci_name, 'genus:' || si.genus] && v_req
	  ORDER BY i.id
	    FOR UPDATE OF i;
	-- Membership from each item's FROZEN input (order, family, genus). A
	-- species in two confirmed taxa takes the first in C order.
	INSERT INTO public.tag_eval_taxon_answer (item_id, set_id, taxon, confirmed_by)
	SELECT i.id, p_set_id, m.taxon, p_user_id
	  FROM public.tag_eval_item i
	  JOIN public.species_tag_input si
	    ON si.species_code = i.species_code AND si.input_hash = i.input_hash
	  CROSS JOIN LATERAL (
		SELECT r FROM unnest(v_req) r
		 WHERE r IN ('order:' || si.order_name, 'family:' || si.family_sci_name, 'genus:' || si.genus)
		 ORDER BY r COLLATE "C" LIMIT 1
	  ) m(taxon)
	 WHERE i.set_id = p_set_id
	   AND NOT EXISTS (
		SELECT 1 FROM public.tag_eval_label l
		 WHERE l.tag = v_set.tag AND l.species_code = i.species_code AND l.eval_text_hash = i.eval_text_hash)
	ON CONFLICT (item_id) DO NOTHING;
	GET DIAGNOSTICS v_n = ROW_COUNT;
	RETURN v_n;
END $$;

-- Page labels: as 0076, plus the item lock before the cross-table check.
CREATE OR REPLACE FUNCTION public.record_tag_eval_label(p_set_id bigint, p_item_id bigint, p_user_id integer, p_label text)
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
	-- FOR UPDATE: serializes this item against a concurrent family confirmation.
	SELECT * INTO v_item FROM public.tag_eval_item WHERE id = p_item_id AND set_id = p_set_id FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'label: item % is not in set %', p_item_id, p_set_id;
	END IF;
	IF EXISTS (SELECT 1 FROM public.tag_eval_taxon_answer WHERE item_id = p_item_id) THEN
		RAISE EXCEPTION 'label: this page is already answered by a family confirmation (answers are write-once)'
			USING ERRCODE = 'unique_violation';
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

REVOKE ALL ON FUNCTION public.confirm_tag_eval_taxa(bigint, integer, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.confirm_tag_eval_taxa(bigint, integer, jsonb) TO birds_app;
REVOKE ALL ON FUNCTION public.record_tag_eval_label(bigint, bigint, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_tag_eval_label(bigint, bigint, integer, text) TO birds_app;

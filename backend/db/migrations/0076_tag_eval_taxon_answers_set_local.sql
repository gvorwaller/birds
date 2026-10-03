-- td-894144: CODEX1 review of 0075 (CHANGES: 2 P1, 2 P2). 0075 is applied on
-- birds_test only, never on prod; amend forward per the 0073 pattern.
--
--  * P1: a whole-taxon confirmation is a judgment for ONE set (its revision's
--    lists), but 0075 stored it as a page label. Page labels are keyed
--    (tag, species, eval_text_hash) and deliberately reused by every later set
--    that shows the same page, so a later set, even for a revision that no
--    longer lists the taxon, inherited the derived Yes, and the unique key
--    blocked a later direct answer. Taxon answers now live in their own
--    set-local table. Only page labels stay globally reusable.
--  * P1: never write answers into a set whose frame has moved. The definer
--    recomputes the frame hash, as activation does, and refuses on any
--    difference. Each item is matched on its FROZEN input_hash.
--  * In a set, an item is answered by its page label or by the set's taxon
--    answer. Confirmation never writes over a page label, and a taxon-answered
--    item refuses a later page label, so an item never has both from its own
--    set. Freeze, the next page, the set summary and the gate all read both.
--
-- Wrapped in one transaction by migrate_pg.sh.

DROP FUNCTION public.confirm_tag_eval_taxa(bigint, integer, jsonb);
ALTER TABLE public.tag_eval_label DROP COLUMN basis;

CREATE TABLE public.tag_eval_taxon_answer (
	item_id bigint PRIMARY KEY REFERENCES public.tag_eval_item (id) ON DELETE CASCADE,
	set_id bigint NOT NULL REFERENCES public.tag_eval_set (id) ON DELETE CASCADE,
	-- The confirmed taxon, "rank:value"; the answer is always Yes.
	taxon text NOT NULL CHECK (taxon ~ '^(order|family|genus):[A-Za-z]+$'),
	confirmed_by integer NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tag_eval_taxon_answer_set ON public.tag_eval_taxon_answer (set_id);
CREATE TRIGGER tag_eval_taxon_answer_immutable
	BEFORE UPDATE OR DELETE ON public.tag_eval_taxon_answer
	FOR EACH ROW EXECUTE FUNCTION public.tag_reject_mutation();
REVOKE ALL ON public.tag_eval_taxon_answer FROM birds_app, PUBLIC;
GRANT SELECT ON public.tag_eval_taxon_answer TO birds_app;

CREATE FUNCTION public.confirm_tag_eval_taxa(p_set_id bigint, p_user_id integer, p_taxa jsonb)
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

-- Page labels: unchanged, except a page its set already answered by a taxon
-- confirmation refuses a page label (one answer per item per set).
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
	SELECT * INTO v_item FROM public.tag_eval_item WHERE id = p_item_id AND set_id = p_set_id;
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

-- Freeze: an item is answered by its page label OR its set's taxon answer.
CREATE OR REPLACE FUNCTION public.freeze_tag_eval_set(p_set_id bigint, p_user_id integer) RETURNS void
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
	  LEFT JOIN public.tag_eval_taxon_answer ta ON ta.item_id = i.id
	 WHERE i.set_id = p_set_id AND l.id IS NULL AND ta.item_id IS NULL;
	IF v_missing > 0 THEN
		RAISE EXCEPTION 'freeze: % item(s) are not labelled', v_missing;
	END IF;
	UPDATE public.tag_eval_set SET status = 'frozen', frozen_by = p_user_id, frozen_at = now() WHERE id = p_set_id;
END $$;

REVOKE ALL ON FUNCTION public.confirm_tag_eval_taxa(bigint, integer, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.confirm_tag_eval_taxa(bigint, integer, jsonb) TO birds_app;
REVOKE ALL ON FUNCTION public.record_tag_eval_label(bigint, bigint, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_tag_eval_label(bigint, bigint, integer, text) TO birds_app;
REVOKE ALL ON FUNCTION public.freeze_tag_eval_set(bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.freeze_tag_eval_set(bigint, integer) TO birds_app;

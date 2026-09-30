-- td-894144 Release B3 (plan "Admin Tags tab" §3 Proposals): the owner's
-- Reject action. birds_app has no UPDATE on tag_rule_proposal (it may only
-- INSERT drafts), so the status change goes through this definer. user_id is
-- audit data (Option A); the admin route is the auth boundary.
--
-- Wrapped in one transaction by migrate_pg.sh.

CREATE FUNCTION public.reject_tag_proposal(p_proposal_id uuid, p_user_id integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
	v_status text;
BEGIN
	SELECT status INTO v_status FROM public.tag_rule_proposal WHERE id = p_proposal_id FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'reject: no proposal %', p_proposal_id;
	END IF;
	IF v_status NOT IN ('proposed', 'crosschecked') THEN
		RAISE EXCEPTION 'reject: proposal is %', v_status;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_user_id AND role = 'admin') THEN
		RAISE EXCEPTION 'reject: user % is not an admin (audit check)', p_user_id;
	END IF;
	UPDATE public.tag_rule_proposal SET status = 'rejected' WHERE id = p_proposal_id;
END $$;

REVOKE ALL ON FUNCTION public.reject_tag_proposal(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reject_tag_proposal(uuid, integer) TO birds_app;

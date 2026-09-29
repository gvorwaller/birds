-- Release A of td-894144: close the AI → tags path, with no change to any
-- existing tag or search-vector bytes.
-- Plan: docs/2026-09-26-ai-tag-accuracy-plan-CC.md (rev 10, "Release A").
--
-- Owner principle (2026-09-26): AI is never used to generate, drop or change
-- a species tag. Only approved, blind-tested rules will (Release B). This
-- migration makes that true at the database layer:
--
--   A2  legacy_tags — a byte-for-byte snapshot of today's AI tags, taken ONLY
--       where an AI run actually happened (ai_generated_at IS NOT NULL at this
--       cutover). NULL means "never evaluated", never "evaluated, none". After
--       this migration it can never be created or changed by the runtime.
--   A3  search_tsv is derived by the database from the row's own columns.
--       Writers stop computing it; the formula is the one the app used
--       (species-enrichment.ts tsvExpr), verified equal on all 10,898
--       birds_test rows by CODEX1 and again when this migration was written.
--   A4  grants — birds_app loses table-level INSERT/UPDATE on
--       species_enrichment and gets column-level INSERT/UPDATE on every
--       column EXCEPT tags, legacy_tags and search_tsv. A column-level REVOKE
--       alone would not work: 0002_grants.sql grants table-level privileges,
--       which override column revokes.
--
-- RULE FOR FUTURE MIGRATIONS: a column added to species_enrichment is
-- DENIED to birds_app until that migration explicitly grants it
-- (GRANT INSERT (col), UPDATE (col) ON species_enrichment TO birds_app).
-- species_enrichment has no sequence; no sequence grants change here.
--
-- Wrapped in one transaction by migrate_pg.sh (no BEGIN/COMMIT here). The
-- ALTER TABLE takes ACCESS EXCLUSIVE, so no runtime writer can race the
-- snapshot, the checks or the ACL change.

-- Take the lock BEFORE the pre-migration hash/equality reads. Relying on the
-- later ALTER TABLE to acquire it would leave a writer race between the
-- recorded "before" state and the actual cutover.
LOCK TABLE public.species_enrichment IN ACCESS EXCLUSIVE MODE;

-- Release-A byte-identity proof. The temp table carries the ordered pre-hash
-- to the post-check at the end of this same migration transaction. Encoding
-- is the rev-10 contract: one JSON row per species, newline-separated, with
-- SQL NULL represented as JSON null.
CREATE TEMP TABLE td_894144_hash_before (hash text NOT NULL) ON COMMIT DROP;
INSERT INTO td_894144_hash_before (hash)
SELECT encode(sha256(convert_to(coalesce(string_agg(
	json_build_array(species_code, tags, search_tsv::text)::text,
	E'\n' ORDER BY species_code
), ''), 'UTF8')), 'hex')
  FROM public.species_enrichment;

-- ── A3: the search-vector function (one definition, used by the trigger and
-- the equality check below) ──────────────────────────────────────────────
CREATE FUNCTION public.species_search_vector(
	p_tags text[], p_extract text, p_field_craft text, p_sections jsonb
) RETURNS tsvector
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $$
	SELECT
	    setweight(to_tsvector('english'::regconfig,
	        translate(array_to_string(coalesce(p_tags, '{}'::text[]), ' '), ':-', '  ')), 'A')
	 || setweight(to_tsvector('english'::regconfig,
	        coalesce(p_extract, '') || ' ' || coalesce(p_field_craft, '')), 'B')
	 || setweight(to_tsvector('english'::regconfig, coalesce(
	        (SELECT string_agg(s->>'text', ' ')
	           FROM jsonb_array_elements(coalesce(p_sections, '[]'::jsonb)) s), '')), 'C')
$$;

-- Abort if the database formula differs from ANY stored vector. A NULL stored
-- vector is distinct from the non-NULL vector produced by this total function
-- and must abort too; silently accepting it would violate the cutover's
-- byte/formula identity contract.
DO $$
DECLARE
	v_mismatch integer;
BEGIN
	SELECT count(*) FILTER (WHERE search_tsv IS DISTINCT FROM public.species_search_vector(
	               tags, wikipedia_extract, field_craft, wikipedia_sections))
	  INTO v_mismatch
	  FROM public.species_enrichment;
	IF v_mismatch > 0 THEN
		RAISE EXCEPTION 'td-894144: % stored search_tsv values differ from species_search_vector(); aborting', v_mismatch;
	END IF;
	RAISE NOTICE 'td-894144: search_tsv equality check passed';
END $$;

-- ── A2: the protected legacy snapshot ─────────────────────────────────────
ALTER TABLE public.species_enrichment ADD COLUMN legacy_tags text[];

UPDATE public.species_enrichment
   SET legacy_tags = tags
 WHERE ai_generated_at IS NOT NULL;

DO $$
DECLARE
	v_populated integer;
	v_mismatch integer;
BEGIN
	SELECT count(*) FILTER (WHERE legacy_tags IS NOT NULL),
	       count(*) FILTER (WHERE (ai_generated_at IS NOT NULL) <> (legacy_tags IS NOT NULL)
	                          OR (legacy_tags IS NOT NULL AND legacy_tags IS DISTINCT FROM tags))
	  INTO v_populated, v_mismatch
	  FROM public.species_enrichment;
	IF v_mismatch > 0 THEN
		RAISE EXCEPTION 'td-894144: legacy_tags snapshot mismatch on % rows; aborting', v_mismatch;
	END IF;
	RAISE NOTICE 'td-894144: legacy_tags populated on % rows', v_populated;
END $$;

-- Installed AFTER the snapshot. Rejects any INSERT carrying legacy_tags and
-- any UPDATE that changes it — so no runtime path, AI or otherwise, can ever
-- create or alter a legacy baseline.
--
-- One deliberate, triple-keyed exception, for owned TEST fixtures only: in
-- the birds_test database, the table owner (birds_owner — used by migrations
-- and the test fixture helper, never by the running app) may write
-- legacy_tags when it also sets the transaction-local flag
-- birds.legacy_fixture = 'on'. Production's database name fails the first
-- condition; birds_app fails the role condition, so the flag alone opens
-- nothing in either environment.
CREATE FUNCTION public.species_enrichment_legacy_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
	IF current_database() = 'birds_test'
	   AND current_user = 'birds_owner'
	   AND coalesce(current_setting('birds.legacy_fixture', true), '') = 'on' THEN
		RETURN NEW;
	END IF;
	IF TG_OP = 'INSERT' AND NEW.legacy_tags IS NOT NULL THEN
		RAISE EXCEPTION 'legacy_tags is immutable (td-894144): it cannot be set on insert'
			USING ERRCODE = 'insufficient_privilege';
	END IF;
	IF TG_OP = 'UPDATE' AND NEW.legacy_tags IS DISTINCT FROM OLD.legacy_tags THEN
		RAISE EXCEPTION 'legacy_tags is immutable (td-894144)'
			USING ERRCODE = 'insufficient_privilege';
	END IF;
	RETURN NEW;
END $$;

-- Trigger names sort so the guard fires first; neither trigger reads a column
-- the other writes, so correctness does not depend on the order.
CREATE TRIGGER species_enrichment_a_legacy_guard
	BEFORE INSERT OR UPDATE ON public.species_enrichment
	FOR EACH ROW EXECUTE FUNCTION public.species_enrichment_legacy_guard();

-- ── A3: the search-vector trigger ─────────────────────────────────────────
-- UPDATE OF lists only the vector's inputs (plus search_tsv itself, so a
-- supplied value is always overwritten): media / iNat / status updates do not
-- recompute a GIN-indexed vector. INSERT always fires.
CREATE FUNCTION public.species_enrichment_search_tsv() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
	NEW.search_tsv := public.species_search_vector(
		NEW.tags, NEW.wikipedia_extract, NEW.field_craft, NEW.wikipedia_sections);
	RETURN NEW;
END $$;

CREATE TRIGGER species_enrichment_b_search_tsv
	BEFORE INSERT OR UPDATE OF tags, wikipedia_extract, field_craft, wikipedia_sections, search_tsv
	ON public.species_enrichment
	FOR EACH ROW EXECUTE FUNCTION public.species_enrichment_search_tsv();

-- ── A4: grants ────────────────────────────────────────────────────────────
REVOKE INSERT, UPDATE ON public.species_enrichment FROM birds_app;

DO $$
DECLARE
	v_cols text;
	v_list text[];
BEGIN
	SELECT array_agg(column_name::text ORDER BY ordinal_position)
	  INTO v_list
	  FROM information_schema.columns
	 WHERE table_schema = 'public' AND table_name = 'species_enrichment'
	   AND column_name NOT IN ('tags', 'legacy_tags', 'search_tsv');
	SELECT string_agg(quote_ident(c), ', ') INTO v_cols FROM unnest(v_list) c;
	EXECUTE format('GRANT INSERT (%s), UPDATE (%s) ON public.species_enrichment TO birds_app',
	               v_cols, v_cols);
	RAISE NOTICE 'td-894144: birds_app column INSERT/UPDATE granted on: %', v_cols;
END $$;

-- The trigger functions run as the invoking role; birds_app needs EXECUTE on
-- the vector function (PUBLIC has it by default for SQL functions — made
-- explicit here so a future REVOKE ... FROM PUBLIC cannot silently break
-- every write).
GRANT EXECUTE ON FUNCTION public.species_search_vector(text[], text, text, jsonb) TO birds_app;

-- Assert and log that Release A changed neither protected value. Because the
-- ACCESS EXCLUSIVE lock has been held since the first statement, the two
-- hashes describe one race-free cutover.
DO $$
DECLARE
	v_before text;
	v_after text;
BEGIN
	SELECT hash INTO v_before FROM td_894144_hash_before;
	SELECT encode(sha256(convert_to(coalesce(string_agg(
		json_build_array(species_code, tags, search_tsv::text)::text,
		E'\n' ORDER BY species_code
	), ''), 'UTF8')), 'hex')
	  INTO v_after
	  FROM public.species_enrichment;
	IF v_after IS DISTINCT FROM v_before THEN
		RAISE EXCEPTION 'td-894144: protected corpus hash changed (before %, after %); aborting',
			v_before, v_after;
	END IF;
	RAISE NOTICE 'td-894144: protected corpus SHA-256 unchanged: %', v_after;
END $$;

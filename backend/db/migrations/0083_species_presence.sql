-- td-7162f6: one maintained species-presence layer (plan:
-- docs/2026-10-11-species-presence-whole-app-plan.md, Revision 2).
--
-- Extends the trigger-maintained study membership of 0053-0055 instead of
-- adding a second writer:
--
--  1. ONE definition ("effective presence"): a species is present at a
--     location iff some week has freq > 0 in a week whose sample size is
--     > 0 -- exactly species_month_freq.num > 0, which the Hotspots & data
--     totals, the Field Guide place filter and the forecasts already use.
--     0053 counted any weekly row, so ~13.8 k zero-checklist-only pairs
--     (freq 0.0015 in n = 0 weeks) disagreed on 55 countries (prod,
--     2026-10-11). Premises enforced here: sample sizes are >= 0 (CHECK),
--     and the weekly/monthly parity audit was exact on prod (2,318,347
--     pairs, 0 one-sided).
--  2. A first-level region grain: species_location_membership.region_code
--     ('US-FL', 'NO-18'; NULL for country-level or unassigned locations) and
--     species_region_membership(region_code, species_code, source_count),
--     maintained by the same delta trigger as the country table.
--  3. One refresh per location per transaction. storeFrequencies deletes a
--     location's weekly rows and re-inserts them in 500-row statements; the
--     0053 statement triggers refreshed the location after EVERY statement
--     (the delete emptied it, each batch re-added species), churning the
--     country table on every load. Now every trigger only queues the
--     location in species_presence_pending; a deferred constraint trigger
--     refreshes each queued location once, at commit.
--  4. species_presence_state.version: bumped by every committed presence
--     change, every taxonomy write and every truncate guard. The web process
--     caches the Hotspots & data totals by it.
--
-- Wrapped in one transaction by migrate_pg.sh. Run with the worker paused
-- and idle (runbook in the plan, D2-ops). Writes to frequency_fetch and
-- species_frequency are blocked until commit; reads are blocked only by the
-- final ACCESS EXCLUSIVE statements (milliseconds, see the end). Measured on
-- the 2026-10-11 prod backup on the M4: ~14.7 s in all.
SET LOCAL lock_timeout = '60s';
LOCK TABLE frequency_fetch, species_frequency IN SHARE ROW EXCLUSIVE MODE;
SET LOCAL work_mem = '256MB';

-- ── region grain ────────────────────────────────────────────────────────────
CREATE FUNCTION study_region_code(kind text, loc text, region text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN code ~ '^[A-Z]{2}-[A-Z0-9]+(-[A-Z0-9]+)?$'
              THEN split_part(code, '-', 1) || '-' || split_part(code, '-', 2) END
  FROM (SELECT upper(btrim(CASE WHEN kind = 'region' THEN loc ELSE region END)) AS code) c
$$;

ALTER TABLE species_location_membership
  ADD COLUMN region_code text CHECK (region_code ~ '^[A-Z]{2}-[A-Z0-9]+$');

CREATE TABLE species_region_membership (
  region_code text NOT NULL CHECK (region_code ~ '^[A-Z]{2}-[A-Z0-9]+$'),
  species_code text NOT NULL,
  source_count integer NOT NULL CHECK (source_count >= 0),
  PRIMARY KEY (region_code, species_code)
);

CREATE TABLE species_presence_state (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO species_presence_state (id) VALUES (1);

-- Locations whose presence must be refreshed at commit. Rows live only
-- inside a writing transaction (the deferred trigger deletes them).
CREATE TABLE species_presence_pending (
  loc_code text PRIMARY KEY
);

REVOKE ALL ON species_region_membership, species_presence_state, species_presence_pending
  FROM birds_app, PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON species_region_membership, species_presence_pending TO birds_app;
GRANT SELECT, UPDATE ON species_presence_state TO birds_app;

-- ── backfill (old 0053 delta trigger still installed: it keeps the country
-- table exact for every location whose species set changes) ─────────────────
UPDATE species_location_membership l
   SET species_codes = COALESCE(e.codes, ARRAY[]::text[]),
       region_code = study_region_code(f.loc_kind, f.loc_code, f.region_code)
  FROM frequency_fetch f
  LEFT JOIN (
    SELECT loc_code, array_agg(species_code ORDER BY species_code) AS codes
      FROM (SELECT DISTINCT loc_code, species_code FROM species_month_freq WHERE num > 0) d
     GROUP BY loc_code
  ) e ON e.loc_code = f.loc_code
 WHERE f.loc_code = l.loc_code
   AND (l.species_codes IS DISTINCT FROM COALESCE(e.codes, ARRAY[]::text[])
        OR l.region_code IS DISTINCT FROM study_region_code(f.loc_kind, f.loc_code, f.region_code));

-- Every loaded location has a ledger row (a zero-species location too), so
-- a missing row means a broken ledger, never "0 species".
INSERT INTO species_location_membership (loc_code, country_code, region_code, species_codes)
SELECT f.loc_code, study_country_code(f.loc_kind, f.loc_code, f.region_code),
       study_region_code(f.loc_kind, f.loc_code, f.region_code), ARRAY[]::text[]
  FROM frequency_fetch f
 WHERE NOT EXISTS (SELECT 1 FROM species_location_membership l WHERE l.loc_code = f.loc_code);

INSERT INTO species_region_membership (region_code, species_code, source_count)
SELECT region_code, species_code, count(*)::integer
  FROM species_location_membership CROSS JOIN LATERAL unnest(species_codes) AS species_code
 WHERE region_code IS NOT NULL
 GROUP BY region_code, species_code;

-- ── delta trigger: country + region + version ───────────────────────────────
-- Advisory locks in one order: all countries (sorted), then all regions
-- (sorted). Deltas applied in (code, species) order.
CREATE OR REPLACE FUNCTION update_study_country_membership() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_country text; new_country text;
  old_region text;  new_region text;
  old_codes text[] := ARRAY[]::text[];
  new_codes text[] := ARRAY[]::text[];
  k text;
  delta record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_country := OLD.country_code; old_region := OLD.region_code; old_codes := OLD.species_codes;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_country := NEW.country_code; new_region := NEW.region_code; new_codes := NEW.species_codes;
  END IF;
  IF old_country IS NOT DISTINCT FROM new_country AND old_region IS NOT DISTINCT FROM new_region
     AND old_codes = new_codes THEN
    RETURN NULL;
  END IF;
  FOR k IN SELECT DISTINCT c FROM unnest(ARRAY[old_country, new_country]) c
            WHERE c IS NOT NULL ORDER BY c LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('study-country:' || k, 0));
  END LOOP;
  FOR k IN SELECT DISTINCT r FROM unnest(ARRAY[old_region, new_region]) r
            WHERE r IS NOT NULL ORDER BY r LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('study-region:' || k, 0));
  END LOOP;

  FOR delta IN
    SELECT c, s, sum(n)::integer AS n FROM (
      SELECT old_country AS c, unnest(old_codes) AS s, -1 AS n
      UNION ALL
      SELECT new_country, unnest(new_codes), 1
    ) changes WHERE c IS NOT NULL GROUP BY c, s HAVING sum(n) <> 0 ORDER BY c, s
  LOOP
    IF delta.n > 0 THEN
      INSERT INTO species_country_membership (country_code, species_code, source_count)
      VALUES (delta.c, delta.s, delta.n)
      ON CONFLICT (country_code, species_code) DO UPDATE
        SET source_count = species_country_membership.source_count + EXCLUDED.source_count;
    ELSE
      UPDATE species_country_membership SET source_count = source_count + delta.n
       WHERE country_code = delta.c AND species_code = delta.s;
      IF NOT FOUND THEN RAISE EXCEPTION 'Missing study country contribution'; END IF;
      DELETE FROM species_country_membership
       WHERE country_code = delta.c AND species_code = delta.s AND source_count = 0;
    END IF;
  END LOOP;

  FOR delta IN
    SELECT r, s, sum(n)::integer AS n FROM (
      SELECT old_region AS r, unnest(old_codes) AS s, -1 AS n
      UNION ALL
      SELECT new_region, unnest(new_codes), 1
    ) changes WHERE r IS NOT NULL GROUP BY r, s HAVING sum(n) <> 0 ORDER BY r, s
  LOOP
    IF delta.n > 0 THEN
      INSERT INTO species_region_membership (region_code, species_code, source_count)
      VALUES (delta.r, delta.s, delta.n)
      ON CONFLICT (region_code, species_code) DO UPDATE
        SET source_count = species_region_membership.source_count + EXCLUDED.source_count;
    ELSE
      UPDATE species_region_membership SET source_count = source_count + delta.n
       WHERE region_code = delta.r AND species_code = delta.s;
      IF NOT FOUND THEN RAISE EXCEPTION 'Missing study region contribution'; END IF;
      DELETE FROM species_region_membership
       WHERE region_code = delta.r AND species_code = delta.s AND source_count = 0;
    END IF;
  END LOOP;

  UPDATE species_presence_state SET version = version + 1, updated_at = now() WHERE id = 1;
  RETURN NULL;
END $$;

-- ── location refresh (effective presence, one per location per txn) ─────────
CREATE OR REPLACE FUNCTION refresh_study_location_membership(loc text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM frequency_fetch WHERE loc_code = loc FOR NO KEY UPDATE;
  IF NOT FOUND THEN RETURN; END IF; -- parent deletion cascades the ledger
  INSERT INTO species_location_membership (loc_code, country_code, region_code, species_codes)
  SELECT f.loc_code, study_country_code(f.loc_kind, f.loc_code, f.region_code),
         study_region_code(f.loc_kind, f.loc_code, f.region_code),
         ARRAY(SELECT DISTINCT sf.species_code FROM species_frequency sf
                WHERE sf.loc_code = loc AND sf.freq > 0
                  AND COALESCE(f.sample_sizes[sf.week], 0) > 0
                ORDER BY sf.species_code)
    FROM frequency_fetch f WHERE f.loc_code = loc
  ON CONFLICT (loc_code) DO UPDATE
    SET country_code = EXCLUDED.country_code, region_code = EXCLUDED.region_code,
        species_codes = EXCLUDED.species_codes
    WHERE (species_location_membership.country_code, species_location_membership.region_code,
           species_location_membership.species_codes)
      IS DISTINCT FROM (EXCLUDED.country_code, EXCLUDED.region_code, EXCLUDED.species_codes);
END $$;

-- Deferred: refresh each queued location once at commit, then dequeue it.
CREATE FUNCTION flush_species_presence_pending() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM species_presence_pending WHERE loc_code = NEW.loc_code;
  IF FOUND THEN
    PERFORM refresh_study_location_membership(NEW.loc_code);
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER species_presence_flush
AFTER INSERT ON species_presence_pending
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION flush_species_presence_pending();

CREATE FUNCTION queue_species_presence(locs text[]) RETURNS void LANGUAGE sql AS $$
  INSERT INTO species_presence_pending (loc_code)
  SELECT DISTINCT l FROM unnest(locs) l WHERE l IS NOT NULL ORDER BY l
  ON CONFLICT (loc_code) DO NOTHING
$$;

-- Weekly-row statements: queue, don't refresh.
CREATE OR REPLACE FUNCTION refresh_study_inserted_locations() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM queue_species_presence(ARRAY(SELECT DISTINCT loc_code FROM new_reports));
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION refresh_study_deleted_locations() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM queue_species_presence(ARRAY(SELECT DISTINCT loc_code FROM old_reports));
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION refresh_study_updated_locations() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM queue_species_presence(
    ARRAY(SELECT loc_code FROM old_reports UNION SELECT loc_code FROM new_reports));
  RETURN NULL;
END $$;

-- ── taxonomy: category decides what counts ──────────────────────────────────
CREATE FUNCTION bump_species_presence_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE species_presence_state SET version = version + 1, updated_at = now() WHERE id = 1;
  RETURN NULL;
END $$;
CREATE TRIGGER species_presence_taxonomy_change
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON taxonomy_cache
FOR EACH STATEMENT EXECUTE FUNCTION bump_species_presence_version();

-- ── truncate guards (0053/0055 + region + version) ──────────────────────────
-- species_frequency truncate → location ledger; location ledger truncate (direct
-- or CASCADE from frequency_fetch) → country AND region tables, version bump.
-- 0055: never truncate a table that a CASCADE already emptied.
CREATE OR REPLACE FUNCTION truncate_study_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'species_frequency' THEN
    IF EXISTS (SELECT 1 FROM species_location_membership) THEN
      TRUNCATE species_location_membership;
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM species_country_membership) THEN
      TRUNCATE species_country_membership;
    END IF;
    IF EXISTS (SELECT 1 FROM species_region_membership) THEN
      TRUNCATE species_region_membership;
    END IF;
    DELETE FROM species_presence_pending;
    UPDATE species_presence_state SET version = version + 1, updated_at = now() WHERE id = 1;
  END IF;
  RETURN NULL;
END $$;

-- ── retire the 0082 recount ─────────────────────────────────────────────────
-- refresh_species_counts stays in jobs_type_check for history; a copy the old
-- worker enqueues mid-deploy completes as a no-op in the new one.
-- species_count_snapshot stays one release as the verification reference.
DELETE FROM jobs WHERE type = 'refresh_species_counts' AND status = 'pending';

ANALYZE species_location_membership;
ANALYZE species_country_membership;
ANALYZE species_region_membership;

-- ── LAST: statements that take ACCESS EXCLUSIVE on frequency_fetch ──────────
-- Every lock is held until commit. ADD CONSTRAINT and DROP TRIGGER block even
-- READS of frequency_fetch (nearly every page), so they run here, after the
-- backfill and ANALYZE: the read-blocking window is milliseconds, not the
-- whole migration. (The ADD COLUMN on species_location_membership above does
-- hold ACCESS EXCLUSIVE on the ledger for the whole migration: only the
-- /viewed study list reads it.)

-- Premise of the presence definition: sample sizes are never negative.
ALTER TABLE frequency_fetch
  ADD CONSTRAINT frequency_fetch_sample_sizes_nonnegative CHECK (0 <= ALL (sample_sizes));

-- Location metadata: a new location gets a ledger row; a geography or
-- sample-size change re-derives its presence.
DROP TRIGGER study_location_remap ON frequency_fetch;
DROP FUNCTION remap_study_location_membership();
CREATE FUNCTION queue_species_presence_for_location() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM queue_species_presence(ARRAY[NEW.loc_code]);
  RETURN NULL;
END $$;
CREATE TRIGGER species_presence_location_insert AFTER INSERT ON frequency_fetch
FOR EACH ROW EXECUTE FUNCTION queue_species_presence_for_location();
CREATE TRIGGER species_presence_location_update
AFTER UPDATE OF loc_kind, loc_code, region_code, sample_sizes ON frequency_fetch
FOR EACH ROW
WHEN (OLD.loc_kind IS DISTINCT FROM NEW.loc_kind OR OLD.loc_code IS DISTINCT FROM NEW.loc_code
      OR OLD.region_code IS DISTINCT FROM NEW.region_code
      OR OLD.sample_sizes IS DISTINCT FROM NEW.sample_sizes)
EXECUTE FUNCTION queue_species_presence_for_location();


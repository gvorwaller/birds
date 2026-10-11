-- Rolls back 0083_species_presence.sql (td-7162f6). Not auto-applied: move it
-- into migrations/ in the same commit as the code revert (Hotspots & data back
-- to the 0082 snapshot reader + refresh_species_counts job), worker paused.
--
-- Restores the 0053-0055 membership behaviour exactly: per-statement location
-- refresh from any weekly row, country table only, the remap trigger. The
-- location arrays are recomputed with the 0053 definition (any weekly row) and
-- the country table rebuilt from them.
SET LOCAL lock_timeout = '60s';
LOCK TABLE frequency_fetch, species_frequency IN SHARE ROW EXCLUSIVE MODE;
SET LOCAL work_mem = '256MB';

DROP TRIGGER species_presence_taxonomy_change ON taxonomy_cache;
DROP FUNCTION bump_species_presence_version();
DROP TRIGGER species_presence_location_insert ON frequency_fetch;
DROP TRIGGER species_presence_location_update ON frequency_fetch;
DROP FUNCTION queue_species_presence_for_location();
DROP TRIGGER species_presence_flush ON species_presence_pending;
DROP FUNCTION flush_species_presence_pending();

-- 0053 statement-trigger bodies (refresh per statement)
CREATE OR REPLACE FUNCTION refresh_study_inserted_locations() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE loc text;
BEGIN
  FOR loc IN SELECT DISTINCT loc_code FROM new_reports ORDER BY loc_code LOOP
    PERFORM refresh_study_location_membership(loc);
  END LOOP;
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION refresh_study_deleted_locations() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE loc text;
BEGIN
  FOR loc IN SELECT DISTINCT loc_code FROM old_reports ORDER BY loc_code LOOP
    PERFORM refresh_study_location_membership(loc);
  END LOOP;
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION refresh_study_updated_locations() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE loc text;
BEGIN
  FOR loc IN SELECT loc_code FROM old_reports UNION SELECT loc_code FROM new_reports ORDER BY loc_code LOOP
    PERFORM refresh_study_location_membership(loc);
  END LOOP;
  RETURN NULL;
END $$;
DROP FUNCTION queue_species_presence(text[]);

-- 0053 delta trigger (country only)
CREATE OR REPLACE FUNCTION update_study_country_membership() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_country text; new_country text;
  old_codes text[] := ARRAY[]::text[];
  new_codes text[] := ARRAY[]::text[];
  country text;
  delta record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_country := OLD.country_code; old_codes := OLD.species_codes;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_country := NEW.country_code; new_codes := NEW.species_codes;
  END IF;
  IF old_country IS NOT DISTINCT FROM new_country AND old_codes = new_codes THEN
    RETURN NULL;
  END IF;
  FOR country IN SELECT DISTINCT c FROM unnest(ARRAY[old_country,new_country]) c
                 WHERE c IS NOT NULL ORDER BY c LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('study-country:' || country, 0));
  END LOOP;
  FOR delta IN
    SELECT c, s, sum(n)::integer AS n FROM (
      SELECT old_country AS c, unnest(old_codes) AS s, -1 AS n
      UNION ALL
      SELECT new_country, unnest(new_codes), 1
    ) changes WHERE c IS NOT NULL GROUP BY c,s HAVING sum(n) <> 0 ORDER BY c,s
  LOOP
    IF delta.n > 0 THEN
      INSERT INTO species_country_membership(country_code,species_code,source_count)
      VALUES(delta.c,delta.s,delta.n)
      ON CONFLICT(country_code,species_code) DO UPDATE
        SET source_count=species_country_membership.source_count + EXCLUDED.source_count;
    ELSE
      UPDATE species_country_membership SET source_count=source_count + delta.n
        WHERE country_code=delta.c AND species_code=delta.s;
      IF NOT FOUND THEN RAISE EXCEPTION 'Missing study country contribution'; END IF;
      DELETE FROM species_country_membership
        WHERE country_code=delta.c AND species_code=delta.s AND source_count=0;
    END IF;
  END LOOP;
  RETURN NULL;
END $$;

-- 0054 refresh (any weekly row)
CREATE OR REPLACE FUNCTION refresh_study_location_membership(loc text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM frequency_fetch WHERE loc_code=loc FOR NO KEY UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  INSERT INTO species_location_membership(loc_code,country_code,species_codes)
  SELECT f.loc_code, study_country_code(f.loc_kind,f.loc_code,f.region_code),
         ARRAY(SELECT DISTINCT species_code FROM species_frequency
               WHERE loc_code=loc ORDER BY species_code)
  FROM frequency_fetch f WHERE f.loc_code=loc
  ON CONFLICT(loc_code) DO UPDATE
    SET country_code=EXCLUDED.country_code, species_codes=EXCLUDED.species_codes
    WHERE (species_location_membership.country_code,species_location_membership.species_codes)
      IS DISTINCT FROM (EXCLUDED.country_code,EXCLUDED.species_codes);
END $$;

-- 0053 remap trigger
CREATE FUNCTION remap_study_location_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE species_location_membership
    SET country_code=study_country_code(NEW.loc_kind,NEW.loc_code,NEW.region_code)
    WHERE loc_code=NEW.loc_code AND country_code IS DISTINCT FROM
      study_country_code(NEW.loc_kind,NEW.loc_code,NEW.region_code);
  RETURN NULL;
END $$;
CREATE TRIGGER study_location_remap AFTER UPDATE OF loc_kind,region_code ON frequency_fetch
FOR EACH ROW EXECUTE FUNCTION remap_study_location_membership();

-- 0055 truncate guard
CREATE OR REPLACE FUNCTION truncate_study_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='species_frequency' THEN
    IF EXISTS (SELECT 1 FROM species_location_membership) THEN
      TRUNCATE species_location_membership;
    END IF;
  ELSIF EXISTS (SELECT 1 FROM species_country_membership) THEN
    TRUNCATE species_country_membership;
  END IF;
  RETURN NULL;
END $$;

DROP TABLE species_presence_pending;
DROP TABLE species_presence_state;
DROP TABLE species_region_membership;
ALTER TABLE species_location_membership DROP COLUMN region_code;
DROP FUNCTION study_region_code(text, text, text);
ALTER TABLE frequency_fetch DROP CONSTRAINT frequency_fetch_sample_sizes_nonnegative;

-- 0053 definition: arrays from any weekly row, country table rebuilt.
UPDATE species_location_membership l
   SET species_codes = COALESCE(s.codes, ARRAY[]::text[])
  FROM (SELECT f.loc_code, (SELECT array_agg(DISTINCT sf.species_code ORDER BY sf.species_code)
                              FROM species_frequency sf WHERE sf.loc_code = f.loc_code) AS codes
          FROM frequency_fetch f) s
 WHERE s.loc_code = l.loc_code
   AND l.species_codes IS DISTINCT FROM COALESCE(s.codes, ARRAY[]::text[]);

ANALYZE species_location_membership;
ANALYZE species_country_membership;

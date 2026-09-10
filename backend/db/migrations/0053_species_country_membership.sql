-- Incrementally maintained study-country membership (td-81600d follow-up).
-- Unlike REFRESH MATERIALIZED VIEW, report writes only rebuild the affected
-- location's distinct species, then apply membership deltas to the country.
-- The small location ledger preserves contributions from every county/hotspot;
-- source_count ensures deleting one source cannot erase another's report.
-- No taxonomy FK: retired codes and taxonomy replacement must remain safe.
-- Triggers cover old workers during deployment, direct imports, remapping,
-- cascaded deletion, and rollback without an application refresh convention.
-- https://www.postgresql.org/docs/17/trigger-definition.html
-- The migration runner supplies the transaction. Block report writes during
-- backfill so no changes can fall between the initial summary and its triggers.
SET LOCAL lock_timeout = '15s';
LOCK TABLE frequency_fetch, species_frequency IN SHARE ROW EXCLUSIVE MODE;
SET LOCAL work_mem = '64MB';

CREATE FUNCTION study_country_code(kind text, loc text, region text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN code ~ '^[A-Z]{2}(-[A-Z0-9]+){0,2}$'
              THEN split_part(code, '-', 1) END
  FROM (SELECT upper(btrim(CASE WHEN kind = 'region' THEN loc ELSE region END)) AS code) c
$$;

CREATE TABLE species_location_membership (
  loc_code text PRIMARY KEY REFERENCES frequency_fetch(loc_code) ON DELETE CASCADE,
  country_code text,
  species_codes text[] NOT NULL,
  CHECK (country_code ~ '^[A-Z]{2}$')
);
CREATE TABLE species_country_membership (
  country_code text NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  species_code text NOT NULL,
  source_count integer NOT NULL CHECK (source_count >= 0),
  PRIMARY KEY (country_code, species_code)
);
CREATE INDEX species_country_membership_species_idx
  ON species_country_membership (species_code, country_code);
GRANT SELECT, INSERT, UPDATE, DELETE ON
  species_location_membership, species_country_membership TO birds_app;

INSERT INTO species_location_membership (loc_code, country_code, species_codes)
SELECT f.loc_code, study_country_code(f.loc_kind, f.loc_code, f.region_code),
       COALESCE(s.codes, ARRAY[]::text[])
FROM frequency_fetch f LEFT JOIN (
  SELECT loc_code, array_agg(DISTINCT species_code ORDER BY species_code) AS codes
  FROM species_frequency GROUP BY loc_code
) s USING (loc_code);
INSERT INTO species_country_membership (country_code, species_code, source_count)
SELECT country_code, species_code, count(*)::integer
FROM species_location_membership CROSS JOIN LATERAL unnest(species_codes) AS species_code
WHERE country_code IS NOT NULL GROUP BY country_code, species_code;

-- Serialize country deltas (including moves in both directions) in one order.
-- Only actual additions/removals touch the compact country table. Weekly
-- frequency changes that preserve species membership do not rewrite it.
CREATE FUNCTION update_study_country_membership() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_country text;
  new_country text;
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
CREATE TRIGGER study_country_membership_delta
AFTER INSERT OR UPDATE OR DELETE ON species_location_membership
FOR EACH ROW EXECUTE FUNCTION update_study_country_membership();

CREATE FUNCTION refresh_study_location_membership(loc text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  -- Serialize same-location refreshes before reading weekly rows. Standard
  -- imports already hold this row lock through their frequency_fetch upsert.
  PERFORM 1 FROM frequency_fetch WHERE loc_code=loc FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF; -- parent deletion cascades the ledger
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

-- One refresh per affected location per statement (not once per weekly row).
CREATE FUNCTION refresh_study_inserted_locations() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE loc text;
BEGIN
  FOR loc IN SELECT DISTINCT loc_code FROM new_reports ORDER BY loc_code LOOP
    PERFORM refresh_study_location_membership(loc);
  END LOOP;
  RETURN NULL;
END $$;
CREATE FUNCTION refresh_study_deleted_locations() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE loc text;
BEGIN
  FOR loc IN SELECT DISTINCT loc_code FROM old_reports ORDER BY loc_code LOOP
    PERFORM refresh_study_location_membership(loc);
  END LOOP;
  RETURN NULL;
END $$;
CREATE FUNCTION refresh_study_updated_locations() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE loc text;
BEGIN
  FOR loc IN SELECT loc_code FROM old_reports UNION SELECT loc_code FROM new_reports ORDER BY loc_code LOOP
    PERFORM refresh_study_location_membership(loc);
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER study_reports_insert AFTER INSERT ON species_frequency
REFERENCING NEW TABLE AS new_reports FOR EACH STATEMENT EXECUTE FUNCTION refresh_study_inserted_locations();
CREATE TRIGGER study_reports_delete AFTER DELETE ON species_frequency
REFERENCING OLD TABLE AS old_reports FOR EACH STATEMENT EXECUTE FUNCTION refresh_study_deleted_locations();
CREATE TRIGGER study_reports_update AFTER UPDATE ON species_frequency
REFERENCING OLD TABLE AS old_reports NEW TABLE AS new_reports
FOR EACH STATEMENT EXECUTE FUNCTION refresh_study_updated_locations();

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

-- Owner-only bulk resets must not leave summaries behind either.
CREATE FUNCTION truncate_study_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='species_frequency' THEN
    TRUNCATE species_location_membership;
  ELSE
    TRUNCATE species_country_membership;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER study_reports_truncate AFTER TRUNCATE ON species_frequency
FOR EACH STATEMENT EXECUTE FUNCTION truncate_study_membership();
CREATE TRIGGER study_locations_truncate AFTER TRUNCATE ON species_location_membership
FOR EACH STATEMENT EXECUTE FUNCTION truncate_study_membership();

ANALYZE species_location_membership;
ANALYZE species_country_membership;

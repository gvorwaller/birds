-- Allow concurrent weekly inserts to retain their FK KEY SHARE locks while
-- waiting for a same-location refresh. FOR UPDATE would unnecessarily conflict
-- with those FK locks and cause a lock-upgrade deadlock. NO KEY UPDATE still
-- serializes refreshes and report metadata writes, without changing the key.
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

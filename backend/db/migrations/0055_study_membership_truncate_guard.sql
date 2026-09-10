-- A parent TRUNCATE CASCADE already truncates the location ledger. Its
-- statement triggers must not try to truncate the same active table again.
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

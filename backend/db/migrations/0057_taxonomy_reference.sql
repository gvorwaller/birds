-- Additive reference metadata; no changes to sightings or personal history.
ALTER TABLE taxonomy_cache
  ADD COLUMN taxon_order NUMERIC,
  ADD COLUMN order_name TEXT,
  ADD COLUMN family_code TEXT,
  ADD COLUMN family_sci_name TEXT,
  ADD COLUMN banding_codes TEXT[],
  ADD COLUMN report_as TEXT,
  ADD COLUMN extinct BOOLEAN;
CREATE INDEX taxonomy_family_order_idx ON taxonomy_cache
  (family_code, taxon_order, species_code) WHERE category='species';
CREATE INDEX taxonomy_banding_idx ON taxonomy_cache USING GIN(banding_codes)
  WHERE category='species';

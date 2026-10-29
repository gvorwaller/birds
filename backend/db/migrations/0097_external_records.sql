-- Keep every report from external sources (td-769300).
-- Plan: docs/2026-10-28-external-records-plan-CC.md.
--
-- Until now a load kept only totals (per place, month and taxon), the top
-- places and birders, and the last 14 days of reports; every other detail of
-- a report was dropped once counted. This adds:
--   - the `records` chunk kind: one row per report, staged and swapped per
--     (source, region) like the other published rows;
--   - the `taxa` chunk kind: one row per upstream taxon (its local name and
--     Red List status), upserted into the source-wide external_taxa, which
--     also carries each taxon's eBird species code (written by deriveSpecies);
--   - places' upstream id (Artskart's municipality number survives renames).
-- upstream_modified_at is TIMESTAMP, not TIMESTAMPTZ: Artskart's TrackDateTime
-- states no time zone, so it is kept exactly as given.
-- Report counts still never enter the eBird frequency tables.

ALTER TABLE external_load_chunks DROP CONSTRAINT external_load_chunks_kind_check;
ALTER TABLE external_load_chunks ADD CONSTRAINT external_load_chunks_kind_check
  CHECK (kind IN ('places', 'totals', 'taxon_month', 'localities', 'recent', 'diagnostics', 'observers', 'taxa', 'records'));

ALTER TABLE external_stage_places ADD COLUMN upstream_place_id TEXT
  CHECK (upstream_place_id IS NULL OR upstream_place_id ~ '^[A-Za-z0-9._:-]{1,64}$');
ALTER TABLE external_places ADD COLUMN upstream_place_id TEXT
  CHECK (upstream_place_id IS NULL OR upstream_place_id ~ '^[A-Za-z0-9._:-]{1,64}$');

-- ── Taxa ────────────────────────────────────────────────────────────────────
-- rank OTHER: a genus, family or hybrid report; it never gets a species code.
CREATE TABLE external_stage_taxa (
  load_id UUID NOT NULL REFERENCES external_loads(id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL,
  region_code TEXT NOT NULL,
  upstream_taxon_id TEXT NOT NULL CHECK (upstream_taxon_id ~ '^[A-Za-z0-9._:-]{1,64}$'),
  canonical_name TEXT NOT NULL CHECK (length(btrim(canonical_name)) BETWEEN 1 AND 200),
  raw_name TEXT NOT NULL CHECK (length(btrim(raw_name)) BETWEEN 1 AND 300),
  rank TEXT NOT NULL CHECK (rank IN ('SPECIES', 'SUBSPECIES', 'OTHER')),
  local_name TEXT CHECK (local_name IS NULL OR length(btrim(local_name)) BETWEEN 1 AND 200),
  red_list TEXT CHECK (red_list IS NULL OR red_list ~ '^[A-Z]{2}$'),
  red_list_url TEXT CHECK (red_list_url IS NULL OR (red_list_url ~ '^https://' AND length(red_list_url) <= 500)),
  PRIMARY KEY (load_id, upstream_taxon_id, canonical_name)
);

CREATE TABLE external_taxa (
  source_id TEXT NOT NULL REFERENCES external_sources(id) ON DELETE CASCADE,
  upstream_taxon_id TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  raw_name TEXT NOT NULL,
  rank TEXT NOT NULL CHECK (rank IN ('SPECIES', 'SUBSPECIES', 'OTHER')),
  local_name TEXT,
  red_list TEXT,
  red_list_url TEXT,
  -- Written by deriveSpecies (taxa.ts), the same match as the species rows.
  species_code TEXT CHECK (species_code IS NULL OR species_code ~ '^[a-z0-9-]{2,16}$'),
  match_reason TEXT CHECK (match_reason IS NULL
    OR match_reason IN ('override', 'scientific', 'subspecies', 'no_match', 'ambiguous', 'override_code_missing', 'not_species')),
  load_id UUID NOT NULL REFERENCES external_loads(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, upstream_taxon_id, canonical_name),
  CHECK ((species_code IS NULL) = (match_reason IS NULL OR match_reason IN ('no_match', 'ambiguous', 'override_code_missing', 'not_species')))
);
CREATE INDEX external_taxa_species_idx ON external_taxa (species_code, source_id);

-- ── Records ─────────────────────────────────────────────────────────────────
CREATE TABLE external_stage_records (
  load_id UUID NOT NULL REFERENCES external_loads(id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL,
  region_code TEXT NOT NULL,
  upstream_record_id TEXT NOT NULL CHECK (upstream_record_id ~ '^[A-Za-z0-9._:-]{1,64}$'),
  place_key TEXT NOT NULL CHECK (length(place_key) <= 140),
  upstream_taxon_id TEXT NOT NULL CHECK (upstream_taxon_id ~ '^[A-Za-z0-9._:-]{1,64}$'),
  canonical_name TEXT NOT NULL CHECK (length(btrim(canonical_name)) BETWEEN 1 AND 200),
  observed_on DATE NOT NULL,
  count INTEGER CHECK (count IS NULL OR count >= 0),
  locality TEXT CHECK (locality IS NULL OR length(btrim(locality)) BETWEEN 1 AND 300),
  lat DOUBLE PRECISION CHECK (lat IS NULL OR (lat BETWEEN -90 AND 90)),
  lon DOUBLE PRECISION CHECK (lon IS NULL OR (lon BETWEEN -180 AND 180)),
  uncertainty_m INTEGER CHECK (uncertainty_m IS NULL OR uncertainty_m >= 0),
  observers TEXT[] NOT NULL CHECK (cardinality(observers) <= 50),
  behaviour TEXT[] NOT NULL CHECK (cardinality(behaviour) <= 10),
  activity TEXT CHECK (activity IS NULL OR length(btrim(activity)) BETWEEN 1 AND 100),
  validation TEXT CHECK (validation IS NULL OR length(btrim(validation)) BETWEEN 1 AND 100),
  notes TEXT CHECK (notes IS NULL OR length(notes) <= 500),
  sex TEXT CHECK (sex IS NULL OR length(btrim(sex)) BETWEEN 1 AND 50),
  photos JSONB CHECK (photos IS NULL OR jsonb_typeof(photos) = 'array'),
  dataset TEXT CHECK (dataset IS NULL OR length(btrim(dataset)) BETWEEN 1 AND 200),
  record_url TEXT CHECK (record_url IS NULL OR (record_url ~ '^https://' AND length(record_url) <= 500)),
  upstream_modified_at TIMESTAMP,
  PRIMARY KEY (load_id, upstream_record_id),
  CHECK (place_key = region_code OR place_key LIKE region_code || ':%'),
  CHECK ((lat IS NULL) = (lon IS NULL))
);

-- Keyed by region as well as record, as external_recent_reports is.
CREATE TABLE external_records (
  source_id TEXT NOT NULL,
  region_code TEXT NOT NULL,
  upstream_record_id TEXT NOT NULL,
  place_key TEXT NOT NULL,
  upstream_taxon_id TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  observed_on DATE NOT NULL,
  count INTEGER CHECK (count IS NULL OR count >= 0),
  locality TEXT,
  lat DOUBLE PRECISION CHECK (lat IS NULL OR (lat BETWEEN -90 AND 90)),
  lon DOUBLE PRECISION CHECK (lon IS NULL OR (lon BETWEEN -180 AND 180)),
  uncertainty_m INTEGER CHECK (uncertainty_m IS NULL OR uncertainty_m >= 0),
  observers TEXT[] NOT NULL,
  behaviour TEXT[] NOT NULL,
  activity TEXT,
  validation TEXT,
  notes TEXT,
  sex TEXT,
  photos JSONB,
  dataset TEXT,
  record_url TEXT,
  upstream_modified_at TIMESTAMP,
  load_id UUID NOT NULL REFERENCES external_loads(id),
  PRIMARY KEY (source_id, region_code, upstream_record_id),
  FOREIGN KEY (source_id, place_key) REFERENCES external_places (source_id, place_key)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (source_id, upstream_taxon_id, canonical_name)
    REFERENCES external_taxa (source_id, upstream_taxon_id, canonical_name),
  CHECK (place_key = region_code OR place_key LIKE region_code || ':%'),
  CHECK ((lat IS NULL) = (lon IS NULL))
);
CREATE INDEX external_records_place_idx ON external_records (source_id, place_key, observed_on);
CREATE INDEX external_records_taxon_idx ON external_records (source_id, upstream_taxon_id, canonical_name);
CREATE INDEX external_records_latlon_idx ON external_records (lat, lon) WHERE lat IS NOT NULL;

-- 0002's default privileges grant birds_app SELECT/INSERT/UPDATE/DELETE on
-- these tables, as for the other external tables.

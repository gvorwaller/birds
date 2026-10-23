-- External sightings sources, Phase 1 (td-eec7db / td-53b207).
-- Plan: docs/2026-10-21-external-sources-plan-CC.md, "Phase 1" and
-- "Ingest contract v1".
--
-- Report counts from a non-eBird source (first: Artsobservasjoner via GBIF)
-- arrive through the generic ingest API (/api/ingest/) from a separate
-- connector process. None of these tables is joined into the eBird frequency
-- tables; they are counts of reports, never likelihoods.
--
-- Shape of a load: a connector claims a queued load (lease + fencing), sends
-- chunks into the per-kind staging tables, then finishes with a manifest; the
-- finish swaps every published row of that (source, region) in one
-- transaction. The previous good data stays published until then.
--
-- Species codes are NOT foreign keys to taxonomy_cache: taxonomy sync does
-- DELETE + reinsert of the whole table (taxonomy-sync.ts writeTaxonomy), and a
-- code dropped by a split would make that sync fail. Codes are checked when
-- they are written and re-derived from external_taxon_month on demand.
--
-- Every published or staged row that belongs to a region carries a place_key
-- that IS the region code or starts with "<region>:"; the CHECKs below make a
-- place attached to another region impossible.

-- ── Registry ────────────────────────────────────────────────────────────────
CREATE TABLE external_sources (
  id TEXT PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{1,47}$'),
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  publisher TEXT NOT NULL CHECK (length(btrim(publisher)) BETWEEN 1 AND 200),
  license TEXT NOT NULL CHECK (length(btrim(license)) BETWEEN 1 AND 60),
  license_url TEXT NOT NULL CHECK (license_url ~ '^https?://' AND length(license_url) <= 500),
  citation TEXT NOT NULL CHECK (length(btrim(citation)) BETWEEN 1 AND 2000),
  doi TEXT CHECK (doi IS NULL OR (doi ~ '^10\.[0-9]{4,}/\S+$' AND length(doi) <= 200)),
  attribution TEXT NOT NULL CHECK (length(btrim(attribution)) BETWEEN 1 AND 500),
  record_semantics TEXT NOT NULL CHECK (record_semantics IN ('reports')),
  homepage TEXT NOT NULL CHECK (homepage ~ '^https://' AND length(homepage) <= 500),
  -- {upstream_key} is replaced with external_region_map.upstream_key.
  region_link_template TEXT CHECK (region_link_template IS NULL
    OR (region_link_template ~ '^https://' AND length(region_link_template) <= 1000)),
  covers_country TEXT NOT NULL REFERENCES regions(code) CHECK (covers_country ~ '^[A-Z]{2}$'),
  geo_scheme TEXT NOT NULL CHECK (length(btrim(geo_scheme)) BETWEEN 1 AND 60),
  window_months SMALLINT NOT NULL CHECK (window_months BETWEEN 1 AND 120),
  -- The "left open" observer column: off unless the owner turns it on.
  store_observers BOOLEAN NOT NULL DEFAULT false,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per connector token. Only the SHA-256 of the token is stored.
CREATE TABLE external_connectors (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES external_sources(id) ON DELETE CASCADE,
  label TEXT NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 80),
  token_sha256 BYTEA NOT NULL UNIQUE CHECK (length(token_sha256) = 32),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX external_connectors_source_idx ON external_connectors (source_id);

-- Explicit upstream place → app region mapping (Phase 0 finding 4). Never
-- inferred from names at ingest time.
CREATE TABLE external_region_map (
  source_id TEXT NOT NULL REFERENCES external_sources(id) ON DELETE CASCADE,
  upstream_key TEXT NOT NULL CHECK (length(btrim(upstream_key)) BETWEEN 1 AND 100),
  region_code TEXT NOT NULL REFERENCES regions(code),
  PRIMARY KEY (source_id, upstream_key),
  UNIQUE (source_id, region_code)
);

-- ── Loads ───────────────────────────────────────────────────────────────────
CREATE TABLE external_loads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id TEXT NOT NULL REFERENCES external_sources(id) ON DELETE CASCADE,
  region_code TEXT NOT NULL,
  requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'leased', 'staging', 'done', 'failed', 'superseded')),
  attempt SMALLINT NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 10),
  max_attempts SMALLINT NOT NULL CHECK (max_attempts BETWEEN 1 AND 10),
  lease_token UUID,
  claim_idempotency_key TEXT CHECK (claim_idempotency_key IS NULL OR length(claim_idempotency_key) BETWEEN 8 AND 100),
  lease_expires_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  -- Earliest time a queued (or requeued) load may be claimed: retry backoff.
  not_before TIMESTAMPTZ NOT NULL DEFAULT now(),
  connector_id BIGINT REFERENCES external_connectors(id) ON DELETE SET NULL,
  -- Frozen from external_sources.window_months when the load is queued.
  window_months SMALLINT NOT NULL CHECK (window_months BETWEEN 1 AND 120),
  window_start DATE,
  window_end DATE,
  retrieved_at TIMESTAMPTZ,
  filter_fingerprint TEXT CHECK (filter_fingerprint IS NULL OR filter_fingerprint ~ '^[0-9a-f]{64}$'),
  source_snapshot JSONB,
  progress JSONB,
  error TEXT CHECK (error IS NULL OR length(error) <= 500),
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (source_id, region_code) REFERENCES external_region_map (source_id, region_code),
  -- A live load holds a lease. A finished load keeps its lease_token and
  -- attempt so a repeated finish (lost response) can be recognised.
  CHECK (status NOT IN ('leased', 'staging') OR (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK (window_start IS NULL OR window_end > window_start)
);
-- One active load per (source, region) [C-P1-1].
CREATE UNIQUE INDEX external_loads_one_active_idx ON external_loads (source_id, region_code)
  WHERE status IN ('queued', 'leased', 'staging');
-- One live lease per (connector, claim idempotency key): a retried claim can
-- never hold two loads (claimLoad also serializes on the key).
CREATE UNIQUE INDEX external_loads_claim_key_idx ON external_loads (connector_id, claim_idempotency_key)
  WHERE claim_idempotency_key IS NOT NULL AND status IN ('leased', 'staging');
CREATE INDEX external_loads_claim_idx ON external_loads (source_id, not_before)
  WHERE status IN ('queued', 'leased', 'staging');
CREATE INDEX external_loads_recent_idx ON external_loads (created_at DESC);
CREATE INDEX external_loads_requested_by_idx ON external_loads (requested_by) WHERE requested_by IS NOT NULL;

CREATE TABLE external_load_chunks (
  load_id UUID NOT NULL REFERENCES external_loads(id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL CHECK (chunk_id ~ '^[A-Za-z0-9._:-]{1,64}$'),
  kind TEXT NOT NULL CHECK (kind IN ('places', 'totals', 'taxon_month', 'localities', 'recent', 'diagnostics')),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  rows INTEGER NOT NULL CHECK (rows BETWEEN 0 AND 100000),
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (load_id, chunk_id)
);

-- ── Staging (one table per chunk kind; deleted by finish/fail; swept after
--    7 days when abandoned) ─────────────────────────────────────────────────
CREATE TABLE external_stage_places (
  load_id UUID NOT NULL REFERENCES external_loads(id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL,
  region_code TEXT NOT NULL,
  place_key TEXT NOT NULL CHECK (length(place_key) <= 140),
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  level TEXT NOT NULL CHECK (level IN ('region', 'subregion')),
  parent_key TEXT CHECK (parent_key IS NULL OR length(parent_key) <= 140),
  lat DOUBLE PRECISION CHECK (lat IS NULL OR (lat BETWEEN -90 AND 90)),
  lon DOUBLE PRECISION CHECK (lon IS NULL OR (lon BETWEEN -180 AND 180)),
  PRIMARY KEY (load_id, place_key),
  CHECK (place_key = region_code OR place_key LIKE region_code || ':%'),
  CHECK ((lat IS NULL) = (lon IS NULL))
);
CREATE TABLE external_stage_totals (
  load_id UUID NOT NULL REFERENCES external_loads(id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL,
  region_code TEXT NOT NULL,
  place_key TEXT NOT NULL CHECK (length(place_key) <= 140),
  month SMALLINT NOT NULL CHECK (month BETWEEN 1 AND 12),
  reports INTEGER NOT NULL CHECK (reports >= 0),
  unkeyed INTEGER NOT NULL CHECK (unkeyed >= 0),
  PRIMARY KEY (load_id, place_key, month),
  CHECK (place_key = region_code OR place_key LIKE region_code || ':%'),
  CHECK (unkeyed <= reports)
);
CREATE TABLE external_stage_taxon_month (
  load_id UUID NOT NULL REFERENCES external_loads(id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL,
  region_code TEXT NOT NULL,
  place_key TEXT NOT NULL CHECK (length(place_key) <= 140),
  upstream_taxon_id TEXT NOT NULL CHECK (upstream_taxon_id ~ '^[A-Za-z0-9._:-]{1,64}$'),
  month SMALLINT NOT NULL CHECK (month BETWEEN 1 AND 12),
  canonical_name TEXT NOT NULL CHECK (length(btrim(canonical_name)) BETWEEN 1 AND 200),
  raw_name TEXT NOT NULL CHECK (length(btrim(raw_name)) BETWEEN 1 AND 300),
  reports INTEGER NOT NULL CHECK (reports >= 0),
  PRIMARY KEY (load_id, place_key, upstream_taxon_id, month),
  CHECK (place_key = region_code OR place_key LIKE region_code || ':%')
);
CREATE TABLE external_stage_localities (
  load_id UUID NOT NULL REFERENCES external_loads(id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL,
  region_code TEXT NOT NULL,
  place_key TEXT NOT NULL CHECK (length(place_key) <= 140),
  rank SMALLINT NOT NULL CHECK (rank BETWEEN 1 AND 1000),
  locality TEXT NOT NULL CHECK (length(btrim(locality)) BETWEEN 1 AND 300),
  reports INTEGER NOT NULL CHECK (reports >= 0),
  lat DOUBLE PRECISION CHECK (lat IS NULL OR (lat BETWEEN -90 AND 90)),
  lon DOUBLE PRECISION CHECK (lon IS NULL OR (lon BETWEEN -180 AND 180)),
  uncertainty_m INTEGER CHECK (uncertainty_m IS NULL OR uncertainty_m >= 0),
  placement TEXT NOT NULL CHECK (placement IN ('pin', 'text')),
  PRIMARY KEY (load_id, place_key, rank),
  CHECK (place_key = region_code OR place_key LIKE region_code || ':%'),
  CHECK ((lat IS NULL) = (lon IS NULL)),
  CHECK (placement = 'text' OR lat IS NOT NULL)
);
CREATE TABLE external_stage_recent (
  load_id UUID NOT NULL REFERENCES external_loads(id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL,
  region_code TEXT NOT NULL,
  upstream_record_id TEXT NOT NULL CHECK (upstream_record_id ~ '^[A-Za-z0-9._:-]{1,64}$'),
  place_key TEXT NOT NULL CHECK (length(place_key) <= 140),
  upstream_taxon_id TEXT NOT NULL CHECK (upstream_taxon_id ~ '^[A-Za-z0-9._:-]{1,64}$'),
  canonical_name TEXT NOT NULL CHECK (length(btrim(canonical_name)) BETWEEN 1 AND 200),
  observed_on DATE NOT NULL,
  count INTEGER CHECK (count IS NULL OR count >= 0),
  locality TEXT NOT NULL CHECK (length(btrim(locality)) BETWEEN 1 AND 300),
  lat DOUBLE PRECISION CHECK (lat IS NULL OR (lat BETWEEN -90 AND 90)),
  lon DOUBLE PRECISION CHECK (lon IS NULL OR (lon BETWEEN -180 AND 180)),
  uncertainty_m INTEGER CHECK (uncertainty_m IS NULL OR uncertainty_m >= 0),
  generalized BOOLEAN NOT NULL,
  record_url TEXT NOT NULL CHECK (record_url ~ '^https://' AND length(record_url) <= 500),
  observer TEXT CHECK (observer IS NULL OR length(observer) <= 200),
  PRIMARY KEY (load_id, upstream_record_id),
  CHECK (place_key = region_code OR place_key LIKE region_code || ':%'),
  CHECK ((lat IS NULL) = (lon IS NULL))
);
CREATE TABLE external_stage_diagnostics (
  load_id UUID NOT NULL REFERENCES external_loads(id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL,
  code TEXT NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{0,63}$'),
  detail TEXT NOT NULL CHECK (length(detail) <= 300),
  count INTEGER NOT NULL CHECK (count >= 0),
  PRIMARY KEY (load_id, code, detail)
);

-- ── Published (swapped per (source, region) by a finished load) ────────────
CREATE TABLE external_places (
  source_id TEXT NOT NULL REFERENCES external_sources(id) ON DELETE CASCADE,
  region_code TEXT NOT NULL REFERENCES regions(code),
  place_key TEXT NOT NULL CHECK (length(place_key) <= 140),
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  level TEXT NOT NULL CHECK (level IN ('region', 'subregion')),
  parent_key TEXT,
  lat DOUBLE PRECISION CHECK (lat IS NULL OR (lat BETWEEN -90 AND 90)),
  lon DOUBLE PRECISION CHECK (lon IS NULL OR (lon BETWEEN -180 AND 180)),
  load_id UUID NOT NULL REFERENCES external_loads(id),
  PRIMARY KEY (source_id, place_key),
  FOREIGN KEY (source_id, parent_key) REFERENCES external_places (source_id, place_key)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (place_key = region_code OR place_key LIKE region_code || ':%'),
  CHECK ((level = 'region') = (place_key = region_code)),
  CHECK ((level = 'region') = (parent_key IS NULL)),
  CHECK (parent_key IS NULL OR parent_key = region_code),
  CHECK ((lat IS NULL) = (lon IS NULL))
);
CREATE INDEX external_places_region_idx ON external_places (source_id, region_code);

CREATE TABLE external_place_month_totals (
  source_id TEXT NOT NULL,
  region_code TEXT NOT NULL,
  place_key TEXT NOT NULL,
  month SMALLINT NOT NULL CHECK (month BETWEEN 1 AND 12),
  reports INTEGER NOT NULL CHECK (reports >= 0),
  unkeyed INTEGER NOT NULL CHECK (unkeyed >= 0),
  load_id UUID NOT NULL REFERENCES external_loads(id),
  PRIMARY KEY (source_id, place_key, month),
  FOREIGN KEY (source_id, place_key) REFERENCES external_places (source_id, place_key)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (place_key = region_code OR place_key LIKE region_code || ':%'),
  CHECK (unkeyed <= reports)
);
CREATE INDEX external_place_month_totals_region_idx ON external_place_month_totals (source_id, region_code);

-- Raw upstream taxa per place and month, kept so species rows can be rebuilt
-- after an override or a taxonomy change without fetching again [C-P1-4].
CREATE TABLE external_taxon_month (
  source_id TEXT NOT NULL,
  region_code TEXT NOT NULL,
  place_key TEXT NOT NULL,
  upstream_taxon_id TEXT NOT NULL,
  month SMALLINT NOT NULL CHECK (month BETWEEN 1 AND 12),
  canonical_name TEXT NOT NULL,
  raw_name TEXT NOT NULL,
  reports INTEGER NOT NULL CHECK (reports >= 0),
  load_id UUID NOT NULL REFERENCES external_loads(id),
  PRIMARY KEY (source_id, place_key, upstream_taxon_id, month),
  FOREIGN KEY (source_id, place_key) REFERENCES external_places (source_id, place_key)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (place_key = region_code OR place_key LIKE region_code || ':%')
);
CREATE INDEX external_taxon_month_region_idx ON external_taxon_month (source_id, region_code);
CREATE INDEX external_taxon_month_taxon_idx ON external_taxon_month (source_id, upstream_taxon_id);

-- Derived from external_taxon_month; several upstream taxa mapping to one
-- species code are SUMMED [C-P1-4].
CREATE TABLE external_place_month_species (
  source_id TEXT NOT NULL,
  region_code TEXT NOT NULL,
  place_key TEXT NOT NULL,
  species_code TEXT NOT NULL CHECK (species_code ~ '^[a-z0-9-]{2,16}$'),
  month SMALLINT NOT NULL CHECK (month BETWEEN 1 AND 12),
  reports INTEGER NOT NULL CHECK (reports >= 0),
  load_id UUID NOT NULL REFERENCES external_loads(id),
  PRIMARY KEY (source_id, place_key, species_code, month),
  FOREIGN KEY (source_id, place_key) REFERENCES external_places (source_id, place_key)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (place_key = region_code OR place_key LIKE region_code || ':%')
);
CREATE INDEX external_place_month_species_region_idx ON external_place_month_species (source_id, region_code);
CREATE INDEX external_place_month_species_species_idx ON external_place_month_species (species_code, source_id);

CREATE TABLE external_top_localities (
  source_id TEXT NOT NULL,
  region_code TEXT NOT NULL,
  place_key TEXT NOT NULL,
  rank SMALLINT NOT NULL CHECK (rank BETWEEN 1 AND 1000),
  locality TEXT NOT NULL,
  reports INTEGER NOT NULL CHECK (reports >= 0),
  lat DOUBLE PRECISION CHECK (lat IS NULL OR (lat BETWEEN -90 AND 90)),
  lon DOUBLE PRECISION CHECK (lon IS NULL OR (lon BETWEEN -180 AND 180)),
  uncertainty_m INTEGER CHECK (uncertainty_m IS NULL OR uncertainty_m >= 0),
  placement TEXT NOT NULL CHECK (placement IN ('pin', 'text')),
  load_id UUID NOT NULL REFERENCES external_loads(id),
  PRIMARY KEY (source_id, place_key, rank),
  FOREIGN KEY (source_id, place_key) REFERENCES external_places (source_id, place_key)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (place_key = region_code OR place_key LIKE region_code || ':%'),
  CHECK ((lat IS NULL) = (lon IS NULL)),
  CHECK (placement = 'text' OR lat IS NOT NULL)
);
CREATE INDEX external_top_localities_region_idx ON external_top_localities (source_id, region_code);

-- Keyed by region as well as record: the swap is per region, so a record a
-- later load places in a neighbouring region can never collide.
CREATE TABLE external_recent_reports (
  source_id TEXT NOT NULL,
  region_code TEXT NOT NULL,
  upstream_record_id TEXT NOT NULL,
  place_key TEXT NOT NULL,
  upstream_taxon_id TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  species_code TEXT CHECK (species_code IS NULL OR species_code ~ '^[a-z0-9-]{2,16}$'),
  observed_on DATE NOT NULL,
  count INTEGER CHECK (count IS NULL OR count >= 0),
  locality TEXT NOT NULL,
  lat DOUBLE PRECISION CHECK (lat IS NULL OR (lat BETWEEN -90 AND 90)),
  lon DOUBLE PRECISION CHECK (lon IS NULL OR (lon BETWEEN -180 AND 180)),
  uncertainty_m INTEGER CHECK (uncertainty_m IS NULL OR uncertainty_m >= 0),
  generalized BOOLEAN NOT NULL,
  record_url TEXT NOT NULL,
  observer TEXT,
  load_id UUID NOT NULL REFERENCES external_loads(id),
  PRIMARY KEY (source_id, region_code, upstream_record_id),
  FOREIGN KEY (source_id, place_key) REFERENCES external_places (source_id, place_key)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (place_key = region_code OR place_key LIKE region_code || ':%'),
  CHECK ((lat IS NULL) = (lon IS NULL))
);
CREATE INDEX external_recent_reports_species_idx ON external_recent_reports (species_code, source_id, observed_on DESC);
CREATE INDEX external_recent_reports_taxon_idx ON external_recent_reports (source_id, upstream_taxon_id);

-- Upstream taxa that matched no species, per region [C-P2-3].
CREATE TABLE external_unmatched (
  source_id TEXT NOT NULL,
  region_code TEXT NOT NULL,
  upstream_taxon_id TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('no_match', 'ambiguous', 'override_code_missing')),
  -- Summed over 12 months of int4 counts, so it can exceed int4.
  reports BIGINT NOT NULL CHECK (reports >= 0),
  load_id UUID NOT NULL REFERENCES external_loads(id),
  PRIMARY KEY (source_id, region_code, upstream_taxon_id)
);

-- Every connector note of a finished load, kept with the load (the load's
-- result holds exact per-code totals; nothing is dropped).
CREATE TABLE external_load_diagnostics (
  load_id UUID NOT NULL REFERENCES external_loads(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  detail TEXT NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 0),
  PRIMARY KEY (load_id, code, detail)
);

CREATE TABLE external_taxon_overrides (
  source_id TEXT NOT NULL REFERENCES external_sources(id) ON DELETE CASCADE,
  upstream_taxon_id TEXT NOT NULL CHECK (upstream_taxon_id ~ '^[A-Za-z0-9._:-]{1,64}$'),
  species_code TEXT NOT NULL CHECK (species_code ~ '^[a-z0-9-]{2,16}$'),
  canonical_name TEXT NOT NULL CHECK (length(btrim(canonical_name)) BETWEEN 1 AND 200),
  set_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  set_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, upstream_taxon_id)
);

-- ── First source: Artsobservasjoner via GBIF (Phase 0 findings) ────────────
INSERT INTO external_sources
  (id, name, publisher, license, license_url, citation, doi, attribution, record_semantics,
   homepage, region_link_template, covers_country, geo_scheme, window_months, store_observers, active)
VALUES
  ('artsobs-gbif',
   'Artsobservasjoner',
   'Norwegian Biodiversity Information Centre (Artsdatabanken)',
   'CC BY 4.0',
   'https://creativecommons.org/licenses/by/4.0/',
   'The Norwegian Biodiversity Information Centre, Hoem S. Norwegian Species Observation Service. Occurrence dataset https://doi.org/10.15468/zjbzel accessed via GBIF.org.',
   '10.15468/zjbzel',
   'Reports from Artsobservasjoner (Norwegian Biodiversity Information Centre), via GBIF.org, CC BY 4.0',
   'reports',
   'https://www.artsobservasjoner.no/',
   'https://www.gbif.org/occurrence/search?dataset_key=b124e1e0-4755-430f-9eab-894f25a9b59c&taxon_key=212&occurrence_status=present&gadm_gid={upstream_key}',
   'NO',
   'GBIF-GADM',
   24,
   false,
   true);

-- The 19 old counties (Phase 0 finding 4; names never drive this mapping).
INSERT INTO external_region_map (source_id, upstream_key, region_code) VALUES
  ('artsobs-gbif', 'NOR.1_1', 'NO-02'),
  ('artsobs-gbif', 'NOR.2_1', 'NO-01'),
  ('artsobs-gbif', 'NOR.3_1', 'NO-09'),
  ('artsobs-gbif', 'NOR.4_1', 'NO-06'),
  ('artsobs-gbif', 'NOR.5_1', 'NO-20'),
  ('artsobs-gbif', 'NOR.6_1', 'NO-04'),
  ('artsobs-gbif', 'NOR.7_1', 'NO-12'),
  ('artsobs-gbif', 'NOR.8_1', 'NO-15'),
  ('artsobs-gbif', 'NOR.9_1', 'NO-17'),
  ('artsobs-gbif', 'NOR.10_1', 'NO-18'),
  ('artsobs-gbif', 'NOR.11_1', 'NO-05'),
  ('artsobs-gbif', 'NOR.12_1', 'NO-03'),
  ('artsobs-gbif', 'NOR.13_1', 'NO-11'),
  ('artsobs-gbif', 'NOR.14_1', 'NO-14'),
  ('artsobs-gbif', 'NOR.15_1', 'NO-16'),
  ('artsobs-gbif', 'NOR.16_1', 'NO-08'),
  ('artsobs-gbif', 'NOR.17_1', 'NO-19'),
  ('artsobs-gbif', 'NOR.18_1', 'NO-10'),
  ('artsobs-gbif', 'NOR.19_1', 'NO-07');

-- 0002's default privileges grant birds_app SELECT/INSERT/UPDATE/DELETE on
-- these tables and the connector identity sequence. The app needs all four:
-- loads and staging are written by the ingest API, published rows are
-- swapped, and the registry/region map are written by tests' own fixtures
-- and by scripts/connector-token.mjs (connectors).

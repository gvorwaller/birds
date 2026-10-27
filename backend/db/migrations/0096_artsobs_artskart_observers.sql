-- External sightings sources, Phase 2 rev B (td-eec7db / td-c2913c).
-- Plan: docs/2026-10-21-external-sources-plan-CC.md, "Phase 2 rev B".
--
-- The Norway connector reads Artsobservasjoner through Artsdatabanken's
-- Artskart public API instead of GBIF, and the owner wants observer names
-- stored (2026-10-26). This adds:
--   - the source `artsobs` (store_observers on), mapped by Artskart's old
--     county numbers 1…20, which are exactly the app's NO-01…NO-20;
--   - the `observers` chunk kind: the most active observers per place,
--     staged and published like the other kinds;
-- and switches the GBIF source off (its rows, if any, are kept).

-- ── Observers chunk kind ────────────────────────────────────────────────────
ALTER TABLE external_load_chunks DROP CONSTRAINT external_load_chunks_kind_check;
ALTER TABLE external_load_chunks ADD CONSTRAINT external_load_chunks_kind_check
  CHECK (kind IN ('places', 'totals', 'taxon_month', 'localities', 'recent', 'diagnostics', 'observers'));

-- A "report" is one species at one place on one day, so the ranking leads
-- with days out; days, species and localities can never exceed reports.
CREATE TABLE external_stage_observers (
  load_id UUID NOT NULL REFERENCES external_loads(id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL,
  region_code TEXT NOT NULL,
  place_key TEXT NOT NULL CHECK (length(place_key) <= 140),
  rank SMALLINT NOT NULL CHECK (rank BETWEEN 1 AND 1000),
  observer TEXT NOT NULL CHECK (length(btrim(observer)) BETWEEN 1 AND 200),
  days INTEGER NOT NULL CHECK (days >= 1),
  species INTEGER NOT NULL CHECK (species >= 0),
  localities INTEGER NOT NULL CHECK (localities >= 0),
  reports INTEGER NOT NULL CHECK (reports >= 1),
  PRIMARY KEY (load_id, place_key, rank),
  UNIQUE (load_id, place_key, observer),
  CHECK (place_key = region_code OR place_key LIKE region_code || ':%'),
  CHECK (days <= reports AND species <= reports AND localities <= reports)
);

CREATE TABLE external_top_observers (
  source_id TEXT NOT NULL,
  region_code TEXT NOT NULL,
  place_key TEXT NOT NULL,
  rank SMALLINT NOT NULL CHECK (rank BETWEEN 1 AND 1000),
  observer TEXT NOT NULL,
  days INTEGER NOT NULL CHECK (days >= 1),
  species INTEGER NOT NULL CHECK (species >= 0),
  localities INTEGER NOT NULL CHECK (localities >= 0),
  reports INTEGER NOT NULL CHECK (reports >= 1),
  load_id UUID NOT NULL REFERENCES external_loads(id),
  PRIMARY KEY (source_id, place_key, rank),
  UNIQUE (source_id, place_key, observer),
  FOREIGN KEY (source_id, place_key) REFERENCES external_places (source_id, place_key)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (place_key = region_code OR place_key LIKE region_code || ':%'),
  CHECK (days <= reports AND species <= reports AND localities <= reports)
);
CREATE INDEX external_top_observers_region_idx ON external_top_observers (source_id, region_code);

-- ── Artsobservasjoner via Artskart ──────────────────────────────────────────
-- No DOI: the DOI 10.15468/zjbzel is GBIF's copy, which this source does not
-- read. No county link template yet; Phase 3 decides the link-out.
INSERT INTO external_sources
  (id, name, publisher, license, license_url, citation, doi, attribution, record_semantics,
   homepage, region_link_template, covers_country, geo_scheme, window_months, store_observers, active)
VALUES
  ('artsobs',
   'Artsobservasjoner',
   'Norwegian Biodiversity Information Centre (Artsdatabanken)',
   'CC BY 4.0',
   'https://creativecommons.org/licenses/by/4.0/',
   'Artsobservasjoner, the Norwegian Biodiversity Information Centre (Artsdatabanken). Bird reports read through the Artskart public API (artskart.artsdatabanken.no).',
   NULL,
   'Reports from Artsobservasjoner (Norwegian Biodiversity Information Centre), CC BY 4.0',
   'reports',
   'https://www.artsobservasjoner.no/',
   NULL,
   'NO',
   'Artskart counties (pre-2020)',
   24,
   true,
   true);

-- Artskart's old county numbers are the app's own (pre-2020) county codes.
INSERT INTO external_region_map (source_id, upstream_key, region_code) VALUES
  ('artsobs', '1', 'NO-01'),
  ('artsobs', '2', 'NO-02'),
  ('artsobs', '3', 'NO-03'),
  ('artsobs', '4', 'NO-04'),
  ('artsobs', '5', 'NO-05'),
  ('artsobs', '6', 'NO-06'),
  ('artsobs', '7', 'NO-07'),
  ('artsobs', '8', 'NO-08'),
  ('artsobs', '9', 'NO-09'),
  ('artsobs', '10', 'NO-10'),
  ('artsobs', '11', 'NO-11'),
  ('artsobs', '12', 'NO-12'),
  ('artsobs', '14', 'NO-14'),
  ('artsobs', '15', 'NO-15'),
  ('artsobs', '16', 'NO-16'),
  ('artsobs', '17', 'NO-17'),
  ('artsobs', '18', 'NO-18'),
  ('artsobs', '19', 'NO-19'),
  ('artsobs', '20', 'NO-20');

UPDATE external_sources SET active = false WHERE id = 'artsobs-gbif';

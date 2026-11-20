-- Sweden: Artportalen as an external sightings source (td-99eebf).
-- Plan: docs/2026-11-19-sweden-artportalen-plan-CC.md.
--
-- Adds, source-neutrally:
--   - external_sources.locale: the language a source's place, locality,
--     observer and local species names are written in, for sorting them
--     ('nb' Norwegian, 'sv' Swedish). Readers collate by it instead of a
--     hard-coded Norwegian order.
--   - external_sources.terms_url: a source whose terms ask the app to link
--     its usage rules where its data shows (SLU's API terms §2.1) gets that
--     link beside its attribution. Null for a source with no such ask.
--   - external_region_map.queueable: whether loads may be queued for the
--     region. A source's full county map is reference data; loading opens
--     county by county (plan [C1-6]). Every existing (Norway) row stays open.
-- and the source itself:
--   - `artportalen`: SLU Artdatabanken's Artportalen, read through the
--     Species Observation System API. Published dataset licence CC0 1.0
--     (GBIF dataset 38b4c89f). Observer names stored: the owner accepted the
--     GDPR controller role the API terms (§3.2) assign (2026-11-19).
--     12-month window (owner, 2026-11-19).
--   - its 21 län, keyed by SOS county featureId (the official län number),
--     ALL closed for loading (CODEX1 code review R1): an open region could be
--     queued by any signed-in user while the connector idles, and would run
--     the moment its secrets are installed. The owner opens Jönköpings län
--     (SE-F) and Stockholms län (SE-AB) in Admin → Sources at their rollout
--     steps.

ALTER TABLE external_sources
  ADD COLUMN locale TEXT NOT NULL DEFAULT 'en'
  CHECK (locale ~ '^[a-z]{2,3}(-[A-Z]{2})?$');
UPDATE external_sources SET locale = 'nb' WHERE covers_country = 'NO';

ALTER TABLE external_sources
  ADD COLUMN terms_url TEXT
  CHECK (terms_url IS NULL OR (terms_url ~ '^https://' AND length(terms_url) <= 500));

ALTER TABLE external_region_map
  ADD COLUMN queueable BOOLEAN NOT NULL DEFAULT true;

INSERT INTO external_sources
  (id, name, publisher, license, license_url, citation, doi, attribution, record_semantics,
   homepage, region_link_template, covers_country, geo_scheme, window_months, store_observers, active, locale, terms_url)
VALUES
  ('artportalen',
   'Artportalen',
   'SLU Swedish Species Information Centre (SLU Artdatabanken)',
   'CC0 1.0',
   'https://creativecommons.org/publicdomain/zero/1.0/',
   'Artportalen, SLU Swedish Species Information Centre (SLU Artdatabanken). Bird reports read through the Species Observation System API (api.artdatabanken.se).',
   NULL,
   'Data from SLU Artdatabanken (Artportalen)',
   'reports',
   'https://www.artportalen.se/',
   NULL,
   'SE',
   'Artportalen län (SOS County)',
   12,
   true,
   true,
   'sv',
   'https://www.slu.se/artdatabanken/rapportering-och-fynd/oppna-data-och-apier/api-villkor');

INSERT INTO external_region_map (source_id, upstream_key, region_code, queueable) VALUES
  ('artportalen', '1',  'SE-AB', false),
  ('artportalen', '3',  'SE-C',  false),
  ('artportalen', '4',  'SE-D',  false),
  ('artportalen', '5',  'SE-E',  false),
  ('artportalen', '6',  'SE-F',  false),
  ('artportalen', '7',  'SE-G',  false),
  ('artportalen', '8',  'SE-H',  false),
  ('artportalen', '9',  'SE-I',  false),
  ('artportalen', '10', 'SE-K',  false),
  ('artportalen', '12', 'SE-M',  false),
  ('artportalen', '13', 'SE-N',  false),
  ('artportalen', '14', 'SE-O',  false),
  ('artportalen', '17', 'SE-S',  false),
  ('artportalen', '18', 'SE-T',  false),
  ('artportalen', '19', 'SE-U',  false),
  ('artportalen', '20', 'SE-W',  false),
  ('artportalen', '21', 'SE-X',  false),
  ('artportalen', '22', 'SE-Y',  false),
  ('artportalen', '23', 'SE-Z',  false),
  ('artportalen', '24', 'SE-AC', false),
  ('artportalen', '25', 'SE-BD', false);

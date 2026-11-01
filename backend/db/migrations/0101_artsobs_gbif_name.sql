-- The switched-off GBIF route to Artsobservasjoner (0092, off since 0096)
-- shared its name with the live Artskart source `artsobs`, so Admin → Sources
-- showed two cards both called "Artsobservasjoner". The owner keeps it as a
-- fallback (2026-11-01); its name now says it is the GBIF one.

UPDATE external_sources SET name = 'Artsobservasjoner via GBIF' WHERE id = 'artsobs-gbif';

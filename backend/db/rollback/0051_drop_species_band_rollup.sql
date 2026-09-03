-- ROLLBACK for 0050_species_band_rollup.sql (td-8d3526). NOT AUTO-APPLIED.
--
-- This file lives OUTSIDE backend/db/migrations/ on purpose: migrate_pg.sh
-- applies every *.sql in that directory in sort order on every deploy, so a
-- drop migration parked there would run on the next deploy and destroy the
-- tables it exists to roll back. To roll back, move this file into
-- backend/db/migrations/ in the SAME commit that reverts the
-- rebuildBandRollup hook in src/lib/server/barchart.ts, and deploy with the
-- worker paused (spec rev 3 deploy notes; GROK gate pin 3, 2026-09-03).
--
-- No BEGIN/COMMIT: migrate_pg.sh wraps each file (see 0043 header).

DROP TABLE IF EXISTS species_band_month_freq;
DROP TABLE IF EXISTS band_month_samples;
DROP TABLE IF EXISTS band_locs;

-- Drop the region_centroids runtime cache (refactor plan Phase 6).
--
-- DELIBERATELY ITS OWN DEPLOY, after c3ad408 was confirmed live and healthy
-- on prod: deploy-to-DO.sh migrates BEFORE pm2 reloads, so shipping this in
-- the same deploy as the code that stopped reading the table would strand
-- the still-running old process against a missing relation for as long as a
-- failed deploy stayed broken.
--
-- Superseded by `regions` (0043/0044): the same coordinates, seeded offline
-- as static reference data instead of lazily fetched per request with TTLs,
-- cooldowns, negative caching and an in-flight dedup map. Nothing reads or
-- writes this table as of dbd3b23.
--
-- No rollback path is needed or meaningful: it held a CACHE, every row of
-- which was reconstructible from eBird by definition. If it were ever wanted
-- back, re-apply 0039-0041 as new files.
--
-- No BEGIN/COMMIT: migrate_pg.sh wraps each file (see 0043 header).

DROP TABLE IF EXISTS region_centroids;

-- migrate: no-transaction
-- Species-leading covering index on the monthly rollup (td-3bf3a2).
--
-- WHY. The species page's "Best time of year" teaser ranks every loaded
-- region for one species. It read the weekly species_frequency table, whose
-- PK leads with loc_code, so each species cost one probe per loaded region
-- (3,201 on prod) into scattered heap pages. Read-only EXPLAIN on prod,
-- 2026-09-26: American Kestrel 1,242 ms (4,456 pages read from disk), Great
-- Horned Owl 926 ms, Osprey 1,625 ms. The teaser was the dominant cost of
-- the species page. A MATERIALIZED CTE over species_frequency_species_idx
-- only reached 758 ms, because the heap rows are still scattered.
--
-- WHAT. The teaser now ranks regions from species_month_freq (num/n is the
-- same checklist-weighted monthly frequency) and reads weekly rows only for
-- the one or two regions it shows. This index lets that read be one
-- contiguous index-only range per species.
--
-- ALTERNATIVES MEASURED (production-sized birds_test, rolled back):
--   species_frequency (species_code) INCLUDE (loc_code, week, freq):
--     1,674 MB, 37 s build, 1,006 index pages for amekes. INCLUDE columns
--     turn off B-tree deduplication, so it is 3.4x the existing 498 MB
--     species_frequency_species_idx.
--   this index: 599 MB, 15 s build, 357 index pages for amekes; the whole
--     teaser query read 442 pages cold against ~4,500 before.
-- 0050 declined a species-leading index here because the ribbon alone did
-- not need one; the teaser does.
--
-- WRITE COST. storeFrequencies already replaces one location's rollup rows
-- per load; this adds one index to maintain on those rows. The production
-- table is roughly 1.4 GB, so this migration uses the migrate_pg.sh
-- non-transactional escape hatch and CREATE INDEX CONCURRENTLY: frequency
-- reads and writes continue during the build (apart from PostgreSQL's brief
-- start/end locks).
--
-- RERUN SAFETY. A failed concurrent build can leave an INVALID index, and the
-- schema_migrations record is necessarily separate. Dropping this owned index
-- first makes a retry rebuild it instead of accepting an invalid remnant.

SET maintenance_work_mem = '256MB';

DROP INDEX CONCURRENTLY IF EXISTS species_month_freq_species_idx;

CREATE INDEX CONCURRENTLY species_month_freq_species_idx
    ON species_month_freq (species_code) INCLUDE (loc_code, month, num);

RESET maintenance_work_mem;

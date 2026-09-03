-- Species band/continent rollup tables (td-59c2d0 TD-A, migration ribbon build
-- spec 2026-09-03 rev 2, td-8d3526).
--
-- WHY. The migration ribbon (plan item 1 of the spec) needs, per species, a
-- (10-degree latitude band × continent-or-NA-half × month) grid. Computing
-- that from species_month_freq / loc_month_samples (0049) at request time
-- means joining every loaded region's monthly rollup through `regions` and
-- summing on every page load: measured on the design record's rev 5
-- (docs/2026-09-02-migration-ribbon-plan.md), region-driven against that
-- rollup at 788 loaded subnational1 regions, this took 120 ms for Osprey and
-- 365 ms for Blackpoll Warbler — too slow for a species page that already
-- pays for the forecast teaser and eBird recent-observations calls, and
-- getting slower as coverage grows (world load is ~3,369 regions, ~4x the
-- index lookups). These tables precompute the band/country/month aggregate
-- once and are maintained incrementally (rebuildBandRollup, one country at a
-- time) the same way 0049 is: inside storeFrequencies' transaction, scoped
-- to the location(s) that changed, so the rollup can never drift from its
-- source.
--
-- WHAT. Three tables:
--   band_locs                membership: which frequency_fetch locations
--                             contribute to which (band, country, west) cell
--   band_month_samples       Σ(loc_month_samples.n) per (band, country, west, month)
--   species_band_month_freq  Σ(species_month_freq.num) per (band, country,
--                             west, month, species), plus `reached` — the
--                             count of member regions individually at or
--                             above the ribbon's 0.5% "present" threshold
--                             that month (PRESENT is baked in here so the
--                             ribbon's gap-month computation never has to
--                             re-read region-grain data)
-- Country grain, not location grain, per the owner's ruling (CC1 review of
-- the planner's spec): a country's contribution flips wholesale from its
-- country row to its subnational1 rows the moment the first state loads, so
-- the safe recompute unit is the whole country (see rebuildBandRollup in
-- barchart.ts).
--
-- WHY NOT A MATERIALIZED VIEW. Same reasoning as 0049: a matview would need
-- a full REFRESH over every band/country whenever any one location changes.
-- These are real tables maintained transactionally, scoped to the one
-- country that changed.
--
-- WHY NOT A species-leading index ON species_month_freq. That table is 0049's
-- existing rollup (loc_code, species_code, month) PK with a (month, loc_code)
-- index for the forecast's needs; adding a species-leading index there serves
-- only this feature and duplicates ~23.6M-source-row-derived data that these
-- new tables already hold at ribbon grain. Building the ribbon tables instead
-- keeps the per-request read down to three small SELECTs against a table
-- projected at roughly 1.8M rows at full world coverage (425,820 rows at 793
-- contributors, scaled to ~3,400; species density may make it lower), with no impact on 0049's existing index shape.
--
-- MEASURED (read-only EXPLAIN ANALYZE pre-flight against prod, 2026-09-03,
-- 788 loaded subnational1 regions + 5 country-only countries = 793 band_locs
-- rows): band_locs backfill negligible; band_month_samples backfill 0.20 s /
-- 996 rows; species_band_month_freq backfill 5.07 s / 425,820 rows. The
-- species_band_month_freq SELECT spilled to temp files under the cluster's
-- default 4MB work_mem, hence the SET LOCAL below (0049's "~364K" lesson:
-- record the ACTUAL count, not a guess — coverage is still growing, so the
-- deploy re-measures and this header is not re-edited after the fact).
--
-- `west` guard: eBird's centroid is unreliable for every region whose extent
-- crosses the antimeridian — it reports a longitude near 0 (US 0.31, US-AK
-- 0.31, NZ 0.12, NZ-NTL -2.02, FJ, FJ-E, FJ-N, AQ, RU-CHU, KI, UM) — and the
-- committed seed preserves eBird's CONVENTIONAL NEAR-GLOBAL ENVELOPE for
-- those regions (US-AK: min_lon -179.150558, max_lon 179.773408), NOT the
-- min_lon > max_lon wrap that 0047's note allows. Zero seeded rows use
-- min>max; twelve have an envelope wider than 180°. So the wrap test below
-- is (min_lon > max_lon OR max_lon - min_lon > 180), and lon_eff is the
-- midpoint of the complementary arc through 180° (US-AK -> -179.69). Only
-- SUBNATIONAL1 rows of US/CA/MX split at 100°W; a country row never does.
-- A naive `lon < -100` would have put Alaska in the EAST column (CODEX1
-- P1, 2026-09-03). td-57d9fc fixes the generator's centroid; this is the
-- guard until then.
--
-- Deleting a loaded region (CODEX1 P2-5): only band_locs cascades from
-- frequency_fetch (ON DELETE CASCADE below); band_month_samples and
-- species_band_month_freq do not, so a raw DELETE FROM frequency_fetch would
-- leave stale aggregates. deleteFrequencyLocation() in barchart.ts is the
-- only sanctioned delete path — it deletes inside withTransaction and then
-- rebuilds the owning country's band rollup.
--
-- No BEGIN/COMMIT: migrate_pg.sh wraps each file (see 0043 header).

-- The species_band_month_freq backfill SELECT below spills to temp files
-- under this cluster's default work_mem (4MB); scoped to this migration's
-- wrapper transaction only (SET LOCAL), never touches the cluster setting.
SET LOCAL work_mem = '256MB';

CREATE TABLE band_locs (
    band     SMALLINT NOT NULL CHECK (band BETWEEN -90 AND 80 AND band % 10 = 0),
    country  TEXT     NOT NULL REFERENCES regions(code),
    west     BOOLEAN  NOT NULL,            -- regions.lon < -100 (NA east/west split)
    loc_code TEXT     NOT NULL REFERENCES frequency_fetch(loc_code) ON DELETE CASCADE,
    PRIMARY KEY (band, country, west, loc_code)
);

CREATE TABLE band_month_samples (
    band    SMALLINT NOT NULL CHECK (band BETWEEN -90 AND 80 AND band % 10 = 0),
    country TEXT     NOT NULL REFERENCES regions(code),
    west    BOOLEAN  NOT NULL,
    month   SMALLINT NOT NULL CHECK (month BETWEEN 1 AND 12),
    n       DOUBLE PRECISION NOT NULL CHECK (n >= 0),   -- Σ loc_month_samples.n
    PRIMARY KEY (band, country, west, month)
);

CREATE TABLE species_band_month_freq (
    species_code TEXT     NOT NULL,
    band         SMALLINT NOT NULL CHECK (band BETWEEN -90 AND 80 AND band % 10 = 0),
    country      TEXT     NOT NULL REFERENCES regions(code),
    west         BOOLEAN  NOT NULL,
    month        SMALLINT NOT NULL CHECK (month BETWEEN 1 AND 12),
    num          DOUBLE PRECISION NOT NULL CHECK (num >= 0),  -- Σ species_month_freq.num
    reached      SMALLINT NOT NULL CHECK (reached >= 0),      -- regions with num/n >= 0.005
    PRIMARY KEY (species_code, band, country, west, month)
);
-- The per-country rebuild deletes by country; the PK is species-leading for
-- the page read, so without this the DELETE is a seq scan that grows with
-- coverage (~1.5M rows at world load). band_month_samples/band_locs are
-- small (≤60K rows at world load): PK only.
CREATE INDEX species_band_month_freq_country_idx ON species_band_month_freq (country);

GRANT SELECT, INSERT, UPDATE, DELETE ON band_locs, band_month_samples, species_band_month_freq TO birds_app;

-- Backfill (identical arithmetic to rebuildBandRollup in barchart.ts,
-- unparameterised). `JOIN regions r ON r.code = ff.loc_code` is the whole
-- source-row rule: counties (US-FL-001) and hotspots (L...) have no
-- `regions` row, so they never match — no regex needed. `regions` is
-- SELECT-able by birds_app (0043).
WITH sub1 AS (
  SELECT ff.loc_code, r.parent_code AS country,
         CASE WHEN r.min_lon IS NOT NULL AND (r.min_lon > r.max_lon OR r.max_lon - r.min_lon > 180)
              THEN ((r.min_lon + r.max_lon + 360) / 2 + 540)::numeric % 360 - 180
              ELSE r.lon END AS lon_eff,
         r.lat
    FROM frequency_fetch ff JOIN regions r ON r.code = ff.loc_code
   WHERE ff.loc_kind = 'region' AND r.level = 'subnational1'),
country_only AS (
  SELECT ff.loc_code, r.code AS country,
         CASE WHEN r.min_lon IS NOT NULL AND (r.min_lon > r.max_lon OR r.max_lon - r.min_lon > 180)
              THEN ((r.min_lon + r.max_lon + 360) / 2 + 540)::numeric % 360 - 180
              ELSE r.lon END AS lon_eff,
         r.lat
    FROM frequency_fetch ff JOIN regions r ON r.code = ff.loc_code
   WHERE ff.loc_kind = 'region' AND r.level = 'country'
     AND NOT EXISTS (SELECT 1 FROM sub1 s WHERE s.country = r.code)),
contrib AS (
  SELECT loc_code, country,
         GREATEST(-90, LEAST(80, floor(lat / 10) * 10))::smallint AS band,
         -- Only subnational1 rows of US/CA/MX split at 100W; a country row never does.
         (is_sub1 AND country IN ('US','CA','MX') AND lon_eff < -100) AS west
    FROM (SELECT loc_code, country, lon_eff, lat, TRUE  AS is_sub1 FROM sub1
          UNION ALL
          SELECT loc_code, country, lon_eff, lat, FALSE AS is_sub1 FROM country_only) u)
INSERT INTO band_locs (band, country, west, loc_code)
SELECT band, country, west, loc_code FROM contrib;

INSERT INTO band_month_samples (band, country, west, month, n)
SELECT bl.band, bl.country, bl.west, lms.month, SUM(lms.n)::float8
  FROM band_locs bl JOIN loc_month_samples lms ON lms.loc_code = bl.loc_code
 GROUP BY 1, 2, 3, 4;

INSERT INTO species_band_month_freq (species_code, band, country, west, month, num, reached)
SELECT smf.species_code, bl.band, bl.country, bl.west, smf.month,
       SUM(smf.num)::float8,
       COUNT(*) FILTER (WHERE lms.n > 0 AND smf.num / lms.n >= 0.005)::smallint
  FROM band_locs bl
  JOIN species_month_freq smf ON smf.loc_code = bl.loc_code
  JOIN loc_month_samples lms ON lms.loc_code = smf.loc_code AND lms.month = smf.month
 GROUP BY 1, 2, 3, 4, 5;

ANALYZE band_locs;
ANALYZE band_month_samples;
ANALYZE species_band_month_freq;

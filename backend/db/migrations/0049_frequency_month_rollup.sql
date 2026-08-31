-- Monthly rollups of the weekly barchart data (td-3bf3a2; Gaylon 2026-08-31:
-- "the forecast should return in 2-3 seconds max").
--
-- WHY. /forecast measured 7.3 s on prod, 7.0 s of it database, in 10 queries
-- (the Phase 1 perf line caught it: db=10/7042ms, zero eBird). The two heavy
-- shapes both recompute the SAME month aggregate on every request, over a
-- 2.9 GB / 23.6 M-row table, by unnesting each location's 48-element
-- sample_sizes array and joining it week-by-week. Measured in isolation on
-- prod: 620 ms and 935 ms. The indexes are used correctly — it is row volume
-- and repeated work, exactly what td-3bf3a2 predicted for this table.
--
-- WHAT. Two derived tables holding what those queries recompute:
--   species_month_freq  Σ(freq × n) per (loc, species, month)   — numerator
--   loc_month_samples   Σ(n)        per (loc, month)            — denominator
-- monthlyStat's contract is unchanged: freq = Σ(freqᵥ·nᵥ)/Σ(nᵥ) over the
-- month's four pseudo-weeks, with the denominator counting EVERY checklist
-- in the month including weeks the species was absent — which is why the
-- denominator is per (loc, month) and not per species.
--
-- Prototyped on prod before building: the county-ranking query drops from
-- 935 ms to 25.8 ms against these tables, returning the identical 13,168 rows.
--
-- WHY NOT A MATERIALIZED VIEW. A matview would need REFRESH over all 23.6 M
-- rows whenever any one location changes. These are real tables maintained
-- transactionally by storeFrequencies, which already replaces one location's
-- rows in a single transaction — so a rollup update is scoped to that same
-- location and can never drift from its source. (TimescaleDB continuous
-- aggregates, the auto-refreshing version, need a time-partitioned hypertable;
-- `week` here is a 1-48 eBird pseudo-week, not a timestamp, and the extension
-- is not installed on this cluster.)
--
-- Backfill runs in this migration: ~364 K rollup rows from 23.6 M source rows.
--
-- No BEGIN/COMMIT: migrate_pg.sh wraps each file (see 0043 header).

CREATE TABLE species_month_freq (
    loc_code     TEXT     NOT NULL REFERENCES frequency_fetch(loc_code) ON DELETE CASCADE,
    species_code TEXT     NOT NULL,
    month        SMALLINT NOT NULL CHECK (month BETWEEN 1 AND 12),
    -- Σ(freq × checklists) across the month's weeks. Not a frequency itself:
    -- divide by loc_month_samples.n for that.
    num          DOUBLE PRECISION NOT NULL CHECK (num >= 0),
    PRIMARY KEY (loc_code, species_code, month)
);

CREATE TABLE loc_month_samples (
    loc_code TEXT     NOT NULL REFERENCES frequency_fetch(loc_code) ON DELETE CASCADE,
    month    SMALLINT NOT NULL CHECK (month BETWEEN 1 AND 12),
    n        DOUBLE PRECISION NOT NULL CHECK (n >= 0),
    PRIMARY KEY (loc_code, month)
);

-- The forecast reads "all species at these locations in THIS month", so month
-- leads. (The PK already serves per-location lookups.)
CREATE INDEX species_month_freq_month_idx ON species_month_freq (month, loc_code);

GRANT SELECT, INSERT, UPDATE, DELETE ON species_month_freq TO birds_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON loc_month_samples TO birds_app;

-- Backfill from the existing weekly data. Identical arithmetic to the queries
-- being replaced, so the rollup is exact, not an approximation.
INSERT INTO species_month_freq (loc_code, species_code, month, num)
SELECT sf.loc_code, sf.species_code, ((sf.week - 1) / 4 + 1)::smallint,
       SUM(sf.freq * ss.n)::float8
  FROM species_frequency sf
  JOIN frequency_fetch ff ON ff.loc_code = sf.loc_code
  JOIN LATERAL unnest(ff.sample_sizes) WITH ORDINALITY AS ss(n, week)
    ON ss.week = sf.week
 GROUP BY 1, 2, 3;

INSERT INTO loc_month_samples (loc_code, month, n)
SELECT ff.loc_code, ((ss.week - 1) / 4 + 1)::smallint, SUM(ss.n)::float8
  FROM frequency_fetch ff,
       LATERAL unnest(ff.sample_sizes) WITH ORDINALITY AS ss(n, week)
 GROUP BY 1, 2;

ANALYZE species_month_freq;
ANALYZE loc_month_samples;

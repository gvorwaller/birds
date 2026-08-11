-- Multi-year species frequency data (td-854207 "Bird forecast by location and
-- month"), parsed from eBird's bar-chart export (barchartData TSV, fetched via
-- the credentialed web session — see src/lib/server/barchart.ts).
--
-- frequency_fetch: one row per successfully fetched region/hotspot. Weekly
-- checklist counts (the frequency denominators) live here because sample size
-- is a property of the location-week, not of any species.
--
-- species_frequency: sparse — only weeks where a species was reported
-- (freq > 0). An absent row means frequency 0 for that week.
--
-- frequency_fetch_attempts: bookkeeping for every fetch attempt, separate from
-- the data rows so a failed fetch stays distinguishable from "never loaded"
-- after redirects/reloads, and so permanently failing locations can be
-- excluded from resumable batch loops instead of blocking completion.

CREATE TABLE IF NOT EXISTS frequency_fetch (
    loc_code     TEXT PRIMARY KEY,          -- 'US-FL' | 'US-FL-057' | 'L123456'
    loc_kind     TEXT NOT NULL CHECK (loc_kind IN ('region', 'hotspot')),
    loc_name     TEXT NOT NULL,
    begin_year   SMALLINT NOT NULL,
    end_year     SMALLINT NOT NULL,         -- complete years only, never the partial current year
    sample_sizes INTEGER[] NOT NULL,        -- 48 weekly checklist counts (4 pseudo-weeks x 12 months)
    n_species    INTEGER NOT NULL CHECK (n_species >= 0),
    n_unmatched  INTEGER NOT NULL DEFAULT 0 CHECK (n_unmatched >= 0),
    unmatched_names TEXT[] NOT NULL DEFAULT '{}',  -- representative sample (<= 20), surfaced in UI
    fetched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (begin_year <= end_year),
    CHECK (cardinality(sample_sizes) = 48)
);

CREATE TABLE IF NOT EXISTS species_frequency (
    loc_code     TEXT NOT NULL REFERENCES frequency_fetch(loc_code) ON DELETE CASCADE,
    species_code TEXT NOT NULL,
    week         SMALLINT NOT NULL CHECK (week BETWEEN 1 AND 48),
    freq         DOUBLE PRECISION NOT NULL CHECK (freq > 0 AND freq <= 1),
    PRIMARY KEY (loc_code, species_code, week)
);

-- "This species across locations" (Mode B); the PK covers "all species at a location".
CREATE INDEX IF NOT EXISTS species_frequency_species_idx
    ON species_frequency (species_code, loc_code);

CREATE TABLE IF NOT EXISTS frequency_fetch_attempts (
    loc_code        TEXT PRIMARY KEY,
    last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status          TEXT NOT NULL CHECK (status IN ('ok', 'error')),
    error           TEXT
);

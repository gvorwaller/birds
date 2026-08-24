-- eBird's barchartData export occasionally reports a frequency above its
-- documented maximum of 1.0, especially for weeks with very small sample
-- sizes. The application stores the bounded value but preserves every source
-- correction here so the data-quality decision is explicit and reviewable.

CREATE TABLE IF NOT EXISTS frequency_anomalies (
    loc_code      TEXT NOT NULL REFERENCES frequency_fetch(loc_code) ON DELETE CASCADE,
    species_code  TEXT NOT NULL,
    week          SMALLINT NOT NULL CHECK (week BETWEEN 1 AND 48),
    original_freq DOUBLE PRECISION NOT NULL CHECK (original_freq > 1),
    stored_freq   DOUBLE PRECISION NOT NULL CHECK (stored_freq > 0 AND stored_freq <= 1),
    sample_size   INTEGER NOT NULL CHECK (sample_size >= 0),
    detected_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (loc_code, species_code, week)
);

CREATE INDEX IF NOT EXISTS frequency_anomalies_detected_idx
    ON frequency_anomalies (detected_at DESC);

-- Region centroids for proximity-aware region picks (Gaylon 2026-08-29:
-- with international regions loaded, the species page's "Best time of year"
-- teaser picked the globally most-findable region — often another country —
-- when the actionable answer is the best region NEAR HOME).
-- Source: eBird GET /ref/region/info/{code} latitude/longitude, fetched once
-- per region and cached forever (region centroids do not move).

BEGIN;

CREATE TABLE IF NOT EXISTS region_centroids (
    loc_code   TEXT PRIMARY KEY,        -- 'US-FL', 'NO-03', 'IS', ...
    lat        DOUBLE PRECISION NOT NULL,
    lon        DOUBLE PRECISION NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON region_centroids TO birds_app;

COMMIT;

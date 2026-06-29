-- Persistent metadata for eBird locations/hotspots. Google place IDs are kept
-- here so map links can open the actual Google place panel instead of a bare
-- coordinate pin, and so the data survives app restarts/deploys/reboots.

CREATE TABLE IF NOT EXISTS ebird_locations (
    loc_id TEXT PRIMARY KEY,
    loc_name TEXT NOT NULL,
    lat DOUBLE PRECISION NOT NULL,
    lng DOUBLE PRECISION NOT NULL,
    google_place_id TEXT,
    google_place_name TEXT,
    google_place_lat DOUBLE PRECISION,
    google_place_lng DOUBLE PRECISION,
    google_place_types TEXT[] NOT NULL DEFAULT '{}',
    google_place_distance_m DOUBLE PRECISION,
    google_place_name_score DOUBLE PRECISION,
    google_place_confidence DOUBLE PRECISION,
    google_place_status TEXT,
    google_place_checked_at TIMESTAMPTZ,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ebird_locations_google_place_missing_idx
    ON ebird_locations (google_place_checked_at, last_seen_at DESC)
    WHERE google_place_id IS NULL;

CREATE INDEX IF NOT EXISTS ebird_locations_name_idx
    ON ebird_locations (lower(loc_name));

-- Persist Google place IDs for first-party locations so Google Maps links can
-- open the actual place panel instead of a coordinate-only pin.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS home_google_place_id TEXT;

ALTER TABLE trip_stops
    ADD COLUMN IF NOT EXISTS google_place_id TEXT;

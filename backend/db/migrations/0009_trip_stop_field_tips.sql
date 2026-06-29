-- Persist AI-generated field tips per trip stop so reordering/rerouting does
-- not discard them and the app can show when the guidance was generated.

ALTER TABLE trip_stops
    ADD COLUMN IF NOT EXISTS field_tip TEXT,
    ADD COLUMN IF NOT EXISTS field_tip_generated_at TIMESTAMPTZ;

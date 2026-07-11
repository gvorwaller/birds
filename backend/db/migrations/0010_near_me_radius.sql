ALTER TABLE users
    ADD COLUMN IF NOT EXISTS near_me_radius_km INTEGER NOT NULL DEFAULT 40;

ALTER TABLE users
    ADD CONSTRAINT users_near_me_radius_km_range
    CHECK (near_me_radius_km BETWEEN 1 AND 50);

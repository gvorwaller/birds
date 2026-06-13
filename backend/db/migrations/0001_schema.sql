-- birds initial schema (V2 design: link-out gallery, credentialed eBird sync)

CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',
    home_lat DOUBLE PRECISION,
    home_lon DOUBLE PRECISION,
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

-- eBird credentials: API key + web-login credentials, all encrypted at rest
-- (AES-GCM, EBIRD_KEY_SECRET in .env). Never logged.
CREATE TABLE user_ebird (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    api_key_enc TEXT,
    login_username_enc TEXT,
    login_password_enc TEXT,
    life_list_synced_at TIMESTAMPTZ,
    life_list_status TEXT,
    life_list_error TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE seen_species (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    species_code TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual', -- 'ebird_sync' | 'csv_import' | 'manual'
    first_seen DATE,
    PRIMARY KEY (user_id, species_code)
);

CREATE TABLE taxonomy_cache (
    species_code TEXT PRIMARY KEY,
    com_name TEXT NOT NULL,
    sci_name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'species',
    family TEXT,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX taxonomy_com_idx ON taxonomy_cache (lower(com_name));
CREATE INDEX taxonomy_sci_idx ON taxonomy_cache (lower(sci_name));

-- Keyed by normalized source name (not photo id) so overrides survive
-- re-syncs and apply to future photos of the same species.
-- DEFERRABLE: taxonomy sync does delete+reinsert inside one transaction.
CREATE TABLE species_match_overrides (
    source_name TEXT PRIMARY KEY,
    species_code TEXT NOT NULL REFERENCES taxonomy_cache(species_code)
        DEFERRABLE INITIALLY DEFERRED,
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Link index of the gaylon.photos birds collection (link-out gallery).
CREATE TABLE photo_links (
    photo_id TEXT PRIMARY KEY,
    species_code TEXT,
    source_species TEXT NOT NULL,
    source_sci_name TEXT,
    url TEXT NOT NULL,
    thumbnail TEXT NOT NULL,
    page_url TEXT NOT NULL,
    taken_on DATE,
    lat DOUBLE PRECISION,
    lng DOUBLE PRECISION,
    match_method TEXT NOT NULL, -- 'override' | 'common' | 'scientific' | 'unmatched'
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX photo_links_species_idx ON photo_links(species_code);

-- Generic TTL cache for eBird API responses (recent obs, notable, geo).
CREATE TABLE ebird_cache (
    cache_key TEXT PRIMARY KEY,
    payload JSONB NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Trips (schema now; UI lands in Phase 2).
CREATE TABLE trips (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    start_date DATE,
    end_date DATE,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE trip_stops (
    id SERIAL PRIMARY KEY,
    trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    hotspot_id TEXT,
    custom_name TEXT,
    lat DOUBLE PRECISION,
    lon DOUBLE PRECISION,
    notes TEXT,
    target_count_at_save INTEGER
);
CREATE INDEX trip_stops_trip_idx ON trip_stops(trip_id);

-- Need alerts (plan: docs/2026-08-16-need-alerts-and-forecast-restore-plan.md).
-- New job type + per-user alert prefs + the per-(user,species) "have I ever
-- pinged you about this bird" memory. Grants via 0002 default privileges.

BEGIN;

-- New recurring job type. The CHECK is name-stable (added by 0015).
ALTER TABLE jobs DROP CONSTRAINT jobs_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_type_check CHECK (type IN
    ('load_hotspots','load_region','analyze_counties',
     'refresh_loc','retry_loc','sync_lifelist','sync_taxonomy',
     'scan_need_alerts'));

CREATE TABLE IF NOT EXISTS user_alert_prefs (
    user_id        INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    enabled        BOOLEAN NOT NULL DEFAULT FALSE,
    -- Encrypted with the EBIRD_KEY_SECRET envelope: a ntfy topic name IS the
    -- capability to send (and on the public server, read) the user's alerts.
    -- Same sacred handling as eBird credentials.
    ntfy_topic_enc TEXT,
    radius_km      INT NOT NULL DEFAULT 40 CHECK (radius_km BETWEEN 1 AND 50),
    realert_days   INT NOT NULL DEFAULT 7 CHECK (realert_days BETWEEN 1 AND 30),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (NOT enabled OR ntfy_topic_enc IS NOT NULL)
);

-- Intentionally NEVER pruned: one small row per (user, species) is the
-- rolling re-alert memory, updated in place. Audit fields record the
-- triggering observation of the most recent alert.
CREATE TABLE IF NOT EXISTS need_alerts_sent (
    user_id      INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    species_code TEXT NOT NULL,
    first_loc_id TEXT,
    first_obs_dt TEXT,
    sub_id       TEXT,
    sent_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, species_code)
);

COMMIT;

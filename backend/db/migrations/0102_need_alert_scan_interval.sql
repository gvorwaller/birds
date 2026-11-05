-- Need alerts: a per-account check interval (Gaylon 2026-11-05). The interval
-- was a fixed 30 minutes for everyone; each account now picks one in
-- Settings → Need alerts.
--
-- The single global scan job now runs every 15 minutes (the shortest choice).
-- On each run it checks only the accounts whose interval has come round since
-- last_scanned_at. The allowed values must match SCAN_INTERVAL_OPTIONS_MIN in
-- src/lib/need-alerts-policy.ts. Existing rows keep today's 30 minutes.

ALTER TABLE user_alert_prefs
    ADD COLUMN scan_interval_min INT NOT NULL DEFAULT 30
        CONSTRAINT user_alert_prefs_scan_interval_min_check
        CHECK (scan_interval_min IN (15, 30, 60, 120, 180, 360)),
    -- When the account's last check finished (its notable feed was read fresh
    -- and its candidates were sent). NULL = never, so the next run checks it.
    ADD COLUMN last_scanned_at TIMESTAMPTZ;

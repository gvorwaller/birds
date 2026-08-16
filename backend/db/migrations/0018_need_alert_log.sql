-- Alert history (Gaylon, 2026-08-16): a pushed notification vanishes once
-- dismissed on the phone — persist each alert as an in-app history the /alerts
-- page can show. Append-only, one row per alert actually delivered, storing
-- the title/body/url VERBATIM as pushed so the display can never disagree
-- with what the notification said (and the private-location wording is
-- preserved exactly — no location details are ever re-derived).
--
-- Distinct from need_alerts_sent, which stays the per-(user, species)
-- re-alert suppression memory updated in place.

BEGIN;

CREATE TABLE IF NOT EXISTS need_alert_log (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id      INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    species_code TEXT NOT NULL,
    title        TEXT NOT NULL,
    body         TEXT NOT NULL,
    url          TEXT NOT NULL,
    sent_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS need_alert_log_user_idx
    ON need_alert_log (user_id, sent_at DESC);

COMMIT;

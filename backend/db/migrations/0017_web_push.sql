-- Need alerts: ntfy → Web Push (Gaylon's channel change, 2026-08-16).
-- Notifications now come from the installed birds PWA itself; the topic
-- concept is gone. Enabling requires ≥1 enrolled device — enforced in the
-- action (a CHECK can't span tables).

BEGIN;

-- One row per enrolled browser/device push endpoint. The endpoint URL is a
-- capability (whoever holds it + the keys can push to that device) — never
-- log it, never surface it in errors/events.
CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint   TEXT PRIMARY KEY,
    user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_ok_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions (user_id);

ALTER TABLE user_alert_prefs DROP CONSTRAINT IF EXISTS user_alert_prefs_check;
ALTER TABLE user_alert_prefs DROP COLUMN IF EXISTS ntfy_topic_enc;

COMMIT;

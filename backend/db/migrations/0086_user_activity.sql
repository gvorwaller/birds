-- td-c8e6a3: per-account usage for Admin → Users. One row per account, UTC
-- day and app section, written the first time that account opens a page in
-- that section that day. Nothing about what was searched or viewed is kept —
-- only that the section was used. Personal to the signed-in account (users.id,
-- never the owner a viewer reads). No history before this release; the admin
-- view falls back to users.last_login_at for older activity.
CREATE TABLE user_activity_day (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  feature TEXT NOT NULL CHECK (feature ~ '^[a-z][a-z_]{1,30}$'),
  PRIMARY KEY (user_id, day, feature)
);
GRANT SELECT, INSERT, DELETE ON user_activity_day TO birds_app;

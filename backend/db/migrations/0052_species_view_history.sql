-- Personal browsing history is owned by the signed-in account, not its shared
-- life-list owner. No taxonomy FK: taxonomy sync deletes and repopulates that
-- table, and retired codes must retain their history.
ALTER TABLE users ADD COLUMN record_species_views BOOLEAN NOT NULL DEFAULT TRUE;
CREATE TABLE species_view_history (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  species_code TEXT NOT NULL,
  first_viewed_at TIMESTAMPTZ NOT NULL,
  last_viewed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, species_code),
  CHECK (first_viewed_at <= last_viewed_at)
);
CREATE INDEX species_view_history_recent_idx
  ON species_view_history (user_id, last_viewed_at DESC, species_code);
-- Small receipt ledger makes retries idempotent even after intervening visits
-- from another tab/device. Receipts disappear when the history is cleared.
CREATE TABLE species_view_receipts (
  user_id INTEGER NOT NULL,
  visit_id UUID NOT NULL,
  species_code TEXT NOT NULL,
  PRIMARY KEY (user_id, visit_id),
  FOREIGN KEY (user_id, species_code)
    REFERENCES species_view_history(user_id, species_code) ON DELETE CASCADE
);
GRANT SELECT, INSERT, UPDATE, DELETE ON species_view_history, species_view_receipts TO birds_app;

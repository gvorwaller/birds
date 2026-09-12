-- Personal intent belongs to the actual account, independently of shared lists.
-- No taxonomy FK: sync replaces taxonomy_cache and retired codes must survive.
CREATE TABLE species_special_interest (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  species_code TEXT NOT NULL,
  marked_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, species_code)
);
GRANT SELECT, INSERT, DELETE ON species_special_interest TO birds_app;

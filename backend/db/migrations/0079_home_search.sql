-- td-9304cd: Home reopens the account's last search area until "Reset home
-- defaults". Personal to the signed-in account (users.id, never the owner a
-- viewer reads). A NULL part means "the default": no place = the saved home,
-- no dist_km = the saved radius, no back_days = the default window.
CREATE TABLE home_search (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  place_label TEXT,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  dist_km INTEGER,
  back_days INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT home_search_place_whole CHECK (
    (place_label IS NULL) = (lat IS NULL) AND (lat IS NULL) = (lng IS NULL)
  ),
  CONSTRAINT home_search_lat_range CHECK (lat BETWEEN -90 AND 90),
  CONSTRAINT home_search_lng_range CHECK (lng BETWEEN -180 AND 180)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON home_search TO birds_app;

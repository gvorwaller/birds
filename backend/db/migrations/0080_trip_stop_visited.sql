-- td-40a1b5: check a trip stop off once you've been there (the ~/trips app's
-- day-plan "visited" checkbox). Trip state, not personal state: the owner and
-- the owner's viewers share one flag per stop. Existing stops start unvisited;
-- the column add is metadata-only (constant default), so no table rewrite.
ALTER TABLE trip_stops ADD COLUMN visited BOOLEAN NOT NULL DEFAULT FALSE;

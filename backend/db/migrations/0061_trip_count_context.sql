-- Preserve the executed planner scope alongside the compatible integer count.
-- Nullable with no backfill: historical/legacy stops remain explicitly unknown.
ALTER TABLE trip_stops
  ADD COLUMN planned_count_context JSONB;

-- Server health (td-7739c2): periodic memory samples from each app process,
-- so the admin page can show recent memory, restarts (a new started_at) and
-- each run's peak without SSH. Kept 7 days by the worker's prune job.
CREATE TABLE process_memory_samples (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  process TEXT NOT NULL CHECK (process IN ('web', 'worker')),
  pid INTEGER NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  sampled_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  rss_mb INTEGER NOT NULL,
  heap_used_mb INTEGER NOT NULL,
  heap_total_mb INTEGER NOT NULL,
  external_mb INTEGER NOT NULL,
  heap_limit_mb INTEGER NOT NULL
);
CREATE INDEX process_memory_samples_sampled_idx ON process_memory_samples (sampled_at);
GRANT SELECT, INSERT, DELETE ON process_memory_samples TO birds_app;
GRANT USAGE, SELECT ON SEQUENCE process_memory_samples_id_seq TO birds_app;

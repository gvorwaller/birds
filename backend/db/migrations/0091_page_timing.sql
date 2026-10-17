-- Performance panel (td-67b481): one row per web request slower than the
-- perf-log threshold (750 ms), written fire-and-forget when the response
-- body finishes, so Admin → Metrics can show what is slow and whether a
-- deploy made a page slower. Kept 30 days by the worker's prune job.
--
-- `route` is the SvelteKit route id ('/species/[code]'), never the URL: no
-- codes, IDs or query strings. The CHECK refuses anything shaped otherwise.
CREATE TABLE page_timing (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  route TEXT NOT NULL CHECK (route = '(none)' OR route ~ '^/[A-Za-z0-9_\[\]()/.=-]*$'),
  method TEXT NOT NULL CHECK (method IN ('GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS')),
  status SMALLINT NOT NULL,
  shell_ms INTEGER NOT NULL CHECK (shell_ms >= 0),
  total_ms INTEGER NOT NULL CHECK (total_ms >= 0),
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  tags INTEGER CHECK (tags IS NULL OR tags >= 0),
  db_n INTEGER NOT NULL, db_ms INTEGER NOT NULL,
  ebird_n INTEGER NOT NULL, ebird_ms INTEGER NOT NULL,
  google_n INTEGER NOT NULL, google_ms INTEGER NOT NULL,
  ai_n INTEGER NOT NULL, ai_ms INTEGER NOT NULL,
  rss_mb INTEGER NOT NULL,
  heap_mb INTEGER NOT NULL,
  version TEXT NOT NULL CHECK (version ~ '^[A-Za-z0-9._-]{1,64}$')
);
CREATE INDEX page_timing_at_idx ON page_timing (at);
-- 0002's default privileges grant birds_app SELECT/INSERT/UPDATE/DELETE;
-- it needs SELECT/INSERT (record, report) and DELETE (prune). Its identity
-- sequence is covered by the same defaults.
REVOKE UPDATE ON page_timing FROM birds_app;

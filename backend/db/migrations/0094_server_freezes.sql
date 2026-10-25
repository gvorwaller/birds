-- Server freezes (td-b07462, under td-c4a58d): each time the web process
-- stopped responding for a second or more (its event loop was blocked), with
-- what was running. Written fire-and-forget by src/lib/server/freeze-watch.ts,
-- shown in Admin → Metrics, kept 30 days by the worker's prune job.
--
-- `running_list` is a JSON array of {route, method, ranBeforeMs}, the oldest
-- MAX_LISTED requests already running when it began (SvelteKit route ids
-- only, never URLs); `running_before` counts all of them and `arrived_during`
-- the requests that started while it lasted. `busy` names heavy operations
-- that overlapped it.
CREATE TABLE server_freezes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL,
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  process TEXT NOT NULL CHECK (process IN ('web')),
  running_list JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(running_list) = 'array'),
  running_before INTEGER NOT NULL CHECK (running_before >= 0),
  arrived_during INTEGER NOT NULL CHECK (arrived_during >= 0),
  busy TEXT[] NOT NULL DEFAULT '{}',
  gc_ms INTEGER NOT NULL CHECK (gc_ms >= 0),
  rss_mb INTEGER NOT NULL,
  heap_mb INTEGER NOT NULL,
  version TEXT NOT NULL CHECK (version ~ '^[A-Za-z0-9._-]{1,64}$')
);
CREATE INDEX server_freezes_started_idx ON server_freezes (started_at);
-- 0002's default privileges grant birds_app SELECT/INSERT/UPDATE/DELETE;
-- it needs SELECT/INSERT (record, report) and DELETE (prune).
REVOKE UPDATE ON server_freezes FROM birds_app;

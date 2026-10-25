-- Stuck pages (td-1cb094, under td-c4a58d): the browser reports its own slow,
-- unfinished and frozen navigations, which the server cannot see (2026-10-25:
-- the phone hung after the server had answered). Written by POST
-- /api/client-stalls, shown in Admin → Metrics, kept 30 days by the worker's
-- prune job.
--
-- `from_route`/`to_route` are SvelteKit route ids; `to_path` is the pathname
-- only (no query string). `device` is the request's User-Agent, set by the
-- server, never by the body. `event_id` is the browser's id for the report,
-- so a report sent twice (two tabs flushing one queue) is stored once.
CREATE TABLE client_stalls (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id UUID NOT NULL UNIQUE,
  received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  occurred_at TIMESTAMPTZ NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('slow', 'superseded', 'unfinished', 'reloaded', 'lost', 'freeze')),
  from_route TEXT CHECK (from_route IS NULL OR from_route ~ '^/[A-Za-z0-9_\[\]()/.=-]*$'),
  to_route TEXT CHECK (to_route IS NULL OR to_route ~ '^/[A-Za-z0-9_\[\]()/.=-]*$'),
  to_path TEXT CHECK (to_path IS NULL OR (to_path ~ '^/[A-Za-z0-9_%./~-]*$' AND length(to_path) <= 200)),
  nav_type TEXT CHECK (nav_type IS NULL OR nav_type IN ('link', 'goto', 'popstate', 'form')),
  stage TEXT CHECK (stage IS NULL OR stage IN ('started', 'data', 'shown')),
  waited_ms INTEGER NOT NULL CHECK (waited_ms >= 0),
  data_ms INTEGER CHECK (data_ms IS NULL OR data_ms >= 0),
  alive_ms INTEGER CHECK (alive_ms IS NULL OR alive_ms >= 0),
  hidden_ms INTEGER CHECK (hidden_ms IS NULL OR hidden_ms >= 0),
  errors TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(errors) <= 3),
  standalone BOOLEAN NOT NULL,
  online BOOLEAN NOT NULL,
  device TEXT NOT NULL CHECK (length(device) <= 300),
  version TEXT NOT NULL CHECK (version ~ '^[A-Za-z0-9._-]{1,64}$')
);
CREATE INDEX client_stalls_occurred_idx ON client_stalls (occurred_at);
CREATE INDEX client_stalls_user_received_idx ON client_stalls (user_id, received_at);
-- 0002's default privileges grant birds_app SELECT/INSERT/UPDATE/DELETE;
-- it needs SELECT/INSERT (record, report) and DELETE (prune).
REVOKE UPDATE ON client_stalls FROM birds_app;

-- eBird traffic metric (td-009031): daily totals of eBird requests by
-- endpoint × origin × outcome, added up in memory by each app process and
-- flushed every minute (src/lib/server/ebird-traffic.ts). Kept 400 days by
-- the worker's prune job: a few thousand rows a year.
--
-- Privacy: the classifiers in ebird-traffic.ts are the allow-list (a fixed
-- endpoint name, never a path, query, key, region, location, species or
-- user; an origin of 'web', 'worker' or a job type). These CHECKs back them
-- up by refusing anything not shaped like such a name. Days are UTC dates.
CREATE TABLE ebird_traffic_daily (
  day DATE NOT NULL,
  endpoint TEXT NOT NULL CHECK (endpoint ~ '^[a-z]+(/[a-z]+)*$'),
  origin TEXT NOT NULL CHECK (origin ~ '^[a-z_]+$'),
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'not_found', 'http_error', 'rate_limited',
                                           'network_error', 'cache_hit', 'stale_fallback')),
  calls INTEGER NOT NULL CHECK (calls >= 0),
  total_ms BIGINT NOT NULL CHECK (total_ms >= 0),
  bytes BIGINT NOT NULL CHECK (bytes >= 0),
  PRIMARY KEY (day, endpoint, origin, outcome)
);
-- 0002's default privileges already grant SELECT/INSERT/UPDATE/DELETE to
-- birds_app; the app needs exactly those (flush, report, prune).

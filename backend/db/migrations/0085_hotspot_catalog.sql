-- td-79261e: the world hotspot catalog. The regions table already holds every
-- eBird country (252) and first-level region (3,369); the coordinate repair
-- (0084, td-c2f2b2) now loads every hotspot of every one of them into
-- ebird_locations as official coordinates, instead of only the regions that
-- held downloaded hotspots.
--
-- One row per catalog unit: a country, or — when eBird could not serve the
-- whole country in one response — each of its first-level regions (the
-- country row then says 'split').
--
--  * status      'ok' (list stored), 'split' (country fetched by its
--                children), 'error' (retried after a day)
--  * hotspots    how many hotspots the last 'ok' list held
--  * fetched_at  when that request started; 'ok' units refresh after 30 days
--  * error       the last failure, for Admin
--
-- Wrapped in one transaction by migrate_pg.sh. A new table only: no locks on
-- existing tables.
CREATE TABLE hotspot_catalog (
	region_code text PRIMARY KEY,
	status text NOT NULL CHECK (status IN ('ok', 'split', 'error')),
	hotspots integer NOT NULL DEFAULT 0 CHECK (hotspots >= 0),
	fetched_at timestamptz NOT NULL DEFAULT now(),
	error text,
	CHECK ((status = 'error') = (error IS NOT NULL))
);
REVOKE ALL ON hotspot_catalog FROM birds_app, PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON hotspot_catalog TO birds_app;

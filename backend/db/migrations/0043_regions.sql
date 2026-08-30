-- Region reference data (refactor plan,
-- docs/2026-08-30-regions-reference-data-refactor-plan.md, Phase 2).
--
-- Replaces the region_centroids runtime cache (0039-0041): region names,
-- coordinates, and country parentage are CONSTANTS, generated offline by
-- scripts/generate-regions.mjs from eBird's reference endpoints and seeded by
-- the 0044 migration. The app only ever SELECTs; seeds run as birds_owner via
-- migrate_pg.sh. region_centroids itself is dropped later (Phase 6), after
-- the code that reads it is gone from prod.
--
-- NOTE: no BEGIN/COMMIT here — migrate_pg.sh wraps each file and its
-- tracking INSERT in one transaction; a file-level COMMIT (as in 0039-0042)
-- ends that transaction early and the tracking INSERT runs in autocommit.

CREATE TABLE regions (
    code        TEXT PRIMARY KEY,
    name        TEXT NOT NULL CHECK (btrim(name) <> ''),
    level       TEXT NOT NULL CHECK (level IN ('country','subnational1')),
    parent_code TEXT REFERENCES regions(code),
    -- NOT NULL is the point: a region cannot exist here without coordinates.
    -- The range CHECKs also reject NaN for free — PG float8 comparisons make
    -- NaN fail every ordering test (verified live, documented in 0041).
    lat         DOUBLE PRECISION NOT NULL CHECK (lat BETWEEN -90 AND 90),
    lon         DOUBLE PRECISION NOT NULL CHECK (lon BETWEEN -180 AND 180),
    -- Upstream snapshot date; only changes when the row's data does.
    source_at   DATE NOT NULL,
    -- Same grammar as frequency_fetch.region_ref (0045) — kept identical by
    -- the generator's validation gate.
    CHECK (code ~ '^[A-Z]{2}(-[A-Z0-9]+)?$'),
    CHECK ((level = 'country') = (parent_code IS NULL))
);

-- Read-only for the app: this is static reference data (CODEX1 P2-3).
-- 0002's ALTER DEFAULT PRIVILEGES auto-grants full DML on every new table,
-- so read-only must be a REVOKE, not just a GRANT (verified on birds_test:
-- without this, has_table_privilege('birds_app','regions','INSERT') = t).
REVOKE ALL ON regions FROM birds_app;
GRANT SELECT ON regions TO birds_app;
-- No index beyond the PK: the accessor loads all ~4,250 rows once per
-- process and filters in memory; nothing queries by parent (td-3bf3a2's
-- rule — no reflexive indexes on tiny resident tables).

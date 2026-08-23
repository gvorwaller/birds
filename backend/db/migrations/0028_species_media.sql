-- Field-guide sample media (td-86a2b6): metadata-only photo/sound rows for
-- the species page. Binaries stay on Wikimedia Commons / xeno-canto — this
-- table stores URLs, dimensions, license, and attribution only (cs.md binary
-- policy). Plan: docs/2026-08-23-field-guide-sample-media-CLAUDE.md §2.

BEGIN;

-- 2a. Job type constraint: add enrich_species_media
ALTER TABLE jobs DROP CONSTRAINT jobs_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_type_check CHECK (type IN
    ('load_hotspots','load_region','analyze_counties',
     'refresh_loc','retry_loc','sync_lifelist','sync_taxonomy',
     'scan_need_alerts','enrich_species','scan_enrichment',
     'enrich_species_media'));

-- 2b. species_media: metadata-only, max ~3 rows per enriched species.
-- No FK to taxonomy_cache (same rationale as species_enrichment:
-- sync_taxonomy delete+reinserts must not FK-fail).
CREATE TABLE species_media (
    media_id          SERIAL PRIMARY KEY,
    species_code      TEXT NOT NULL,
    kind              TEXT NOT NULL,
    vocalization_type TEXT,
    rank              SMALLINT NOT NULL DEFAULT 1,
    provider          TEXT NOT NULL,
    provider_id       TEXT NOT NULL,
    media_url         TEXT NOT NULL,
    thumbnail_url     TEXT,
    source_url        TEXT NOT NULL,
    title             TEXT,
    creator           TEXT,
    license_code      TEXT NOT NULL,
    license_url       TEXT,
    location          TEXT,
    duration_seconds  REAL,
    width             INTEGER,
    height            INTEGER,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT species_media_kind_chk CHECK (kind IN ('photo', 'sound')),
    CONSTRAINT species_media_provider_chk CHECK (provider IN ('wikimedia_commons', 'xeno_canto')),
    CONSTRAINT species_media_uq UNIQUE (species_code, kind, rank)
);

-- No separate species_code index: the UNIQUE (species_code, kind, rank)
-- constraint's btree leads on species_code and serves every query
-- (WHERE species_code = $1 ORDER BY kind, rank) directly.

-- Grant access to birds_app (migration 0002's ALTER DEFAULT PRIVILEGES
-- covers new tables automatically; this is belt-and-braces).
GRANT SELECT ON species_media TO birds_app;
GRANT USAGE ON SEQUENCE species_media_media_id_seq TO birds_app;

-- 2c. Media-stage status columns on species_enrichment
ALTER TABLE species_enrichment
    ADD COLUMN media_status     TEXT CHECK (media_status IN ('ok','partial','no_media','error')),
    ADD COLUMN media_fetched_at TIMESTAMPTZ,
    ADD COLUMN media_ok_at      TIMESTAMPTZ,
    ADD COLUMN media_error      TEXT;

COMMIT;

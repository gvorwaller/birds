-- iNaturalist misidentification data for similar species (td-460b1c, Phase A).
-- Raw confused-with edges fetched from GET /v1/identifications/similar_species,
-- plus the sourcing stage's state columns on species_enrichment. The display
-- set (selected/resolved/origin) is reconciled in Phase B; its columns ship
-- here so Phase B needs no second edge-table migration.
-- Plan: docs/2026-08-27-similar-species-inat-plan.md.

BEGIN;

-- 1. Job type constraint: add enrich_species_inat (0028 precedent).
ALTER TABLE jobs DROP CONSTRAINT jobs_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_type_check CHECK (type IN
    ('load_hotspots','load_region','analyze_counties',
     'refresh_loc','retry_loc','sync_lifelist','sync_taxonomy',
     'scan_need_alerts','enrich_species','scan_enrichment',
     'enrich_species_media','enrich_species_inat'));

-- 2. Raw + reconciled edges. No FK to taxonomy_cache (sync_taxonomy
-- delete+reinserts wholesale, same rationale as species_enrichment 0020 and
-- species_similar 0031) and no FK to species_enrichment (edges can arrive for
-- a focal whose enrichment row is later rebuilt).
CREATE TABLE IF NOT EXISTS species_inat_similar (
    species_code   TEXT   NOT NULL,  -- focal eBird species
    inat_taxon_id  BIGINT NOT NULL,  -- confused-with iNat taxon (species-level
                                     -- via min_species_taxon_id where iNat
                                     -- provides it)
    rank           INT    NOT NULL,  -- 1-based by misid_count desc at fetch time
    misid_count    INT    NOT NULL,
    inat_sci_name  TEXT   NOT NULL,  -- iNat canonical binomial (post-collapse)
    inat_com_name  TEXT,             -- preferred_common_name; may be absent
    -- Phase-B reconcile output (display set). NULL/false until reconciled.
    selected       BOOLEAN NOT NULL DEFAULT FALSE,
    resolved_code  TEXT,             -- eBird code, resolved at reconcile time
    unresolved     BOOLEAN NOT NULL DEFAULT FALSE, -- floor-passing but unmappable
    origin         TEXT CHECK (origin IN ('forward','reverse')),
    -- Model's terminal per-pair "not confusable" verdict (self-review R2).
    -- Survives refetches: upsert preserves it, selection excludes it.
    declined_at    TIMESTAMPTZ,
    fetched_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (species_code, inat_taxon_id)
);

-- Reverse-current-source reciprocity + targeted invalidation (CODEX1 F1,
-- AGY A2/A3): both matching arms indexed.
CREATE INDEX IF NOT EXISTS species_inat_similar_taxon_idx
    ON species_inat_similar (inat_taxon_id);
CREATE INDEX IF NOT EXISTS species_inat_similar_sci_idx
    ON species_inat_similar (lower(inat_sci_name));

GRANT SELECT, INSERT, UPDATE, DELETE ON species_inat_similar TO birds_app;

-- 3. Sourcing-stage state on species_enrichment.
ALTER TABLE species_enrichment
    ADD COLUMN IF NOT EXISTS inat_taxon_id BIGINT,
    -- 'cross' = Wikidata P3151 via cross_ids; 'search' = /v1/taxa name search.
    -- Drives the P3151-removal one-shot re-verify (self-review R3).
    ADD COLUMN IF NOT EXISTS inat_taxon_source TEXT
        CHECK (inat_taxon_source IN ('cross','search')),
    -- Focal's iNat canonical binomial — namespace-correct sci-name matching
    -- for reverse/invalidation queries (self-review R4).
    ADD COLUMN IF NOT EXISTS inat_sci_name TEXT,
    ADD COLUMN IF NOT EXISTS inat_similar_status TEXT
        CHECK (inat_similar_status IN ('ok','none','no_mapping','error')),
    -- fetched_at restamps on ok/none/no_mapping (no_mapping restamps BOTH
    -- clocks — retry-loop precedent); attempted_at stamps on EVERY attempt.
    ADD COLUMN IF NOT EXISTS inat_similar_fetched_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS inat_similar_attempted_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS inat_similar_error TEXT,
    -- Phase-B two-tier reconcile short-circuit (self-review R9).
    ADD COLUMN IF NOT EXISTS inat_resolution_fingerprint TEXT;

CREATE INDEX IF NOT EXISTS species_enrichment_inat_similar_idx
    ON species_enrichment (inat_similar_status, inat_similar_attempted_at);

-- CODEX1 F2: indexed cross-id resolution arm. FULL expression index — a
-- partial index gated on `cross_ids ? '...'` cannot serve a plain ->> equality
-- join unless every query repeats the ? predicate.
CREATE INDEX IF NOT EXISTS species_enrichment_cross_inat_idx
    ON species_enrichment ((cross_ids->>'inat_taxon_id'));

COMMIT;

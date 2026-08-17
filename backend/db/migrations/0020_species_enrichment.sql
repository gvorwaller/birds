-- Species enrichment (plan: docs/2026-08-17-species-enrichment-plan.md,
-- dual-reviewed CODEX1+GROK, Gaylon-approved 2026-08-17).
-- Global per-species knowledge: Wikidata facts (CC0) + Wikipedia prose
-- (CC BY-SA 4.0, stored with revision identity for attribution) + later an
-- AI stage (Phase 2). One row per species — communal, like frequency data.

BEGIN;

-- New job types: enrich_species (bounded cancellable chunk worker) and
-- scan_enrichment (cheap recurring 24h singleton that only enqueues chunks).
ALTER TABLE jobs DROP CONSTRAINT jobs_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_type_check CHECK (type IN
    ('load_hotspots','load_region','analyze_counties',
     'refresh_loc','retry_loc','sync_lifelist','sync_taxonomy',
     'scan_need_alerts','enrich_species','scan_enrichment'));

-- Deliberately NO FK to taxonomy_cache: sync_taxonomy delete+reinserts the
-- whole table in one transaction, and a retired species code must never fail
-- that sync (seen_species / species_frequency precedent).
--
-- Stage-separated state (CODEX1): resolution (Wikidata), wiki_*, ai_* are
-- independent — a downstream failure must never clear or invalidate good
-- upstream data. Error writes stamp only *_status/*_error; last good
-- revision keeps serving.
CREATE TABLE IF NOT EXISTS species_enrichment (
    species_code       TEXT PRIMARY KEY,
    -- Wikidata stage (CC0)
    wikidata_qid       TEXT,
    resolution         TEXT CHECK (resolution IN ('mapped','no_mapping','no_sitelink')),
    iucn_status        TEXT,
    facts              JSONB NOT NULL DEFAULT '{}'::jsonb,
    cross_ids          JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Wikipedia stage (CC BY-SA 4.0; title/url/rev_id are the attribution record)
    wikipedia_title    TEXT,
    wikipedia_url      TEXT,
    wikipedia_rev_id   BIGINT,
    wikipedia_extract  TEXT,
    wikipedia_sections JSONB NOT NULL DEFAULT '[]'::jsonb,
    wiki_status        TEXT CHECK (wiki_status IN ('ok','no_article','error')),
    wiki_error         TEXT,
    -- Freshness clock for ALL wiki-stage states: stamped on every ATTEMPT,
    -- including no_article, so absent articles are not re-fetched daily.
    wiki_fetched_at    TIMESTAMPTZ,
    -- AI stage (Phase 2; columns present now so Phase 2 is data-only)
    field_craft        TEXT,
    tags               TEXT[] NOT NULL DEFAULT '{}',
    ai_model           TEXT,
    ai_generated_at    TIMESTAMPTZ,
    ai_source_rev_id   BIGINT,
    ai_status          TEXT CHECK (ai_status IN ('ok','error')),
    ai_error           TEXT,
    ai_attempted_at    TIMESTAMPTZ,
    -- Search: enrichment-owned text ONLY (tags/extract/field_craft/sections);
    -- names deliberately live outside so taxonomy renames can't go stale.
    search_tsv         tsvector,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS species_enrichment_tags_idx
    ON species_enrichment USING GIN (tags);
CREATE INDEX IF NOT EXISTS species_enrichment_tsv_idx
    ON species_enrichment USING GIN (search_tsv);
CREATE INDEX IF NOT EXISTS species_enrichment_wiki_idx
    ON species_enrichment (wiki_status, wiki_fetched_at);

COMMIT;

-- Similar species on field guide pages (td-8f0ed8).
-- Plan: docs/2026-08-25-similar-species-plan.md
--
-- The candidate EDGES are deliberately NOT stored. They are a pure function of
-- taxonomy_cache.sci_name (eBird "slash" taxa expanded to their members, plus
-- small same-genus groups) and are recomputed on each page load. Materialising
-- them would create a derived cache with no invalidation path: syncTaxonomy()
-- does DELETE FROM taxonomy_cache + reinsert in one transaction, nothing can FK
-- to it, and the first taxonomy revision that splits or merges a slash would
-- leave us rendering codes that no longer exist.
--
-- What IS stored is the AI-written distinguishing note, which carries model and
-- source-revision provenance and is genuinely not recomputable.

CREATE TABLE IF NOT EXISTS species_similar (
    -- The focal species: the page the note is written FOR and FROM.
    species_code     TEXT NOT NULL,
    -- The candidate the note is ABOUT.
    similar_code     TEXT NOT NULL,
    note             TEXT NOT NULL,
    -- Per-row provenance, so the table is self-describing when a LATER attempt
    -- has failed and these last-good rows are being preserved: species_enrichment
    -- then carries similar_status='error' while these rows still record the model
    -- and revision they were actually generated from.
    ai_model         TEXT NOT NULL,
    ai_source_rev_id BIGINT,
    generated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (species_code, similar_code),
    -- Self-reference is excluded by construction in the candidate builder; the
    -- constraint makes that guarantee schema-level and free.
    CHECK (species_code <> similar_code)
);

-- Notes are DIRECTIONAL and must never be mirrored: a note on Greater Scaup's
-- page is generated from Greater Scaup's article at Greater Scaup's revision,
-- while Lesser Scaup's comes from a different article at a different revision,
-- possibly months apart. They will not be converses of each other. The ordered
-- PK above is what enforces this; there is deliberately no reverse index.

-- No FK to taxonomy_cache, for the same reason species_enrichment has none
-- (see 0020): sync_taxonomy DELETEs and reinserts the whole table, and a
-- retired species code must not break it. The read path inner-joins
-- taxonomy_cache, so a note whose target has retired simply stops appearing.

-- Substage state for the note generator. Mirrors the wiki/ai/media staging
-- convention on this table: the ROWS live in their own table, the CLOCK lives
-- here. This substage needs its own clock because the existing aiDueCodes gate
-- (ai_status / ai_source_rev_id vs wikipedia_rev_id) cannot see two things that
-- make notes stale: (a) a schema/prompt change, which leaves every already-'ok'
-- row unreachable, and (b) a taxonomy re-sync that changes the candidate set
-- without touching wikipedia_rev_id.
ALTER TABLE species_enrichment
    ADD COLUMN IF NOT EXISTS similar_status TEXT
        CHECK (similar_status IN ('ok', 'none', 'error')),
    -- Hash of the candidate species codes the stored notes were generated for.
    -- Computed in the scanner (Node), not in SQL — expanding slash taxa in SQL
    -- for every in-scope species would be far more expensive than one in-memory
    -- pass over ~1.2k rows.
    ADD COLUMN IF NOT EXISTS similar_candidates_hash TEXT,
    -- These describe the last SUCCESSFUL generation, and are only advanced on
    -- success, so they always match the rows currently in species_similar.
    ADD COLUMN IF NOT EXISTS similar_source_rev_id BIGINT,
    ADD COLUMN IF NOT EXISTS similar_model TEXT,
    ADD COLUMN IF NOT EXISTS similar_generated_at TIMESTAMPTZ,
    -- Stamped on EVERY attempt, success or failure, so the error retry window
    -- cannot spin.
    ADD COLUMN IF NOT EXISTS similar_attempted_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS similar_error TEXT;

-- Partition scan for the note substage (mirrors species_enrichment_wiki_idx).
CREATE INDEX IF NOT EXISTS species_enrichment_similar_idx
    ON species_enrichment (similar_status, similar_attempted_at);

-- Tier 2 resolves same-genus candidates by the first token of sci_name;
-- taxonomy_cache has no genus column and only lower(com_name)/lower(sci_name)
-- indexes, so without this the genus lookup is a seq scan over ~17.9k rows.
CREATE INDEX IF NOT EXISTS taxonomy_genus_idx
    ON taxonomy_cache ((split_part(sci_name, ' ', 1)));

-- Migration 0002's ALTER DEFAULT PRIVILEGES already grants birds_owner-created
-- tables to birds_app; explicit here for the same belt-and-braces reason as
-- 0025 and 0028. DELETE and INSERT are load-bearing, not boilerplate: the note
-- writer replaces a focal species' whole note set inside one transaction.
GRANT SELECT, INSERT, UPDATE, DELETE ON species_similar TO birds_app;

-- Phase B of the iNaturalist similar-species migration (td-460b1c,
-- plan: docs/2026-08-27-similar-species-inat-plan.md).
--
-- The reconcile step (worker) resolves raw iNat edges to eBird codes, applies
-- selection, computes reverse-current-source support, and persists the result
-- here — the DISPLAY SET the species page reads with one indexed query
-- (AGY A1: no per-page-load graph traversal). Written transactionally with
-- species_enrichment.similar_candidates_hash so the page can never render a
-- candidate set that diverges from the stored notes.

BEGIN;

CREATE TABLE IF NOT EXISTS species_similar_display (
    species_code   TEXT   NOT NULL,   -- focal eBird species
    position       INT    NOT NULL,   -- render order (forward by count, then reverse)
    resolved_code  TEXT,              -- eBird code; NULL for unresolved entries
    inat_taxon_id  BIGINT,            -- raw source-edge taxon id (also populated for reverse rows)
    inat_sci_name  TEXT   NOT NULL,   -- iNat binomial (unresolved display + provenance)
    inat_com_name  TEXT,
    misid_count    INT,               -- NULL for reverse extras (count lives on the partner's edge)
    origin         TEXT   NOT NULL CHECK (origin IN ('forward','reverse')),
    unresolved     BOOLEAN NOT NULL DEFAULT FALSE,
    reconciled_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (species_code, position),
    CHECK (unresolved = (resolved_code IS NULL))
);
-- No FK to taxonomy_cache (sync_taxonomy delete+reinserts) and none to
-- species_inat_similar (reverse rows have no local raw edge).
GRANT SELECT, INSERT, UPDATE, DELETE ON species_similar_display TO birds_app;

-- The raw-edge display columns pre-provisioned in 0037 are superseded by this
-- table (fetch-owned vs reconcile-owned state must not share rows — the fetch
-- DELETE+diff would fight the reconciler). declined_at stays: it is fetch-
-- surviving per-pair state on the raw edge.
ALTER TABLE species_inat_similar
    DROP COLUMN IF EXISTS selected,
    DROP COLUMN IF EXISTS resolved_code,
    DROP COLUMN IF EXISTS unresolved,
    DROP COLUMN IF EXISTS origin;

-- Slash + genus tiers retired: their supporting indexes go with them.
DROP INDEX IF EXISTS taxonomy_genus_idx;          -- 0031 (genus tier)
DROP INDEX IF EXISTS taxonomy_slash_idx;          -- 0033 (slash tier)
DROP INDEX IF EXISTS species_similar_reverse_idx; -- 0032 (reciprocalNoteCodes, deleted per CODEX1 F1)

COMMIT;

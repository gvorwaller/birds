-- Partial index for the slash-taxon lookup (td-8f0ed8).
--
-- candidateSet() runs `WHERE category = 'slash' ORDER BY species_code` once per
-- species — on every field-guide page view AND once per species in the AI
-- annotation stage. Measured on prod before this index:
--
--   Seq Scan on taxonomy_cache
--     rows removed by filter: 16,856   buffers: shared hit=805   4.9 ms
--
-- i.e. 17,891 rows read to return 1,035, every time. Small in isolation, but it
-- is on the page-load path and it is what a post-taxonomy-sync re-queue of the
-- whole annotated corpus multiplies by ~1,400.
--
-- Partial rather than a plain index on `category`: slash rows are 6% of the
-- table, and indexing species_code within the predicate serves the ORDER BY as
-- well as the filter. taxonomy_cache is DELETE+reinserted wholesale by
-- syncTaxonomy, so index count matters there — this adds ~1,035 entries.
CREATE INDEX IF NOT EXISTS taxonomy_slash_idx
    ON taxonomy_cache (species_code)
    WHERE category = 'slash';

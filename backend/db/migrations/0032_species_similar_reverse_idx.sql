-- Reverse lookup on species_similar (td-8f0ed8).
--
-- The PK is (species_code, similar_code), so "which species already have a note
-- ABOUT this one" is a sequential scan. The AI stage now asks exactly that, to
-- make note COVERAGE symmetric: confusability is a mutual property even though
-- the note itself is directional, so if Belted Kingfisher has a note about
-- Ringed, Ringed is owed one about Belted.
--
-- Without this the annotation stage would scan species_similar once per species.
CREATE INDEX IF NOT EXISTS species_similar_reverse_idx
    ON species_similar (similar_code);

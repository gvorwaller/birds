-- A successful xeno-canto query may intentionally omit every download URL
-- when recordings for a species are restricted for conservation reasons.
-- Persist that stable, non-error condition independently from media_status so
-- the field guide can explain why no audio player is available without
-- retrying a deterministic provider policy.

ALTER TABLE species_enrichment
    ADD COLUMN media_audio_status TEXT
        CHECK (media_audio_status IN ('restricted'));

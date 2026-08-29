-- Tighten the region_centroids negative-outcome shape (GROK hostile review,
-- 2026-08-29). The 0040 CHECK (lat IS NULL OR retry_after IS NULL) allowed a
-- lat=NULL/retry_after=NULL "tombstone" row that the application code never
-- intentionally writes anymore (every negative outcome now carries a TTL —
-- 30 days durable, 1 day transient) but that the schema itself did nothing
-- to prevent. That state is silently treated as "never retry" by the
-- missing-code selector, which is exactly the permanent-negative-cache bug
-- this whole migration chain exists to close.
--
-- (GROK also flagged NaN coordinates as a theoretical hole in the existing
-- lat/lon range CHECKs. Verified against live Postgres, not just IEEE 754
-- reasoning: it isn't one. Postgres's float8 comparison operators treat NaN
-- as failing every `<`/`<=`/`>`/`>=` comparison — including against itself —
-- so 'NaN'::float8 already violates region_centroids_lat_range/lon_range on
-- its own; no extra constraint is needed or added here.)

BEGIN;

ALTER TABLE region_centroids
    DROP CONSTRAINT region_centroids_retry_shape,
    ADD CONSTRAINT region_centroids_retry_shape
        CHECK ((lat IS NULL) = (retry_after IS NOT NULL));

COMMIT;

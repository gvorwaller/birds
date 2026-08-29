-- Preserve negative and transient region-centroid outcomes. Without these
-- rows, the same retired/broken prefix consumes every bounded page-load fetch
-- allowance and later countries/regions never converge.

BEGIN;

ALTER TABLE region_centroids
    ALTER COLUMN lat DROP NOT NULL,
    ALTER COLUMN lon DROP NOT NULL,
    ADD COLUMN retry_after TIMESTAMPTZ,
    ADD CONSTRAINT region_centroids_coordinate_pair
        CHECK ((lat IS NULL) = (lon IS NULL)),
    ADD CONSTRAINT region_centroids_lat_range
        CHECK (lat IS NULL OR (lat >= -90 AND lat <= 90)),
    ADD CONSTRAINT region_centroids_lon_range
        CHECK (lon IS NULL OR (lon >= -180 AND lon <= 180)),
    ADD CONSTRAINT region_centroids_retry_shape
        CHECK (lat IS NULL OR retry_after IS NULL);

COMMIT;

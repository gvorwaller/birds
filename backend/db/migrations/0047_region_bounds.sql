-- Region bounding boxes (td-a4a3bf, P1).
--
-- WHY: a single centroid is a bad proxy for "how far is this region from me"
-- when the region is large or oddly shaped. Measured on prod 2026-08-31 with
-- a Jacksonville FL home: Great Black-backed Gull's "closest with sightings"
-- resolved to GEORGIA (centroid 191 mi) over FLORIDA (centroid 212 mi) —
-- because Jacksonville sits in Florida's far NE corner while the state's
-- centroid is 212 mi south down the peninsula. The user was standing INSIDE
-- the region that lost.
--
-- eBird's /ref/region/info returns `bounds` alongside the centroid, e.g.
-- US-FL {minX:-87.637231, maxX:-79.72264, minY:24.520417, maxY:31.00211},
-- which contains that home. Ranking by distance-to-bounds (0 when inside)
-- with centroid distance as the tiebreak fixes the whole class of error.
--
-- NULLABLE on purpose: eBird does not return usable bounds for every code
-- (the same population that has no usable centroid — see
-- backend/db/regions-excluded-codes.txt — plus any future gap). A row
-- without bounds degrades to centroid distance, which is honest; inventing
-- a box would not be (cs.md).
--
-- Populated by the 0048 delta from a full --refetch sweep; the columns land
-- empty and unused until then.
--
-- No BEGIN/COMMIT: migrate_pg.sh wraps each file (see 0043 header).

ALTER TABLE regions
    ADD COLUMN min_lat DOUBLE PRECISION,
    ADD COLUMN max_lat DOUBLE PRECISION,
    ADD COLUMN min_lon DOUBLE PRECISION,
    ADD COLUMN max_lon DOUBLE PRECISION,
    ADD CONSTRAINT regions_bounds_all_or_none CHECK (
        (min_lat IS NULL) = (max_lat IS NULL)
        AND (min_lat IS NULL) = (min_lon IS NULL)
        AND (min_lat IS NULL) = (max_lon IS NULL)
    ),
    ADD CONSTRAINT regions_bounds_lat_range CHECK (
        min_lat IS NULL OR (min_lat BETWEEN -90 AND 90 AND max_lat BETWEEN -90 AND 90)
    ),
    ADD CONSTRAINT regions_bounds_lon_range CHECK (
        min_lon IS NULL OR (min_lon BETWEEN -180 AND 180 AND max_lon BETWEEN -180 AND 180)
    ),
    ADD CONSTRAINT regions_bounds_ordered CHECK (
        min_lat IS NULL OR min_lat <= max_lat
    );
-- NOTE: no min_lon <= max_lon check — a box crossing the antimeridian
-- (Fiji, Chukotka, US-AK's Aleutians) legitimately has minX > maxX. The
-- distance code must handle that wrap rather than the schema forbidding it.

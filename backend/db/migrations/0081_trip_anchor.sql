-- td-0f3c63: a trip's start & end point (e.g. the hotel on a birding trip),
-- as the ~/trips app's day-plan anchor. The drawn route, its drive time and
-- distance, and Optimize order then loop anchor -> stops -> anchor instead of
-- starting at stop 1. A snapshot, not a link: source says how it was chosen
-- (a map place, one of the trip's stops, or the saved home); later changes to
-- that stop or home don't move it. All four parts or none.
ALTER TABLE trips
    ADD COLUMN anchor_source TEXT,
    ADD COLUMN anchor_label TEXT,
    ADD COLUMN anchor_lat DOUBLE PRECISION,
    ADD COLUMN anchor_lon DOUBLE PRECISION,
    ADD CONSTRAINT trips_anchor_whole CHECK (
        (anchor_source IS NULL AND anchor_label IS NULL
         AND anchor_lat IS NULL AND anchor_lon IS NULL)
        OR
        -- Explicit IS NOT NULLs: a NULL inside BETWEEN would make the whole
        -- CHECK NULL, which PostgreSQL treats as passing.
        (anchor_source IN ('place', 'stop', 'home')
         AND anchor_label IS NOT NULL AND btrim(anchor_label) <> ''
         AND anchor_lat IS NOT NULL AND anchor_lon IS NOT NULL
         AND anchor_lat BETWEEN -90 AND 90
         AND anchor_lon BETWEEN -180 AND 180)
    );

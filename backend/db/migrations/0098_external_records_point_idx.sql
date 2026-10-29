-- td-46fff6: "What can I see?" counts the reports within a radius of a point,
-- first cut by a longitude/latitude box. A GiST index on the point narrows by
-- both; the (lat, lon) btree walks the whole latitude band. Measured on
-- birds_test with real Nordland plus 2M points spread over Norway: 14 ms
-- against 17 ms for a 50 km box, index scan 1.6 ms against 4.5 ms.
-- point() and box are built in, so no extension is needed.
DROP INDEX IF EXISTS external_records_latlon_idx;
CREATE INDEX external_records_point_idx ON external_records USING gist (point(lon, lat)) WHERE lat IS NOT NULL;

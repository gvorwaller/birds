-- Rolls back 0085_hotspot_catalog.sql (td-79261e). Not auto-applied: move it
-- into migrations/ (renumbered to the next free number) in the same commit as
-- the code revert (the catalog stage of the coordinate repair). Coordinates
-- the catalog stored stay in ebird_locations: they are valid official eBird
-- hotspot coordinates.
DROP TABLE hotspot_catalog;

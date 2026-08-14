-- Nest hotspots under their county on /forecast/data (GBV 2026-08-14).
-- region_code now holds the MOST SPECIFIC containing region for a hotspot —
-- the county (US-FL-051) rather than the state (US-FL). eBird's hotspot
-- payloads carry subnational2Code; storeFrequencies records it going forward.
-- Backfill existing hotspot rows from the already-cached hotspot lists in
-- ebird_cache (truthful eBird data, no new requests). Rows whose county
-- never appears in any cached list keep their state code and display in a
-- state-level bucket until a future refresh records the county.

UPDATE frequency_fetch f
   SET region_code = sub.s2
  FROM (
    SELECT DISTINCT h->>'locId' AS loc_id, h->>'subnational2Code' AS s2
      FROM ebird_cache c, jsonb_array_elements(c.payload) h
     WHERE (c.cache_key LIKE 'hotspots:%' OR c.cache_key LIKE 'hotspotsRegion:%')
       AND h ? 'subnational2Code'
  ) sub
 WHERE f.loc_kind = 'hotspot'
   AND f.loc_code = sub.loc_id
   AND (f.region_code IS NULL OR f.region_code !~ '-[0-9]{3}$');

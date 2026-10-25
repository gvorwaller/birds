-- Hotspot search index (td-877997): rebuild only when the hotspot data it
-- uses changes, not when a cached list is merely refetched.
--
-- Hotspot list rows expire after 24 hours, and a refetch rewrote fetched_at
-- even when eBird sent the same hotspots, so the index's revision changed and
-- the next Hotspots & data search rebuilt ~186k hotspots (prod 10-24 22:31
-- EDT: the server stopped answering for ~12 s). Whole-payload comparison is
-- no use: every list entry carries latestObsDt / numSpeciesAllTime /
-- numChecklistsAllTime, which change daily.
--
-- For hotspot list and info rows, a trigger fingerprints only the fields the
-- index reads (hub-discovery.ts loadEvidence and parseOfficialHotspotInfo)
-- and moves content_changed_at only when that fingerprint changes. Other
-- cache rows are untouched (both columns stay NULL).
ALTER TABLE ebird_cache
  ADD COLUMN index_fingerprint TEXT,
  ADD COLUMN content_changed_at TIMESTAMPTZ;

CREATE FUNCTION ebird_cache_index_fingerprint() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.cache_key LIKE 'hotspots:%' OR NEW.cache_key LIKE 'hotspotsRegion:%' THEN
    SELECT md5(coalesce(string_agg(f, E'\x1e' ORDER BY f), ''))
      INTO NEW.index_fingerprint
      FROM (
        SELECT concat_ws(E'\x1f', h->>'locId', h->>'locName', h->>'lat', h->>'lng',
                         h->>'subnational1Code', h->>'subnational2Code', h->>'countryCode') AS f
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.payload) = 'array' THEN NEW.payload ELSE '[]'::jsonb END) h
      ) x;
  ELSIF NEW.cache_key LIKE 'hotspotInfo:%' THEN
    NEW.index_fingerprint := md5(concat_ws(E'\x1f',
      NEW.payload->>'locId', NEW.payload->>'locID', NEW.payload->>'isHotspot',
      NEW.payload->>'name', NEW.payload->>'locName',
      NEW.payload->>'latitude', NEW.payload->>'lat', NEW.payload->>'longitude', NEW.payload->>'lng',
      NEW.payload->>'subnational1Code', NEW.payload->>'stateCode',
      NEW.payload->>'subnational2Code', NEW.payload->>'countyCode'));
  ELSE
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.index_fingerprint IS NOT DISTINCT FROM OLD.index_fingerprint
     AND OLD.content_changed_at IS NOT NULL THEN
    NEW.content_changed_at := OLD.content_changed_at;
  ELSE
    NEW.content_changed_at := now();
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER ebird_cache_index_fingerprint
  BEFORE INSERT OR UPDATE OF payload ON ebird_cache
  FOR EACH ROW EXECUTE FUNCTION ebird_cache_index_fingerprint();

-- Backfill the existing hotspot rows: fingerprint them (the trigger), then
-- date the content to its last fetch.
UPDATE ebird_cache SET payload = payload
 WHERE cache_key LIKE 'hotspots:%' OR cache_key LIKE 'hotspotsRegion:%' OR cache_key LIKE 'hotspotInfo:%';
UPDATE ebird_cache SET content_changed_at = fetched_at
 WHERE cache_key LIKE 'hotspots:%' OR cache_key LIKE 'hotspotsRegion:%' OR cache_key LIKE 'hotspotInfo:%';

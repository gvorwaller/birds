import { query } from "$lib/db";
import { hotspotsNear } from "$server/ebird";

/**
 * Resolve saved eBird location ids from the existing hotspot reference cache
 * in one query. Observation caches and Google metadata are deliberately not
 * evidence of hotspot membership.
 */
export async function cachedVerifiedHotspotLocIds(
  ids: readonly string[],
): Promise<Set<string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Set();
  const result = await query<{ loc_id: string }>(
    `SELECT DISTINCT h->>'locId' AS loc_id
       FROM ebird_cache c
       CROSS JOIN LATERAL jsonb_array_elements(c.payload) AS h
      WHERE (c.cache_key LIKE 'hotspots:%' OR c.cache_key LIKE 'hotspotsRegion:%')
        AND h->>'locId' = ANY($1::text[])`,
    [unique],
  );
  return new Set(result.rows.map((row) => row.loc_id));
}

export async function verifiedHotspotLocIds(
  apiKey: string,
  lat: number,
  lng: number,
  distKm: number,
): Promise<{ locIds: Set<string>; stale: boolean }> {
  try {
    const hotspots = await hotspotsNear(apiKey, lat, lng, distKm);
    return {
      locIds: new Set(hotspots.data.map((h) => h.locId)),
      stale: hotspots.stale,
    };
  } catch {
    return { locIds: new Set(), stale: false };
  }
}

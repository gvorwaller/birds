import { hotspotsNear } from "$server/ebird";

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

import type { EbirdObs } from "$server/ebird";
import { haversineKm } from "$lib/geo";

export interface SpeciesObservationDetail extends EbirdObs {
  distanceKm: number | null;
  googlePlaceId: string | null;
  isHotspot: boolean;
}

function obsKey(o: EbirdObs): string {
  const loc = o.locId || `${o.lat.toFixed(5)},${o.lng.toFixed(5)}`;
  return `${o.speciesCode}|${loc}|${o.obsDt}`;
}

export function mergeSpeciesObservations(
  speciesCode: string,
  primary: EbirdObs[],
  secondary: EbirdObs[],
): EbirdObs[] {
  const merged: EbirdObs[] = [];
  const seen = new Set<string>();
  for (const o of [...primary, ...secondary]) {
    if (o.speciesCode !== speciesCode) continue;
    const key = obsKey(o);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(o);
  }
  return merged;
}

export function speciesObservationDetails(
  observations: EbirdObs[],
  home: { lat: number; lon: number } | null,
  locationPlaceIds: Map<string, string> = new Map(),
  hotspotLocIds: Set<string> = new Set(),
): SpeciesObservationDetail[] {
  return observations
    .map((o) => ({
      ...o,
      isHotspot: o.locId ? hotspotLocIds.has(o.locId) : false,
      distanceKm: home ? haversineKm(home.lat, home.lon, o.lat, o.lng) : null,
      googlePlaceId: o.locId ? (locationPlaceIds.get(o.locId) ?? null) : null,
    }))
    .sort((a, b) =>
      home
        ? (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9)
        : b.obsDt.localeCompare(a.obsDt),
    );
}

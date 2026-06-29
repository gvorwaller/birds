/** Great-circle distance in km between two lat/lng points (haversine). */
export function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function formatKm(km: number): string {
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

export interface MapPlace {
  name?: string | null;
  lat?: number | null;
  lng?: number | null;
  lon?: number | null;
  place_id?: string | null;
  google_place_id?: string | null;
}

function hasCoords(p: MapPlace): p is MapPlace & { lat: number } {
  return (
    typeof p.lat === "number" &&
    (typeof p.lng === "number" || typeof p.lon === "number")
  );
}

function lngOf(p: MapPlace & { lat: number }): number {
  return (typeof p.lng === "number" ? p.lng : p.lon) as number;
}

function coordStr(p: MapPlace & { lat: number }): string {
  return `${p.lat},${lngOf(p)}`;
}

function providerPlaceId(p: MapPlace): string | null {
  return p.google_place_id ?? p.place_id ?? null;
}

function searchToken(p: MapPlace): string {
  return p.name || (hasCoords(p) ? coordStr(p) : "place");
}

/** Miles → kilometers. Used to convert UI radius input at the boundary. */
export const MILES_TO_KM = 1.609344;
export function milesToKm(mi: number): number {
  return mi * MILES_TO_KM;
}

/**
 * Greedy nearest-neighbor ordering of points starting from `origin`, by
 * great-circle distance. Deterministic (stable for equal distances via input
 * order). Pure — no side effects — so the query engine and tests can use it
 * without a DB or Directions API. Returns a new array; `items` is not mutated.
 */
export function nearestNeighborOrder<T extends { lat: number; lng: number }>(
  origin: { lat: number; lng: number },
  items: T[],
): T[] {
  const remaining = [...items];
  const ordered: T[] = [];
  let curLat = origin.lat;
  let curLng = origin.lng;
  while (remaining.length) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversineKm(curLat, curLng, remaining[i].lat, remaining[i].lng);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    const next = remaining.splice(bestIdx, 1)[0];
    ordered.push(next);
    curLat = next.lat;
    curLng = next.lng;
  }
  return ordered;
}

/**
 * Google Maps universal deep-links for a coordinate. On phones these open the
 * Google Maps app; on desktop, maps.google.com. We use raw lat,lng (not the
 * place name) so the pin lands exactly on the reported spot.
 */
export function mapsPlaceUrl(lat: number, lng: number): string;
export function mapsPlaceUrl(place: MapPlace): string;
export function mapsPlaceUrl(
  placeOrLat: MapPlace | number,
  maybeLng?: number,
): string {
  const p: MapPlace =
    typeof placeOrLat === "number"
      ? { lat: placeOrLat, lng: maybeLng }
      : placeOrLat;
  const base = "https://www.google.com/maps/search/?api=1";
  const placeId = providerPlaceId(p);
  if (placeId) {
    return `${base}&query=${encodeURIComponent(searchToken(p))}&query_place_id=${encodeURIComponent(placeId)}`;
  }
  if (hasCoords(p)) return `${base}&query=${encodeURIComponent(coordStr(p))}`;
  return `${base}&query=${encodeURIComponent(searchToken(p))}`;
}

/** Directions TO the coordinate; Google fills in "from" using the device's location. */
export function mapsDirectionsUrl(lat: number, lng: number): string;
export function mapsDirectionsUrl(place: MapPlace): string;
export function mapsDirectionsUrl(
  placeOrLat: MapPlace | number,
  maybeLng?: number,
): string {
  const p: MapPlace =
    typeof placeOrLat === "number"
      ? { lat: placeOrLat, lng: maybeLng }
      : placeOrLat;
  const base = "https://www.google.com/maps/dir/?api=1";
  const placeId = providerPlaceId(p);
  if (placeId) {
    return `${base}&destination=${encodeURIComponent(searchToken(p))}&destination_place_id=${encodeURIComponent(placeId)}`;
  }
  if (hasCoords(p))
    return `${base}&destination=${encodeURIComponent(coordStr(p))}`;
  return `${base}&destination=${encodeURIComponent(searchToken(p))}`;
}

/**
 * Multi-stop driving directions through every point in order, starting from the
 * device's current location: all but the last point become ordered waypoints,
 * the last is the destination. Google's universal URL preserves waypoint order
 * (it does not re-optimize), so pass coordinates already in trip order. Returns
 * the single-destination URL for one point, and '' for none. Keep the list small
 * — Google's cross-platform URL caps waypoints (≈9).
 */
export function mapsRouteUrl(
  points: Array<{ lat: number; lng: number }>,
): string {
  if (points.length === 0) return "";
  if (points.length === 1)
    return mapsDirectionsUrl(points[0].lat, points[0].lng);
  const dest = points[points.length - 1];
  const waypoints = points
    .slice(0, -1)
    .map((p) => `${p.lat},${p.lng}`)
    .join("|");
  return `https://www.google.com/maps/dir/?api=1&destination=${dest.lat},${dest.lng}&waypoints=${waypoints}&travelmode=driving`;
}

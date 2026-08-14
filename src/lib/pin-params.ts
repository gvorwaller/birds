/**
 * Parse pinned-coordinate URL params (lat/lng/loc) shared by the Forecast
 * page loader and anything minting pin links.
 *
 * The regression this guards: `Number(null)` and `Number("")` are 0, so
 * naive parsing turned EVERY visit without pin params into lat/lng (0,0) —
 * which then outranked the saved home and "found" zero hotspots in the
 * Atlantic. Absent or empty params must yield NO pin.
 */
export interface Pin {
  lat: number;
  lng: number;
  label: string;
}

export function parsePin(
  latRaw: string | null,
  lngRaw: string | null,
  locRaw: string | null,
): Pin | null {
  if (latRaw == null || lngRaw == null) return null;
  if (latRaw.trim() === "" || lngRaw.trim() === "") return null;
  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const label = (locRaw ?? "").trim().slice(0, 120);
  return { lat, lng, label: label || `${lat.toFixed(3)}, ${lng.toFixed(3)}` };
}

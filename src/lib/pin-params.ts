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

/**
 * Home's map-picked search area (td-8e21b8). Choosing a point on the map
 * writes its label into the place box and submits the point's lat/lng plus
 * `pin`, the label as written. The pin applies only while the box still holds
 * exactly that label: once someone types a different place — with or without
 * JavaScript, or after opening a shared link — the text is geocoded as usual
 * and the leftover coordinates are ignored, so a new name never sits on top
 * of the old point.
 */
export function parsePlacePin(
  place: string,
  latRaw: string | null,
  lngRaw: string | null,
  pinRaw: string | null,
): Pin | null {
  const label = place.trim();
  if (!label || (pinRaw ?? "").trim() !== label) return null;
  const pin = parsePin(latRaw, lngRaw, label);
  // The label is the place text itself, kept whole: parsePin's length cap
  // would show a shortened name and resubmit it in place of the full one.
  return pin && { ...pin, label };
}

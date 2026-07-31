/**
 * Location context carried from the unified Home into the species drilldown.
 *
 * Home can be centered on the saved home *or* on any searched place. Before the
 * consolidation the species page always reloaded observations around the saved
 * home, so opening a bird found near a searched place showed reports from
 * somewhere else entirely. These helpers pass the selected origin along the
 * link and validate it on the way back in — an arbitrary URL must not push the
 * eBird geo radius past its 1–50 km boundary.
 */

/** eBird geo endpoints cap at 50 km; also the species page's historical radius. */
export const SPECIES_DEFAULT_DIST_KM = 50;
const MIN_DIST_KM = 1;
const MAX_DIST_KM = 50;
const MAX_LABEL_LEN = 120;

export interface SpeciesLocationContext {
  lat: number;
  lng: number;
  distKm: number;
  label: string | null;
}

function clampDistKm(raw: string | null): number {
  const n = Number(raw);
  if (raw == null || raw.trim() === "" || !Number.isFinite(n)) {
    return SPECIES_DEFAULT_DIST_KM;
  }
  return Math.min(MAX_DIST_KM, Math.max(MIN_DIST_KM, Math.round(n)));
}

/**
 * Read a validated origin from species-page query parameters, or `null` when
 * the caller did not supply usable coordinates (the loader then falls back to
 * the saved home, exactly as before).
 */
export function parseSpeciesLocationContext(
  params: URLSearchParams,
): SpeciesLocationContext | null {
  const rawLat = params.get("lat");
  const rawLng = params.get("lng");
  if (rawLat == null || rawLng == null) return null;

  const lat = Number(rawLat);
  const lng = Number(rawLng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;

  const label = (params.get("loc") ?? "").trim().slice(0, MAX_LABEL_LEN);
  return {
    lat,
    lng,
    distKm: clampDistKm(params.get("dist")),
    label: label || null,
  };
}

/** Coordinates to ~1 m, which is plenty for a search origin and keeps eBird cache keys stable. */
function coord(n: number): string {
  return String(Number(n.toFixed(5)));
}

/**
 * Build a species link that carries the report window, a safe return target,
 * and the origin currently shown on Home.
 */
export function speciesLinkHref(
  speciesCode: string,
  opts: {
    backDays: number;
    returnTo: string;
    context?: SpeciesLocationContext | null;
  },
): string {
  const params = new URLSearchParams();
  params.set("back", String(opts.backDays));
  params.set("returnTo", opts.returnTo);
  if (opts.context) {
    params.set("lat", coord(opts.context.lat));
    params.set("lng", coord(opts.context.lng));
    params.set("dist", String(opts.context.distKm));
    if (opts.context.label) params.set("loc", opts.context.label);
  }
  return `/species/${encodeURIComponent(speciesCode)}?${params.toString()}`;
}

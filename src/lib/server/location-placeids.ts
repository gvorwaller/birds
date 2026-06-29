import { env } from "$env/dynamic/private";
import { query } from "$lib/db";

export interface EbirdLocationRef {
  locId?: string | null;
  locName: string;
  lat: number;
  lng: number;
}

export interface EbirdLocationPlace {
  locId: string;
  locName: string;
  lat: number;
  lng: number;
  googlePlaceId: string | null;
}

export interface GooglePlaceCandidate {
  name: string;
  place_id: string;
  lat: number;
  lng: number;
  types: string[];
  distanceM: number;
  nameScore: number;
  confidence: number;
}

const DEFAULT_RADIUS_M = 2500;
const DEFAULT_MIN_CONFIDENCE = 0.7;
const RUNTIME_LOOKUP_LIMIT = 5;

function validLocation(loc: EbirdLocationRef): loc is EbirdLocationRef & {
  locId: string;
} {
  return (
    typeof loc.locId === "string" &&
    loc.locId.trim().length > 0 &&
    loc.locName.trim().length > 0 &&
    Number.isFinite(loc.lat) &&
    Number.isFinite(loc.lng)
  );
}

function uniqueLocations(locations: EbirdLocationRef[]): EbirdLocationPlace[] {
  const byId = new Map<string, EbirdLocationPlace>();
  for (const loc of locations) {
    if (!validLocation(loc)) continue;
    if (!byId.has(loc.locId)) {
      byId.set(loc.locId, {
        locId: loc.locId,
        locName: loc.locName,
        lat: loc.lat,
        lng: loc.lng,
        googlePlaceId: null,
      });
    }
  }
  return [...byId.values()];
}

export async function upsertEbirdLocations(
  locations: EbirdLocationRef[],
): Promise<void> {
  const unique = uniqueLocations(locations);
  if (unique.length === 0) return;

  const values: string[] = [];
  const params: unknown[] = [];
  unique.forEach((loc, i) => {
    const o = i * 4;
    values.push(`($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4})`);
    params.push(loc.locId, loc.locName, loc.lat, loc.lng);
  });

  await query(
    `INSERT INTO ebird_locations (loc_id, loc_name, lat, lng)
     VALUES ${values.join(", ")}
     ON CONFLICT (loc_id) DO UPDATE
       SET loc_name = EXCLUDED.loc_name,
           lat = EXCLUDED.lat,
           lng = EXCLUDED.lng,
           last_seen_at = NOW(),
           updated_at = NOW()`,
    params,
  );
}

export async function googlePlaceIdsForLocIds(
  locIds: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const ids = [...new Set(locIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return new Map();
  const r = await query<{ loc_id: string; google_place_id: string | null }>(
    `SELECT loc_id, google_place_id
       FROM ebird_locations
      WHERE loc_id = ANY($1) AND COALESCE(BTRIM(google_place_id), '') <> ''`,
    [ids],
  );
  return new Map(
    r.rows
      .filter((row) => row.google_place_id)
      .map((row) => [row.loc_id, row.google_place_id!]),
  );
}

function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(usa|us|united states|the|at|of|and)\b/g, " ")
    .replace(/\b[a-z]{2}-[a-z]{2}\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(s: string): string[] {
  return normalizeName(s)
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

export function placeNameScore(query: string, candidate: string): number {
  const q = tokens(query);
  const c = tokens(candidate);
  if (q.length === 0 || c.length === 0) return 0;
  const cSet = new Set(c);
  const exact = normalizeName(query) === normalizeName(candidate) ? 1 : 0;
  const overlap = q.filter(
    (t) => cSet.has(t) || c.some((ct) => ct.includes(t) || t.includes(ct)),
  ).length;
  const coverage = overlap / q.length;
  const reverse = overlap / c.length;
  return Math.max(exact, coverage * 0.75 + reverse * 0.25);
}

export function haversineMeters(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number {
  const r = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const lat1 = (aLat * Math.PI) / 180;
  const lat2 = (bLat * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * r * Math.asin(Math.sqrt(x));
}

function scoreCandidate(
  loc: EbirdLocationRef,
  candidate: Omit<
    GooglePlaceCandidate,
    "distanceM" | "nameScore" | "confidence"
  >,
  radiusM: number,
): GooglePlaceCandidate {
  const distanceM = haversineMeters(
    loc.lat,
    loc.lng,
    candidate.lat,
    candidate.lng,
  );
  const distanceScore = Math.max(0, 1 - distanceM / radiusM);
  const nameScore = placeNameScore(loc.locName, candidate.name);
  const confidence = Math.min(1, nameScore * 0.78 + distanceScore * 0.22);
  return { ...candidate, distanceM, nameScore, confidence };
}

interface GooglePlacesTextResponse {
  status: string;
  error_message?: string;
  results?: {
    name?: string;
    formatted_address?: string;
    place_id?: string;
    geometry?: { location?: { lat: number; lng: number } };
    types?: string[];
  }[];
}

async function googlePlacesTextSearch(
  apiKey: string,
  loc: EbirdLocationRef,
  radiusM: number,
): Promise<
  Array<Omit<GooglePlaceCandidate, "distanceM" | "nameScore" | "confidence">>
> {
  const url = new URL(
    "https://maps.googleapis.com/maps/api/place/textsearch/json",
  );
  url.searchParams.set("key", apiKey);
  url.searchParams.set("query", loc.locName);
  url.searchParams.set("location", `${loc.lat},${loc.lng}`);
  url.searchParams.set("radius", String(Math.round(radiusM)));

  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Google HTTP ${res.status}`);
  const data = (await res.json()) as GooglePlacesTextResponse;
  if (data.status === "ZERO_RESULTS") return [];
  if (data.status !== "OK") {
    throw new Error(`Text Search ${data.status}: ${data.error_message ?? ""}`);
  }
  return (data.results ?? [])
    .filter((r) => r.place_id && r.geometry?.location)
    .map((r) => ({
      name: r.name ?? r.formatted_address ?? loc.locName,
      place_id: r.place_id!,
      lat: r.geometry!.location!.lat,
      lng: r.geometry!.location!.lng,
      types: r.types ?? [],
    }));
}

export async function findGooglePlaceForEbirdLocation(
  loc: EbirdLocationRef,
  opts: { radiusM?: number; minConfidence?: number; apiKey?: string } = {},
): Promise<GooglePlaceCandidate | null> {
  if (!validLocation(loc)) return null;
  const apiKey =
    opts.apiKey ?? env.GOOGLE_GEOCODING_KEY ?? env.PUBLIC_GOOGLE_MAPS_API_KEY;
  if (!apiKey) return null;
  const radiusM = opts.radiusM ?? DEFAULT_RADIUS_M;
  const minConfidence = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;

  const candidates = await googlePlacesTextSearch(apiKey, loc, radiusM);
  const seen = new Set<string>();
  const scored = candidates
    .filter((candidate) => {
      if (seen.has(candidate.place_id)) return false;
      seen.add(candidate.place_id);
      return true;
    })
    .map((candidate) => scoreCandidate(loc, candidate, radiusM))
    .sort((a, b) => b.confidence - a.confidence || a.distanceM - b.distanceM);
  const best = scored[0] ?? null;
  if (!best || best.distanceM > radiusM || best.confidence < minConfidence) {
    return null;
  }
  return best;
}

async function setGooglePlaceResult(
  locId: string,
  candidate: GooglePlaceCandidate | null,
  status: string,
): Promise<void> {
  await query(
    `UPDATE ebird_locations
        SET google_place_id = $2,
            google_place_name = $3,
            google_place_lat = $4,
            google_place_lng = $5,
            google_place_types = $6,
            google_place_distance_m = $7,
            google_place_name_score = $8,
            google_place_confidence = $9,
            google_place_status = $10,
            google_place_checked_at = NOW(),
            updated_at = NOW()
      WHERE loc_id = $1`,
    [
      locId,
      candidate?.place_id ?? null,
      candidate?.name ?? null,
      candidate?.lat ?? null,
      candidate?.lng ?? null,
      candidate?.types ?? [],
      candidate?.distanceM ?? null,
      candidate?.nameScore ?? null,
      candidate?.confidence ?? null,
      status,
    ],
  );
}

async function locIdsDueForLookup(
  locIds: string[],
  limit: number,
): Promise<Set<string>> {
  if (locIds.length === 0 || limit <= 0) return new Set();
  const r = await query<{ loc_id: string }>(
    `SELECT loc_id
       FROM ebird_locations
      WHERE loc_id = ANY($1)
        AND COALESCE(BTRIM(google_place_id), '') = ''
        AND (
          google_place_checked_at IS NULL
          OR google_place_checked_at < NOW() - INTERVAL '30 days'
        )
      ORDER BY google_place_checked_at NULLS FIRST, last_seen_at DESC
      LIMIT $2`,
    [locIds, limit],
  );
  return new Set(r.rows.map((row) => row.loc_id));
}

async function resolveMissingGooglePlaceIds(
  locations: EbirdLocationPlace[],
  limit: number,
): Promise<void> {
  const due = await locIdsDueForLookup(
    locations.map((loc) => loc.locId),
    limit,
  );
  const missing = locations.filter(
    (loc) => !loc.googlePlaceId && due.has(loc.locId),
  );
  for (const loc of missing) {
    try {
      const candidate = await findGooglePlaceForEbirdLocation(loc);
      await setGooglePlaceResult(
        loc.locId,
        candidate,
        candidate ? "matched" : "no_confident_match",
      );
    } catch {
      await setGooglePlaceResult(loc.locId, null, "lookup_failed");
    }
  }
}

export async function hydrateEbirdLocationPlaceIds<T extends EbirdLocationRef>(
  locations: T[],
  opts: { resolveMissing?: boolean; lookupLimit?: number } = {},
): Promise<Map<string, string>> {
  const unique = uniqueLocations(locations);
  if (unique.length === 0) return new Map();
  await upsertEbirdLocations(unique);
  let placeIds = await googlePlaceIdsForLocIds(unique.map((loc) => loc.locId));
  if (opts.resolveMissing !== false) {
    const withKnown = unique.map((loc) => ({
      ...loc,
      googlePlaceId: placeIds.get(loc.locId) ?? null,
    }));
    await resolveMissingGooglePlaceIds(
      withKnown,
      opts.lookupLimit ?? RUNTIME_LOOKUP_LIMIT,
    );
    placeIds = await googlePlaceIdsForLocIds(unique.map((loc) => loc.locId));
  }
  return placeIds;
}

export function attachGooglePlaceIds<T extends EbirdLocationRef>(
  locations: T[],
  placeIds: Map<string, string>,
): Array<T & { googlePlaceId: string | null }> {
  return locations.map((loc) => ({
    ...loc,
    googlePlaceId: loc.locId ? (placeIds.get(loc.locId) ?? null) : null,
  }));
}

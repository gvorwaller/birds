/**
 * Hotspots & data geographic discovery service (Phase 8B, td-687b1c).
 *
 * One evidence union and one result shape serve the typed search, the map/radius
 * search, the page loader and `/api/hub-search`. It reads local database and
 * cache state only: no eBird request, no frequency fetch, no worker job, no
 * write of any kind.
 *
 * Truth rule (stricter than name matching):
 *  - countries and first-level regions are REFERENCE geography;
 *  - a county/equivalent is a RECORDED loaded region row;
 *  - a verified hotspot has affirmative eBird evidence: an exact loaded hotspot
 *    row, an ID in a cached official hotspot list, or a strict positive
 *    official hotspot-info entry;
 *  - anything else that surfaces (a failed hotspot load with no such evidence)
 *    is a reported location whose hotspot status is unverified and can never be
 *    promoted. `ebird_locations` alone is never evidence and is never indexed.
 */
import { error } from "@sveltejs/kit";
import { query } from "$lib/db";
import { haversineKm, MILES_TO_KM } from "$lib/geo";
import { isHotspotLocId } from "$lib/loc-id";
import { parentOf, parseRegionCode } from "$lib/region-code";
import { HUB_FIND_MIN, HUB_PAGE_SIZE, type HubDiscoveryState, type HubTarget } from "$lib/hub-discovery";
import { lastCompleteYear } from "$server/barchart";
import { countyMeta } from "$server/county-meta";
import { parseOfficialHotspotInfo } from "$server/hotspot-page";
import { allReferenceRegions } from "$server/regions";

export type HubResultType = "country" | "region" | "county" | "hotspot" | "reported";
export type HubLoadState =
  | "current"
  | "outdated"
  | "available-not-loaded"
  | "failed"
  | "unverified";

export interface HubResult {
  /** Canonical region code or exact eBird location ID. */
  id: string;
  type: HubResultType;
  name: string;
  /** Parent context: the containing county/region/country names. */
  context: string;
  /** What establishes this identity; never inferred from a name. */
  evidence: string[];
  loadState: HubLoadState;
  row: { beginYear: number; endYear: number; nSpecies: number } | null;
  /** Loaded rows recorded beneath a country/region (0 for other types). */
  loadedBeneath: number;
  lat: number | null;
  lng: number | null;
  distanceMiles: number | null;
  error: string | null;
  target: HubTarget;
  /** For a loaded hotspot: its loaded county, so the species count can open
   * the Field Guide list for it (td-c52c37). Null when there isn't one. */
  guideCounty?: string | null;
}

export interface HubSummaryArea {
  code: string;
  name: string;
  type: "country" | "region" | "county";
  hotspots: number;
  target: HubTarget;
}

export interface HubDiscovery {
  mode: "typed" | "map";
  /** The normalized (trimmed, whitespace-collapsed) query used to search and to build URLs. */
  find: string | null;
  /** The text as submitted, for display; equals `find` when nothing was normalized away. */
  submitted: string | null;
  /** A typed search below the minimum length answers nothing rather than everything. */
  tooShort: boolean;
  map: {
    place: string;
    lat: number;
    lng: number;
    dist: number;
    /** Verified hotspots with usable coordinates that were measured. */
    evaluated: number;
    /** Locally known verified hotspots without coordinates: could not be measured. */
    unevaluable: number;
  } | null;
  total: number;
  counts: Record<HubResultType, number>;
  page: number;
  pageSize: number;
  pageCount: number;
  /** 1-based index range of this page ([0, 0] when empty). */
  first: number;
  last: number;
  results: HubResult[];
  /** "Areas represented by nearby verified hotspots" — never a containment claim. */
  summary: { countries: HubSummaryArea[]; regions: HubSummaryArea[]; counties: HubSummaryArea[] } | null;
}

interface LoadedRow {
  loc_code: string;
  loc_kind: "region" | "hotspot";
  loc_name: string;
  region_code: string | null;
  begin_year: number;
  end_year: number;
  n_species: number;
}

interface AttemptRow {
  loc_code: string;
  loc_kind: "region" | "hotspot" | null;
  loc_name: string | null;
  region_code: string | null;
  error: string | null;
}

interface HotspotEvidence {
  id: string;
  name: string | null;
  lat: number | null;
  lng: number | null;
  county: string | null;
  state: string | null;
  country: string | null;
  sources: Set<"loaded" | "list" | "info">;
}

const finite = (v: unknown, min: number, max: number): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null;

const ASCII_ONLY = /^[\x00-\x7f]*$/;

/** Lower-case, accent-insensitive, whitespace-collapsed text for matching only. */
function fold(text: string): string {
  // Most names are plain ASCII: skip Unicode normalization when it cannot matter.
  const base = ASCII_ONLY.test(text)
    ? text
    : text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return base.toLowerCase().replace(/\s+/g, " ").trim();
}

/** The code and each ancestor, deepest first ("US-FL-115" → US-FL-115, US-FL, US). */
function chain(code: string | null | undefined): string[] {
  const out: string[] = [];
  let current = code ?? null;
  while (current && parseRegionCode(current)) {
    out.push(current);
    current = parentOf(current);
  }
  return out;
}

async function loadEvidence() {
  const [loadedRes, attemptRes, listRes, infoRes, coordRes, reference] = await Promise.all([
    query<LoadedRow>(
      `SELECT loc_code, loc_kind, loc_name, region_code, begin_year, end_year, n_species
         FROM frequency_fetch`,
    ),
    query<AttemptRow>(
      `SELECT a.loc_code, a.loc_kind, a.loc_name, a.region_code, a.error
         FROM frequency_fetch_attempts a
        WHERE a.status = 'error'
          AND NOT EXISTS (SELECT 1 FROM frequency_fetch f WHERE f.loc_code = a.loc_code)`,
    ),
    // Official hotspot lists only (regional and point-radius). The newest copy of
    // an ID wins; entries carry their own official ancestry codes.
    query<{
      loc_id: string;
      loc_name: string | null;
      lat: number | null;
      lng: number | null;
      s1: string | null;
      s2: string | null;
      cc: string | null;
    }>(
      `SELECT DISTINCT ON (x.loc_id) x.loc_id, x.loc_name, x.lat, x.lng, x.s1, x.s2, x.cc
         FROM (
           SELECT h->>'locId' AS loc_id, h->>'locName' AS loc_name,
                  CASE WHEN jsonb_typeof(h->'lat') = 'number' THEN (h->>'lat')::float8 END AS lat,
                  CASE WHEN jsonb_typeof(h->'lng') = 'number' THEN (h->>'lng')::float8 END AS lng,
                  h->>'subnational1Code' AS s1, h->>'subnational2Code' AS s2,
                  h->>'countryCode' AS cc, c.fetched_at
             FROM ebird_cache c
            CROSS JOIN LATERAL jsonb_array_elements(
                   CASE WHEN jsonb_typeof(c.payload) = 'array' THEN c.payload ELSE '[]'::jsonb END) h
            WHERE (c.cache_key LIKE 'hotspots:%' OR c.cache_key LIKE 'hotspotsRegion:%')
              AND jsonb_typeof(h) = 'object'
              AND h->>'locId' ~ '^L[0-9]+$'
         ) x
        ORDER BY x.loc_id, x.fetched_at DESC`,
    ),
    query<{ cache_key: string; payload: unknown }>(
      `SELECT cache_key, payload FROM ebird_cache WHERE cache_key LIKE 'hotspotInfo:%'`,
    ),
    // Coordinates of hotspots that are ALREADY established by a loaded row; the
    // same-ID location row supplies coordinates, never identity.
    query<{ loc_id: string; lat: number; lng: number }>(
      `SELECT e.loc_id, e.lat, e.lng
         FROM ebird_locations e
        WHERE EXISTS (SELECT 1 FROM frequency_fetch f
                       WHERE f.loc_code = e.loc_id AND f.loc_kind = 'hotspot')`,
    ),
    allReferenceRegions(),
  ]);

  const loaded = new Map<string, LoadedRow>(loadedRes.rows.map((r) => [r.loc_code, r]));
  const attempts = new Map<string, AttemptRow>(attemptRes.rows.map((r) => [r.loc_code, r]));
  const refByCode = new Map(reference.map((r) => [r.code, r]));

  // Verified hotspot union, deduplicated by exact eBird location ID.
  const hotspots = new Map<string, HotspotEvidence>();
  const ensure = (id: string): HotspotEvidence => {
    let h = hotspots.get(id);
    if (!h) {
      h = { id, name: null, lat: null, lng: null, county: null, state: null, country: null, sources: new Set() };
      hotspots.set(id, h);
    }
    return h;
  };
  for (const x of listRes.rows) {
    const h = ensure(x.loc_id);
    h.sources.add("list");
    h.name = x.loc_name?.trim() || h.name;
    h.lat = finite(x.lat, -90, 90);
    h.lng = finite(x.lng, -180, 180);
    if (h.lat == null || h.lng == null) h.lat = h.lng = null;
    if (x.s2 && parseRegionCode(x.s2)?.level === "subnational2") h.county = x.s2;
    if (x.s1 && parseRegionCode(x.s1)?.level === "subnational1") h.state = x.s1;
    if (x.cc && parseRegionCode(x.cc)?.level === "country") h.country = x.cc;
  }
  for (const x of infoRes.rows) {
    const id = x.cache_key.slice("hotspotInfo:".length);
    if (!isHotspotLocId(id)) continue;
    const meta = parseOfficialHotspotInfo(x.payload, id);
    if (!meta) continue;
    const h = ensure(id);
    h.sources.add("info");
    h.name = h.name ?? meta.locName;
    if (h.lat == null && meta.lat != null && meta.lng != null) {
      h.lat = meta.lat;
      h.lng = meta.lng;
    }
    if (!h.county && meta.countyCode && parseRegionCode(meta.countyCode)?.level === "subnational2")
      h.county = meta.countyCode;
    if (!h.state && meta.stateCode && parseRegionCode(meta.stateCode)?.level === "subnational1")
      h.state = meta.stateCode;
  }
  const coords = new Map(coordRes.rows.map((r) => [r.loc_id, r]));
  for (const row of loadedRes.rows) {
    if (row.loc_kind !== "hotspot" || !isHotspotLocId(row.loc_code)) continue;
    const h = ensure(row.loc_code);
    h.sources.add("loaded");
    h.name = h.name ?? row.loc_name;
    const c = coords.get(row.loc_code);
    if (h.lat == null && c) {
      const lat = finite(c.lat, -90, 90);
      const lng = finite(c.lng, -180, 180);
      if (lat != null && lng != null) {
        h.lat = lat;
        h.lng = lng;
      }
    }
    const rc = row.region_code ? parseRegionCode(row.region_code) : null;
    if (rc?.level === "subnational2" && !h.county) h.county = rc.code;
    if (rc?.level === "subnational1" && !h.state) h.state = rc.code;
    if (rc && !h.country) h.country = rc.country;
  }
  for (const h of hotspots.values()) {
    if (h.county && !h.state) h.state = parentOf(h.county);
    if (!h.country) h.country = parseRegionCode(h.county ?? h.state ?? "")?.country ?? null;
  }

  // Loaded rows recorded beneath each country/region (own row excluded).
  const beneath = new Map<string, number>();
  const bump = (code: string) => beneath.set(code, (beneath.get(code) ?? 0) + 1);
  for (const row of loadedRes.rows) {
    if (row.loc_kind === "region") {
      for (const a of chain(parentOf(row.loc_code))) bump(a);
    } else {
      for (const a of chain(row.region_code)) bump(a);
    }
  }

  return { loaded, attempts, refByCode, reference, hotspots, beneath };
}

/** @internal */
export type Evidence = Awaited<ReturnType<typeof loadEvidence>>;

/**
 * A cheap fingerprint of everything loadEvidence() reads (td-9eae4f). The full
 * evidence load expands every cached hotspot list (13 MB / 186k hotspots in
 * production, ~1.3 s of SQL before any JS), and it used to run on every
 * search. Reuse it until one of its inputs changes. Includes the last
 * complete year because buildCandidates' load states depend on it.
 */
async function evidenceRevision(): Promise<string> {
  const { rows } = await query<{ revision: string }>(
    `SELECT concat_ws('/',
       (SELECT md5(string_agg(concat_ws(':', loc_code, loc_kind, loc_name, region_code,
                 begin_year, end_year, n_species, fetched_at), ',' ORDER BY loc_code COLLATE "C"))
          FROM frequency_fetch),
       (SELECT md5(string_agg(concat_ws(':', loc_code, loc_kind, loc_name, region_code, error),
                 ',' ORDER BY loc_code COLLATE "C"))
          FROM frequency_fetch_attempts WHERE status = 'error'),
       (SELECT count(*) || ':' || coalesce(max(fetched_at)::text, '')
          FROM ebird_cache
         WHERE cache_key LIKE 'hotspots:%' OR cache_key LIKE 'hotspotsRegion:%'
            OR cache_key LIKE 'hotspotInfo:%'),
       (SELECT count(*) || ':' || coalesce(max(updated_at)::text, '') FROM ebird_locations)
     ) AS revision`,
  );
  return `${rows[0]?.revision ?? ""}|${lastCompleteYear()}`;
}

let discoveryCache:
  | { revision: string; value: Promise<{ ev: Evidence; candidates: Candidate[] }> }
  | undefined;

/** Evidence + candidates, rebuilt only when an input changed. Callers only
 * read them (results are copied through strip()), so sharing is safe. */
async function discoveryIndex(): Promise<{ ev: Evidence; candidates: Candidate[] }> {
  const revision = await evidenceRevision();
  if (discoveryCache?.revision === revision) return discoveryCache.value;
  const value = loadEvidence().then((ev) => ({ ev, candidates: buildCandidates(ev) }));
  discoveryCache = { revision, value };
  // A failed build must not be served to the next search.
  value.catch(() => {
    if (discoveryCache?.value === value) discoveryCache = undefined;
  });
  return value;
}

export function __resetDiscoveryCacheForTests(): void {
  discoveryCache = undefined;
}

const EVIDENCE_LABEL = {
  reference: "reference geography",
  county: "loaded county or equivalent",
  hotspot: "verified eBird hotspot",
  failedCounty: "failed load — county not loaded",
  reported: "reported location — hotspot status unverified",
} as const;

export { EVIDENCE_LABEL as HUB_EVIDENCE_LABEL };

function loadStateOf(row: LoadedRow | undefined, failed: boolean, completeYear: number): HubLoadState {
  if (row) return row.end_year >= completeYear ? "current" : "outdated";
  return failed ? "failed" : "available-not-loaded";
}

/** @internal */
export interface Candidate extends HubResult {
  names: string[];
  contextFolded: string;
  evidenceRank: number;
}

/** @internal Exported so target construction can be tested with a hand-built evidence set. */
export function buildCandidates(ev: Evidence): Candidate[] {
  const out: Candidate[] = [];
  // Computed once: lastCompleteYear() builds an Intl formatter on every call.
  const completeYear = lastCompleteYear();
  const nameOf = (code: string | null): string | null => {
    if (!code) return null;
    const ref = ev.refByCode.get(code);
    if (ref) return ref.name;
    const row = ev.loaded.get(code);
    if (row?.loc_kind === "region") return countyMeta(code)?.name ?? row.loc_name;
    return countyMeta(code)?.name ?? null;
  };
  // Thousands of hotspots share an ancestry: build (and fold) each context once.
  const contexts = new Map<string, { text: string; folded: string }>();
  const contextFor = (county: string | null, state: string | null, country: string | null) => {
    const key = `${county ?? ""}|${state ?? ""}|${country ?? ""}`;
    let hit = contexts.get(key);
    if (!hit) {
      const text = [county ? (nameOf(county) ?? county) : null, state ? (nameOf(state) ?? state) : null, country ? (nameOf(country) ?? country) : null]
        .filter((x): x is string => !!x)
        .join(", ");
      hit = { text, folded: fold(text) };
      contexts.set(key, hit);
    }
    return hit;
  };
  const contextOf = (county: string | null, state: string | null, country: string | null): string =>
    contextFor(county, state, country).text;
  const ancestryContext = (code: string | null): string => {
    const parsed = code ? parseRegionCode(code) : null;
    if (!parsed) return "";
    const c = chain(parsed.code);
    const county = c.find((x) => parseRegionCode(x)?.level === "subnational2") ?? null;
    const state = c.find((x) => parseRegionCode(x)?.level === "subnational1") ?? null;
    const country = c.find((x) => parseRegionCode(x)?.level === "country") ?? null;
    return contextOf(county, state, country);
  };
  const foldedByText = new Map<string, string>();
  const foldedContext = (context: string): string => {
    let folded = foldedByText.get(context);
    if (folded === undefined) {
      folded = fold(context);
      foldedByText.set(context, folded);
    }
    return folded;
  };
  const add = (c: Omit<Candidate, "contextFolded"> & { context: string }) =>
    out.push({ ...c, contextFolded: foldedContext(c.context) });

  // 1. Reference geography: exact rows from the regions table.
  for (const ref of ev.reference) {
    const row = ev.loaded.get(ref.code);
    const region = row?.loc_kind === "region" ? row : undefined;
    const failed = ev.attempts.get(ref.code);
    const below = ev.beneath.get(ref.code) ?? 0;
    const hasSection = !!region || below > 0;
    const country = ref.level === "country" ? ref.code : (ref.parent ?? ref.code);
    const loadState = loadStateOf(region, !!failed, completeYear);
    add({
      id: ref.code,
      type: ref.level === "country" ? "country" : "region",
      name: ref.name,
      context: ref.level === "country" ? "" : (nameOf(ref.parent) ?? ref.parent ?? ""),
      evidence: [EVIDENCE_LABEL.reference],
      loadState,
      row: region ? { beginYear: Number(region.begin_year), endYear: Number(region.end_year), nSpecies: Number(region.n_species) } : null,
      loadedBeneath: below,
      lat: null,
      lng: null,
      distanceMiles: null,
      error: !region && failed ? (failed.error ?? "unknown error") : null,
      target: hasSection
        ? { kind: "section", code: ref.code }
        : { kind: "load", country, region: ref.level === "country" ? null : ref.code },
      names: [fold(ref.name)],
      evidenceRank: region || below > 0 ? 0 : failed ? 2 : 1,
    });
  }

  // 2. Loaded counties/equivalents (never invented, never suffixed by guess).
  for (const row of ev.loaded.values()) {
    if (row.loc_kind !== "region") continue;
    const parsed = parseRegionCode(row.loc_code);
    if (parsed?.level !== "subnational2") continue;
    const official = countyMeta(row.loc_code)?.name ?? null;
    const name = official ?? row.loc_name;
    add({
      id: row.loc_code,
      type: "county",
      name,
      context: contextOf(null, parsed.parent, parsed.country),
      evidence: [EVIDENCE_LABEL.county],
      loadState: loadStateOf(row, false, completeYear),
      row: { beginYear: Number(row.begin_year), endYear: Number(row.end_year), nSpecies: Number(row.n_species) },
      loadedBeneath: 0,
      lat: null,
      lng: null,
      distanceMiles: null,
      error: null,
      target: { kind: "section", code: row.loc_code },
      names: [...new Set([fold(name), fold(row.loc_name)])],
      evidenceRank: 0,
    });
  }

  // 3. Verified hotspots: the deduplicated evidence union.
  for (const h of ev.hotspots.values()) {
    const row = ev.loaded.get(h.id);
    const loadedRow = row?.loc_kind === "hotspot" ? row : undefined;
    const failed = ev.attempts.get(h.id);
    const name = h.name ?? h.id;
    const sources = [
      h.sources.has("loaded") ? "loaded hotspot row" : null,
      h.sources.has("list") ? "official hotspot list" : null,
      h.sources.has("info") ? "official hotspot information" : null,
    ].filter((x): x is string => !!x);
    const loadState = loadStateOf(loadedRow, !!failed, completeYear);
    add({
      id: h.id,
      type: "hotspot",
      name,
      context: contextOf(h.county, h.state, h.country),
      evidence: [EVIDENCE_LABEL.hotspot, ...sources],
      loadState,
      row: loadedRow ? { beginYear: Number(loadedRow.begin_year), endYear: Number(loadedRow.end_year), nSpecies: Number(loadedRow.n_species) } : null,
      guideCounty:
        loadedRow?.region_code &&
        parseRegionCode(loadedRow.region_code)?.level === "subnational2" &&
        ev.loaded.get(loadedRow.region_code)?.loc_kind === "region"
          ? loadedRow.region_code
          : null,
      loadedBeneath: 0,
      lat: h.lat,
      lng: h.lng,
      distanceMiles: null,
      error: !loadedRow && failed ? (failed.error ?? "unknown error") : null,
      target: { kind: "hotspot", id: h.id },
      names: [fold(name), ...(loadedRow ? [fold(loadedRow.loc_name)] : [])],
      evidenceRank: loadedRow ? 0 : failed ? 2 : 1,
    });
  }

  // 4. Failed loads that are NOT established elsewhere, kept only so the recovery
  // workflow stays reachable. A hotspot-shaped one stays "reported — unverified".
  for (const a of ev.attempts.values()) {
    const kind = a.loc_kind ?? (a.loc_code.startsWith("L") ? "hotspot" : "region");
    if (kind === "hotspot") {
      if (!isHotspotLocId(a.loc_code) || ev.hotspots.has(a.loc_code)) continue;
      const name = a.loc_name?.trim() || a.loc_code;
      add({
        id: a.loc_code,
        type: "reported",
        name,
        context: ancestryContext(a.region_code),
        evidence: [EVIDENCE_LABEL.reported],
        loadState: "unverified",
        row: null,
        loadedBeneath: 0,
        lat: null,
        lng: null,
        distanceMiles: null,
        error: a.error ?? "unknown error",
        // The existing failed-load recovery row, never a hotspot page: an
        // unverified location is not routed through a verified presentation.
        target: { kind: "failed", code: a.loc_code },
        names: [fold(name)],
        evidenceRank: 3,
      });
    } else {
      const parsed = parseRegionCode(a.loc_code);
      // Countries/first-level regions are reference rows above; only an unloaded
      // county-level attempt has no other home.
      if (parsed?.level !== "subnational2" || ev.loaded.has(a.loc_code)) continue;
      const name = countyMeta(a.loc_code)?.name ?? a.loc_name?.trim() ?? a.loc_code;
      add({
        id: a.loc_code,
        type: "county",
        name,
        context: contextOf(null, parsed.parent, parsed.country),
        evidence: [EVIDENCE_LABEL.failedCounty],
        loadState: "failed",
        row: null,
        loadedBeneath: 0,
        lat: null,
        lng: null,
        distanceMiles: null,
        error: a.error ?? "unknown error",
        target: { kind: "failed", code: a.loc_code },
        names: [fold(name)],
        evidenceRank: 2,
      });
    }
  }
  return out;
}

/**
 * Of `ids`, the ones with affirmative hotspot evidence (an official list entry
 * or strict positive official info). A failed-load row without it is a reported
 * location whose hotspot status is unverified. Local reads only.
 */
export async function verifiedHotspotIdsAmong(ids: readonly string[]): Promise<Set<string>> {
  const wanted = [...new Set(ids.filter((id) => isHotspotLocId(id)))];
  if (wanted.length === 0) return new Set();
  // td-b6be76: the same evidence the discovery index already holds (official
  // hotspot lists + valid hotspot info), reused instead of re-expanding every
  // cached list on each Hotspots & data load.
  const { ev } = await discoveryIndex();
  const verified = new Set<string>();
  for (const id of wanted) {
    const h = ev.hotspots.get(id);
    if (h && (h.sources.has("list") || h.sources.has("info"))) verified.add(id);
  }
  return verified;
}

const emptyCounts = (): Record<HubResultType, number> => ({
  country: 0,
  region: 0,
  county: 0,
  hotspot: 0,
  reported: 0,
});

function strip(c: Candidate): HubResult {
  return {
    id: c.id, type: c.type, name: c.name, context: c.context, evidence: c.evidence,
    loadState: c.loadState, row: c.row, loadedBeneath: c.loadedBeneath, lat: c.lat, lng: c.lng,
    distanceMiles: c.distanceMiles, error: c.error, target: c.target,
    guideCounty: c.guideCounty ?? null,
  };
}

function paginate<T>(items: T[], page: number): { slice: T[]; pageCount: number; first: number; last: number } {
  const pageCount = Math.max(1, Math.ceil(items.length / HUB_PAGE_SIZE));
  if (page > pageCount || (items.length === 0 && page > 1)) error(404, "Results page unavailable. Return to page one.");
  const start = (page - 1) * HUB_PAGE_SIZE;
  const slice = items.slice(start, start + HUB_PAGE_SIZE);
  return { slice, pageCount, first: slice.length ? start + 1 : 0, last: start + slice.length };
}

/**
 * Discovery for a strict typed or map state. Deterministic ordering; exact
 * totals; `HUB_PAGE_SIZE` results per page with every match reachable.
 */
export async function hubDiscover(
  state: Exclude<HubDiscoveryState, { mode: "none" }>,
): Promise<HubDiscovery> {
  const { ev, candidates } = await discoveryIndex();

  if (state.mode === "typed") {
    const folded = fold(state.find);
    if (folded.length < HUB_FIND_MIN) {
      return {
        mode: "typed", find: state.find, submitted: state.submitted ?? state.find, tooShort: true, map: null, total: 0, counts: emptyCounts(),
        page: 1, pageSize: HUB_PAGE_SIZE, pageCount: 1, first: 0, last: 0, results: [], summary: null,
      };
    }
    const code = state.find.replace(/\s+/g, "").toUpperCase();
    const ranked: { c: Candidate; rank: number }[] = [];
    for (const c of candidates) {
      let rank = -1;
      if (c.id.toUpperCase() === code) rank = 0;
      else {
        for (const n of c.names) {
          const r = n === folded ? 1 : n.startsWith(folded) ? 2 : n.includes(folded) ? 3 : -1;
          if (r !== -1 && (rank === -1 || r < rank)) rank = r;
        }
        if (rank === -1 && c.contextFolded.includes(folded)) rank = 3;
      }
      if (rank !== -1) ranked.push({ c, rank });
    }
    ranked.sort(
      (a, b) =>
        a.rank - b.rank ||
        a.c.evidenceRank - b.c.evidenceRank ||
        a.c.name.localeCompare(b.c.name) ||
        (a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0),
    );
    const counts = emptyCounts();
    for (const { c } of ranked) counts[c.type] += 1;
    const { slice, pageCount, first, last } = paginate(ranked, state.page);
    return {
      mode: "typed", find: state.find, submitted: state.submitted ?? state.find, tooShort: false, map: null, total: ranked.length, counts,
      page: state.page, pageSize: HUB_PAGE_SIZE, pageCount, first, last,
      results: slice.map(({ c }) => strip(c)), summary: null,
    };
  }

  // Map/radius: coordinate-known VERIFIED hotspots inside the exact great-circle
  // radius. Distance is the shared haversine (periodic in longitude, so a circle
  // crossing 180 degrees is exact); no centroid or region box is ever used.
  const km = state.dist * MILES_TO_KM;
  const verified = candidates.filter((c) => c.type === "hotspot");
  const measured = verified.filter((c) => c.lat != null && c.lng != null);
  const inside = measured
    .map((c) => ({ c, miles: haversineKm(state.lat, state.lng, c.lat!, c.lng!) / MILES_TO_KM }))
    .filter(({ miles }) => miles * MILES_TO_KM <= km)
    .sort(
      (a, b) =>
        a.miles - b.miles ||
        a.c.name.localeCompare(b.c.name) ||
        (a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0),
    );
  const { slice, pageCount, first, last } = paginate(inside, state.page);

  // Areas represented by these hotspots' RECORDED ancestry — not a claim that
  // the map point lies inside any boundary, and never whole-area frequency rows.
  const tally = new Map<string, number>();
  for (const { c } of inside) {
    const h = ev.hotspots.get(c.id)!;
    for (const code of [h.country, h.state, h.county]) if (code) tally.set(code, (tally.get(code) ?? 0) + 1);
  }
  const summaryFor = (level: "country" | "subnational1" | "subnational2"): HubSummaryArea[] => {
    const areas: HubSummaryArea[] = [];
    for (const [code, hotspots] of tally) {
      const parsed = parseRegionCode(code);
      if (parsed?.level !== level) continue;
      const ref = ev.refByCode.get(code);
      if (level === "subnational2") {
        const row = ev.loaded.get(code);
        if (row?.loc_kind !== "region") continue; // only LOADED counties are named
        areas.push({ code, name: countyMeta(code)?.name ?? row.loc_name, type: "county", hotspots, target: { kind: "section", code } });
      } else if (ref) {
        const below = ev.beneath.get(code) ?? 0;
        const hasSection = ev.loaded.get(code)?.loc_kind === "region" || below > 0;
        areas.push({
          code,
          name: ref.name,
          type: level === "country" ? "country" : "region",
          hotspots,
          target: hasSection
            ? { kind: "section", code }
            : { kind: "load", country: level === "country" ? code : (ref.parent ?? code), region: level === "country" ? null : code },
        });
      }
    }
    return areas.sort((a, b) => b.hotspots - a.hotspots || a.name.localeCompare(b.name) || (a.code < b.code ? -1 : 1));
  };
  const counts = emptyCounts();
  counts.hotspot = inside.length;
  return {
    mode: "map",
    find: null,
    submitted: null,
    tooShort: false,
    map: {
      place: state.place, lat: state.lat, lng: state.lng, dist: state.dist,
      evaluated: measured.length,
      unevaluable: verified.length - measured.length,
    },
    total: inside.length,
    counts,
    page: state.page, pageSize: HUB_PAGE_SIZE, pageCount, first, last,
    results: slice.map(({ c, miles }) => ({ ...strip(c), distanceMiles: Math.round(miles * 10) / 10 })),
    summary: { countries: summaryFor("country"), regions: summaryFor("subnational1"), counties: summaryFor("subnational2") },
  };
}

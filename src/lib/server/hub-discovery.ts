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
import { query, withReadSnapshot } from "$lib/db";
import { haversineKm, MILES_TO_KM } from "$lib/geo";
import { guideHotspotParent } from "$lib/guide-location";
import { isHotspotLocId } from "$lib/loc-id";
import { parentOf, parseRegionCode } from "$lib/region-code";
import {
  HUB_FIND_MIN,
  HUB_PAGE_SIZE,
  type HubDiscoveryState,
  type HubTarget,
  type HubWithin,
} from "$lib/hub-discovery";
import { lastCompleteYear } from "$server/barchart";
import { countyMeta } from "$server/county-meta";
import { trackBusy } from "$server/freeze-watch";
import { DOWNLOADED_HOTSPOT_IDS } from "$server/hotspot-coordinates";
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
  /** For a loaded hotspot: the place the Field Guide finds it under, so the
   * species count can open its list (td-c52c37): its loaded county, or the
   * state or region eBird records it under with no county (td-327dd6). Null
   * when there isn't one. */
  guideParent?: string | null;
}

export interface HubSummaryArea {
  code: string;
  name: string;
  type: "country" | "region" | "county";
  hotspots: number;
  target: HubTarget;
}

/** The location a search is limited to (td-a6f8a1). */
export interface HubWithinView {
  selection: HubWithin;
  /** The deepest chosen code: the hotspot, county, state or region, or country. */
  code: string;
  name: string;
  /** Its containing places, e.g. "United States" for Florida. */
  context: string;
  /** False when nothing here knows that place (a hand-edited or stale link). */
  known: boolean;
}

export interface HubDiscovery {
  /** "place": a location chosen with no typed text, answered with that one place. */
  mode: "typed" | "map" | "place";
  within: HubWithinView | null;
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

const SRC_LOADED = 1;
const SRC_LIST = 2;
const SRC_INFO = 4;

/**
 * The verified-hotspot union in parallel arrays (td-7f03b6). Production has
 * ~186,000 cached hotspots; one object (with its own Set) per hotspot, plus a
 * second full Candidate object each, made a single search allocate hundreds
 * of MB (evidence +96 MB and candidates +98 MB for 160k on the test snapshot).
 * Region codes are interned, so the thousands of hotspots in one county share
 * one string. `get()` builds a HotspotEvidence view on demand for callers
 * that want one hotspot.
 */
export class HotspotStore {
  private readonly index = new Map<string, number>();
  private readonly pool = new Map<string, string>();
  readonly ids: string[] = [];
  readonly names: (string | null)[] = [];
  readonly lat: (number | null)[] = [];
  readonly lng: (number | null)[] = [];
  readonly county: (string | null)[] = [];
  readonly state: (string | null)[] = [];
  readonly country: (string | null)[] = [];
  readonly sources: number[] = [];
  /** fold(name ?? id), computed once at build time instead of on every search (td-877997). */
  readonly folded: string[] = [];

  get size(): number {
    return this.ids.length;
  }
  has(id: string): boolean {
    return this.index.has(id);
  }
  indexOf(id: string): number | undefined {
    return this.index.get(id);
  }
  /** Position of `id`, adding an empty record the first time it's seen. */
  ensure(id: string): number {
    let i = this.index.get(id);
    if (i === undefined) {
      i = this.ids.length;
      this.index.set(id, i);
      this.ids.push(id);
      this.names.push(null);
      this.lat.push(null);
      this.lng.push(null);
      this.county.push(null);
      this.state.push(null);
      this.country.push(null);
      this.sources.push(0);
    }
    return i;
  }
  /** One shared string per distinct region code. */
  intern(code: string | null): string | null {
    if (code == null) return null;
    let hit = this.pool.get(code);
    if (hit === undefined) {
      hit = code;
      this.pool.set(code, code);
    }
    return hit;
  }
  get(id: string): HotspotEvidence | undefined {
    const i = this.index.get(id);
    if (i === undefined) return undefined;
    const sources = new Set<"loaded" | "list" | "info">();
    if (this.sources[i] & SRC_LOADED) sources.add("loaded");
    if (this.sources[i] & SRC_LIST) sources.add("list");
    if (this.sources[i] & SRC_INFO) sources.add("info");
    return {
      id,
      name: this.names[i],
      lat: this.lat[i],
      lng: this.lng[i],
      county: this.county[i],
      state: this.state[i],
      country: this.country[i],
      sources,
    };
  }
}

/**
 * Lets other requests run between slices of the index build and of a search
 * scan (td-877997): Node runs every request on one thread, so one long loop
 * over ~186k hotspots stopped the whole server for seconds on production.
 */
const breathe = () => new Promise<void>((resolve) => setImmediate(resolve));
/** Loop iterations between breaths. */
const SLICE = 2048;
/**
 * Hotspots per row of the list query, read one row per round trip through a
 * cursor: the driver parses every row that arrives in one network read in a
 * single stretch (545 ms locally for the whole list), so rows must also arrive
 * apart.
 */
const LIST_CHUNK = 2000;

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

/** One row of the hotspot list query: LIST_CHUNK hotspots as column arrays. */
interface ListChunk {
  ids: string[] | null;
  names: (string | null)[] | null;
  lats: (number | null)[] | null;
  lngs: (number | null)[] | null;
  s1: (string | null)[] | null;
  s2: (string | null)[] | null;
  cc: (string | null)[] | null;
}

function addListChunk(hotspots: HotspotStore, lists: ListChunk): void {
  const ids = lists.ids ?? [];
  for (let k = 0; k < ids.length; k++) {
    const i = hotspots.ensure(ids[k]);
    hotspots.sources[i] |= SRC_LIST;
    hotspots.names[i] = lists.names?.[k]?.trim() || hotspots.names[i];
    let lat = finite(lists.lats?.[k], -90, 90);
    let lng = finite(lists.lngs?.[k], -180, 180);
    if (lat == null || lng == null) lat = lng = null;
    hotspots.lat[i] = lat;
    hotspots.lng[i] = lng;
    const s2 = lists.s2?.[k];
    const s1 = lists.s1?.[k];
    const cc = lists.cc?.[k];
    if (s2 && parseRegionCode(s2)?.level === "subnational2") hotspots.county[i] = hotspots.intern(s2);
    if (s1 && parseRegionCode(s1)?.level === "subnational1") hotspots.state[i] = hotspots.intern(s1);
    if (cc && parseRegionCode(cc)?.level === "country") hotspots.country[i] = hotspots.intern(cc);
  }
}

async function loadEvidence() {
  // Verified hotspot union, deduplicated by exact eBird location ID.
  const hotspots = new HotspotStore();
  // Official hotspot lists only (regional and point-radius). The copy from the
  // list whose content changed most recently wins; entries carry their own
  // official ancestry codes. Returned as column arrays rather than ~186k row
  // objects (td-7f03b6), LIST_CHUNK hotspots per row so the driver parses them
  // in pieces with other requests running in between (td-877997).
  // Set when a sibling read fails: the cursor stops at its next batch, and the
  // build fails only after it has closed, so a failed build never leaves a
  // cursor running beside the next one (CODEX1).
  let stopLists = false;
  const listsRead = withReadSnapshot(async (db) => {
    await db.query(
      `DECLARE hub_lists NO SCROLL CURSOR FOR
       SELECT array_agg(loc_id ORDER BY loc_id) AS ids,
              array_agg(loc_name ORDER BY loc_id) AS names,
              array_agg(lat ORDER BY loc_id) AS lats,
              array_agg(lng ORDER BY loc_id) AS lngs,
              array_agg(s1 ORDER BY loc_id) AS s1,
              array_agg(s2 ORDER BY loc_id) AS s2,
              array_agg(cc ORDER BY loc_id) AS cc
         FROM (
           SELECT y.*, (row_number() OVER (ORDER BY y.loc_id) - 1) / ${LIST_CHUNK} AS chunk
             FROM (
               SELECT DISTINCT ON (x.loc_id) x.loc_id, x.loc_name, x.lat, x.lng, x.s1, x.s2, x.cc
                 FROM (
                   SELECT h->>'locId' AS loc_id, h->>'locName' AS loc_name,
                          CASE WHEN jsonb_typeof(h->'lat') = 'number' THEN (h->>'lat')::float8 END AS lat,
                          CASE WHEN jsonb_typeof(h->'lng') = 'number' THEN (h->>'lng')::float8 END AS lng,
                          h->>'subnational1Code' AS s1, h->>'subnational2Code' AS s2,
                          h->>'countryCode' AS cc, coalesce(c.content_changed_at, c.fetched_at) AS changed_at,
                          c.cache_key
                     FROM ebird_cache c
                    CROSS JOIN LATERAL jsonb_array_elements(
                           CASE WHEN jsonb_typeof(c.payload) = 'array' THEN c.payload ELSE '[]'::jsonb END) h
                    WHERE (c.cache_key LIKE 'hotspots:%' OR c.cache_key LIKE 'hotspotsRegion:%')
                      AND jsonb_typeof(h) = 'object'
                      AND h->>'locId' ~ '^L[0-9]+$'
                 ) x
                ORDER BY x.loc_id, x.changed_at DESC, x.cache_key
             ) y
         ) z
        GROUP BY chunk
        ORDER BY chunk`,
    );
    while (!stopLists) {
      const { rows } = await db.query<ListChunk>("FETCH 1 FROM hub_lists");
      if (rows.length === 0) break;
      addListChunk(hotspots, rows[0]);
      await breathe();
    }
  });
  const othersRead = Promise.all([
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
    query<{ cache_key: string; payload: unknown }>(
      `SELECT cache_key, payload FROM ebird_cache WHERE cache_key LIKE 'hotspotInfo:%'`,
    ),
    // Coordinates of hotspots that are ALREADY established by a loaded row; the
    // same-ID location row supplies coordinates, never identity.
    query<{ loc_id: string; lat: number; lng: number }>(
      `SELECT e.loc_id, e.lat, e.lng
         FROM ebird_locations e
        WHERE e.loc_id = ANY (${DOWNLOADED_HOTSPOT_IDS})`,
    ),
    allReferenceRegions(),
  ]);
  othersRead.catch(() => {
    stopLists = true;
  });
  const [others, lists] = await Promise.allSettled([othersRead, listsRead]);
  if (others.status === "rejected") throw others.reason;
  if (lists.status === "rejected") throw lists.reason;
  const [loadedRes, attemptRes, infoRes, coordRes, reference] = others.value;

  const loaded = new Map<string, LoadedRow>(loadedRes.rows.map((r) => [r.loc_code, r]));
  const attempts = new Map<string, AttemptRow>(attemptRes.rows.map((r) => [r.loc_code, r]));
  const refByCode = new Map(reference.map((r) => [r.code, r]));

  for (const x of infoRes.rows) {
    const id = x.cache_key.slice("hotspotInfo:".length);
    if (!isHotspotLocId(id)) continue;
    const meta = parseOfficialHotspotInfo(x.payload, id);
    if (!meta) continue;
    const i = hotspots.ensure(id);
    hotspots.sources[i] |= SRC_INFO;
    hotspots.names[i] = hotspots.names[i] ?? meta.locName;
    if (hotspots.lat[i] == null && meta.lat != null && meta.lng != null) {
      hotspots.lat[i] = meta.lat;
      hotspots.lng[i] = meta.lng;
    }
    if (!hotspots.county[i] && meta.countyCode && parseRegionCode(meta.countyCode)?.level === "subnational2")
      hotspots.county[i] = hotspots.intern(meta.countyCode);
    if (!hotspots.state[i] && meta.stateCode && parseRegionCode(meta.stateCode)?.level === "subnational1")
      hotspots.state[i] = hotspots.intern(meta.stateCode);
  }
  await breathe();
  const coords = new Map(coordRes.rows.map((r) => [r.loc_id, r]));
  let n = 0;
  for (const row of loadedRes.rows) {
    if (++n % SLICE === 0) await breathe();
    if (row.loc_kind !== "hotspot" || !isHotspotLocId(row.loc_code)) continue;
    const i = hotspots.ensure(row.loc_code);
    hotspots.sources[i] |= SRC_LOADED;
    hotspots.names[i] = hotspots.names[i] ?? row.loc_name;
    const c = coords.get(row.loc_code);
    if (hotspots.lat[i] == null && c) {
      const lat = finite(c.lat, -90, 90);
      const lng = finite(c.lng, -180, 180);
      if (lat != null && lng != null) {
        hotspots.lat[i] = lat;
        hotspots.lng[i] = lng;
      }
    }
    const rc = row.region_code ? parseRegionCode(row.region_code) : null;
    if (rc?.level === "subnational2" && !hotspots.county[i]) hotspots.county[i] = hotspots.intern(rc.code);
    if (rc?.level === "subnational1" && !hotspots.state[i]) hotspots.state[i] = hotspots.intern(rc.code);
    if (rc && !hotspots.country[i]) hotspots.country[i] = hotspots.intern(rc.country);
  }
  for (let i = 0; i < hotspots.size; i++) {
    if (i % SLICE === 0) await breathe();
    if (hotspots.county[i] && !hotspots.state[i]) hotspots.state[i] = hotspots.intern(parentOf(hotspots.county[i]!));
    if (!hotspots.country[i])
      hotspots.country[i] = hotspots.intern(
        parseRegionCode(hotspots.county[i] ?? hotspots.state[i] ?? "")?.country ?? null,
      );
    hotspots.folded[i] = fold(hotspots.names[i] ?? hotspots.ids[i]);
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
 * A cheap fingerprint of everything loadEvidence() reads, so the index is
 * rebuilt only when an input changes, in two parts:
 * - `lists`: the cached official hotspot lists and info, by when their CONTENT
 *   last changed (migration 0095's trigger fingerprints only the fields the
 *   index reads), not by when they were last fetched: a refetch of the same
 *   hotspots used to rebuild everything (td-877997);
 * - `loaded`: loaded rows, failed attempts, coordinates of downloaded hotspots
 *   and the last complete year (the fields used, not their fetch or modification times).
 */
interface Revision {
  lists: string;
  loaded: string;
}
async function evidenceRevision(): Promise<Revision> {
  const { rows } = await query<{ lists: string | null; loaded: string }>(
    `SELECT
       (SELECT md5(string_agg(jsonb_build_array(cache_key, coalesce(content_changed_at, fetched_at))::text,
                 ',' ORDER BY cache_key COLLATE "C"))
          FROM ebird_cache
         WHERE cache_key LIKE 'hotspots:%' OR cache_key LIKE 'hotspotsRegion:%'
            OR cache_key LIKE 'hotspotInfo:%') AS lists,
       concat_ws('/',
       (SELECT md5(string_agg(jsonb_build_array(loc_code, loc_kind, loc_name, region_code,
                 begin_year, end_year, n_species)::text, ',' ORDER BY loc_code COLLATE "C"))
          FROM frequency_fetch),
       (SELECT md5(string_agg(jsonb_build_array(a.loc_code, a.loc_kind, a.loc_name, a.region_code, a.error)::text,
                 ',' ORDER BY a.loc_code COLLATE "C"))
          FROM frequency_fetch_attempts a
         WHERE a.status = 'error'
           AND NOT EXISTS (SELECT 1 FROM frequency_fetch f WHERE f.loc_code = a.loc_code)),
       (SELECT md5(string_agg(jsonb_build_array(e.loc_id, e.lat, e.lng)::text,
                 ',' ORDER BY e.loc_id COLLATE "C"))
          FROM ebird_locations e
         WHERE e.loc_id = ANY (${DOWNLOADED_HOTSPOT_IDS}))
       ) AS loaded`,
  );
  return { lists: rows[0]?.lists ?? "", loaded: `${rows[0]?.loaded ?? ""}|${lastCompleteYear()}` };
}

const sameRevision = (a: Revision, b: Revision) => a.lists === b.lists && a.loaded === b.loaded;

/**
 * Evidence + eager candidates. td-9eae4f kept the ORIGINAL index (one object
 * per hotspot, plus a candidate each: ~194 MB on the test snapshot, more in
 * production), which helped push production past PM2's 600 MB limit, so it
 * was dropped on 2026-09-26. The compact store (td-7f03b6) holds the same
 * evidence in ~64 MB (160k hotspots), which is affordable to keep under the
 * 384 MB heap cap and makes repeat searches fast.
 *
 * td-877997: the index is built when the web process starts and checked for
 * changes every minute (startHubIndexWarmer), so a search rarely waits for
 * one. While a new one builds, the current one keeps answering if only the
 * cached hotspot lists changed (eBird added or renamed hotspots); a change to
 * loaded data (the owner's own load) waits for the new index, so the search
 * shows it. One build at a time; the build breathes, so other requests keep
 * being answered while it runs.
 */
type DiscoveryIndex = { ev: Evidence; candidates: Candidate[]; helpers: CandidateHelpers };
let ready: { rev: Revision; value: DiscoveryIndex } | undefined;
let building: { rev: Revision; promise: Promise<DiscoveryIndex> } | undefined;
let builds = 0;

function startBuild(rev: Revision, reason: string): Promise<DiscoveryIndex> {
  if (building) return building.promise;
  builds += 1;
  const started = performance.now();
  // Named for Admin → Metrics → Server freezes (td-b07462).
  const promise = trackBusy("hotspot search index rebuild", async () => {
    const ev = await loadEvidence();
    await breathe();
    const helpers = candidateHelpers(ev);
    const candidates = buildCandidates(ev, helpers);
    return { ev, candidates, helpers };
  });
  const entry = { rev, promise };
  building = entry;
  // Cleared in the same step that publishes the result, so a caller waiting on
  // this build sees it finished when it checks again.
  promise.then(
    (value) => {
      if (building === entry) building = undefined;
      ready = { rev, value };
      console.log(
        `[hub-index] built ${value.ev.hotspots.size} hotspots in ${Math.round(performance.now() - started)} ms (${reason})`,
      );
    },
    (err) => {
      if (building === entry) building = undefined;
      console.error("[hub-index] build failed:", err instanceof Error ? err.message : err);
    },
  );
  return promise;
}

/**
 * An index whose revision `fits` the current one. A build already running may
 * be for an older revision (it started before the owner's load), so a caller
 * waits for it, then checks again, and builds again if it still does not fit
 * (CODEX1); after WAIT_ROUNDS it takes the newest index there is.
 */
const WAIT_ROUNDS = 3;
async function indexThatFits(fits: (built: Revision, now: Revision) => boolean): Promise<DiscoveryIndex> {
  for (let round = 1; ; round++) {
    const rev = await evidenceRevision();
    if (ready && fits(ready.rev, rev)) return ready.value;
    if (round > WAIT_ROUNDS && ready) return ready.value;
    if (building) {
      await building.promise.catch(() => undefined);
      continue;
    }
    const reason = !ready ? "first use" : ready.rev.loaded !== rev.loaded ? "loaded data changed" : "hotspot lists changed";
    try {
      await startBuild(rev, reason);
    } catch (err) { // stale-safe: web-request index build, never under a job claim; rethrows unless an older index can answer
      if (round >= WAIT_ROUNDS) {
        if (ready) return ready.value;
        throw err;
      }
    }
  }
}

async function discoveryIndex(): Promise<DiscoveryIndex> {
  const rev = await evidenceRevision();
  const current = ready;
  if (current && sameRevision(current.rev, rev)) return current.value;
  // Only the cached hotspot lists changed: answer from the current index and rebuild beside it.
  if (current && current.rev.loaded === rev.loaded) {
    void startBuild(rev, "hotspot lists changed").catch(() => undefined);
    return current.value;
  }
  // Loaded data changed (or there is no index yet): wait for one that includes it.
  return indexThatFits((built, now) => built.loaded === now.loaded);
}

/** "ready" once an index exists (a newer one may be building), for /api/health and the deploy. */
export function hubIndexState(): "ready" | "building" | "cold" {
  return ready ? "ready" : building ? "building" : "cold";
}

let warmerStarted = false;
/**
 * Builds the index when the web process starts (so the first search after a
 * deploy does not wait) and rebuilds it within a minute of a change, before
 * anyone searches (hooks.server.ts; not in builds or tests).
 */
export function startHubIndexWarmer(everyMs = 60_000): void {
  if (warmerStarted) return;
  warmerStarted = true;
  const refresh = async (reason: string) => {
    try {
      const rev = await evidenceRevision();
      if (!ready || !sameRevision(ready.rev, rev)) await startBuild(rev, reason);
    } catch (err) { // stale-safe: web-process background refresh, never under a job claim; logs and retries next minute
      console.error("[hub-index] refresh failed:", err instanceof Error ? err.message : err);
    }
  };
  void refresh("startup");
  setInterval(() => void refresh("data changed"), everyMs).unref();
}

export function __resetDiscoveryCacheForTests(): void {
  ready = undefined;
  building = undefined;
}

/** Tests: how many builds have started, and the one running (if any). */
export function __hubIndexForTests(): { builds: number; building: Promise<unknown> | undefined } {
  return { builds, building: building?.promise };
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
  /** Its own code and every containing code it is recorded under. */
  area: string[];
  names: string[];
  contextFolded: string;
  evidenceRank: number;
}

/** Display/match helpers shared by the eager candidates and the on-demand
 * hotspot candidates: each distinct ancestry's context is built and folded once. */
function candidateHelpers(ev: Evidence) {
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
  return { completeYear, nameOf, contextFor, contextOf, ancestryContext, foldedContext };
}
export type CandidateHelpers = ReturnType<typeof candidateHelpers>;

/**
 * One hotspot's full candidate, built only when it's a match being returned
 * (td-7f03b6). Same fields and rules the eager build used to produce for all
 * ~186k hotspots.
 */
function hotspotCandidate(ev: Evidence, i: number, helpers: CandidateHelpers): Candidate {
  const store = ev.hotspots as HotspotStore;
  const id = store.ids[i];
  const row = ev.loaded.get(id);
  const loadedRow = row?.loc_kind === "hotspot" ? row : undefined;
  const failed = ev.attempts.get(id);
  const name = store.names[i] ?? id;
  const src = store.sources[i];
  const sources = [
    src & SRC_LOADED ? "loaded hotspot row" : null,
    src & SRC_LIST ? "official hotspot list" : null,
    src & SRC_INFO ? "official hotspot information" : null,
  ].filter((x): x is string => !!x);
  const context = helpers.contextOf(store.county[i], store.state[i], store.country[i]);
  return {
    id,
    type: "hotspot",
    name,
    context,
    evidence: [EVIDENCE_LABEL.hotspot, ...sources],
    loadState: loadStateOf(loadedRow, !!failed, helpers.completeYear),
    row: loadedRow ? { beginYear: Number(loadedRow.begin_year), endYear: Number(loadedRow.end_year), nSpecies: Number(loadedRow.n_species) } : null,
    guideParent: guideHotspotParent(
      loadedRow?.region_code ?? null,
      !!loadedRow?.region_code && ev.loaded.get(loadedRow.region_code)?.loc_kind === "region",
    ),
    loadedBeneath: 0,
    lat: store.lat[i],
    lng: store.lng[i],
    distanceMiles: null,
    error: !loadedRow && failed ? (failed.error ?? "unknown error") : null,
    target: { kind: "hotspot", id },
    area: [id, ...[store.county[i], store.state[i], store.country[i]].filter((x): x is string => !!x)],
    names: [fold(name), ...(loadedRow ? [fold(loadedRow.loc_name)] : [])],
    evidenceRank: loadedRow ? 0 : failed ? 2 : 1,
    contextFolded: helpers.foldedContext(context),
  };
}

/**
 * @internal Exported so target construction can be tested with a hand-built
 * evidence set. Countries, regions, counties and failed/reported locations;
 * hotspot candidates are built on demand for matches (td-7f03b6).
 */
export function buildCandidates(ev: Evidence, helpers: CandidateHelpers = candidateHelpers(ev)): Candidate[] {
  const out: Candidate[] = [];
  const { completeYear, nameOf, contextOf, ancestryContext, foldedContext } = helpers;
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
      area: chain(ref.code),
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
      area: chain(row.loc_code),
      names: [...new Set([fold(name), fold(row.loc_name)])],
      evidenceRank: 0,
    });
  }

  // 3. Verified hotspots are NOT built here: ~186k objects each (td-7f03b6).
  //    hubDiscover ranks them from the compact store and builds candidates
  //    only for the matches it returns (hotspotCandidate).

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
        area: [a.loc_code, ...chain(a.region_code)],
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
        area: chain(a.loc_code),
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
  // Same rule as before (official hotspot list or valid hotspot info), read from
  // the discovery index's store (td-877997) instead of a second full build of
  // the same lists. Only the lists matter here, so a loaded-data change never
  // makes this wait.
  const index = await indexThatFits((built, now) => built.lists === now.lists);
  const store = index.ev.hotspots as HotspotStore;
  return new Set(
    wanted.filter((id) => {
      const i = store.indexOf(id);
      return i !== undefined && (store.sources[i] & (SRC_LIST | SRC_INFO)) !== 0;
    }),
  );
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
    guideParent: c.guideParent ?? null,
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
 * What a chosen location means against the index (td-a6f8a1): its display
 * name, whether it is known, and the two membership tests a search applies,
 * one for candidates (countries, regions, counties, reported locations) and
 * one for verified hotspots in the compact store. A hotspot location holds
 * only itself, and only where it is recorded under the chosen state or region
 * (and county, when one is chosen).
 */
function resolveWithin(ev: Evidence, helpers: CandidateHelpers, within: HubWithin) {
  const store = ev.hotspots as HotspotStore;
  // A hotspot is inside a place when its official record OR its loaded row
  // puts it there: the location's hotspot list (guideHotspots) files a
  // loaded hotspot under its loaded row's region, which can disagree with the
  // official lists the store prefers (CODEX1).
  const loadedChain = (id: string): string[] => {
    const row = ev.loaded.get(id);
    return row?.loc_kind === "hotspot" ? chain(row.region_code) : [];
  };
  if (within.kind === "hotspot") {
    const id = within.hotspot;
    const at = (county: string | null, state: string | null) =>
      state === within.region && (!within.county || county === within.county);
    const filedUnder = (codes: string[]) =>
      codes.includes(within.region) && (!within.county || codes.includes(within.county));
    const i = store.indexOf(id);
    const attempt = ev.attempts.get(id);
    const attemptChain = chain(attempt?.region_code);
    const inStore =
      i !== undefined && (at(store.county[i], store.state[i]) || filedUnder(loadedChain(id))) ? i : undefined;
    const reported =
      inStore === undefined && attempt && attemptChain.includes(within.region) &&
      (!within.county || attemptChain.includes(within.county));
    const known = inStore !== undefined || !!reported;
    const view: HubWithinView = {
      selection: within,
      code: id,
      name: (inStore !== undefined ? store.names[inStore] : attempt?.loc_name?.trim()) || id,
      context: helpers.contextOf(within.county, within.region, within.country),
      known,
    };
    return {
      view,
      hotspotIndex: inStore,
      candidateIn: (c: Candidate) => known && c.id === id,
      storeIn: (k: number) => k === inStore,
    };
  }
  const code = within.kind === "country" ? within.country : within.kind === "region" ? within.region : within.county;
  const parent = parentOf(code);
  const known =
    within.kind === "county"
      ? ev.refByCode.has(within.region) &&
        (!!countyMeta(code) || ev.loaded.get(code)?.loc_kind === "region" || ev.attempts.has(code))
      : ev.refByCode.has(code);
  const view: HubWithinView = {
    selection: within,
    code,
    name: helpers.nameOf(code) ?? code,
    context: parent ? helpers.ancestryContext(parent) : "",
    known,
  };
  return {
    view,
    hotspotIndex: undefined as number | undefined,
    candidateIn: (c: Candidate) => known && c.area.includes(code),
    storeIn: (k: number) =>
      known &&
      (store.county[k] === code ||
        store.state[k] === code ||
        store.country[k] === code ||
        loadedChain(store.ids[k]).includes(code)),
  };
}

/** The location's view alone, for an answer that searches nothing. */
async function withinOnly(within: HubWithin): Promise<HubWithinView> {
  const { ev, helpers } = await discoveryIndex();
  return resolveWithin(ev, helpers, within).view;
}

/**
 * Discovery for a strict typed, place or map state. Deterministic ordering; exact
 * totals; `HUB_PAGE_SIZE` results per page with every match reachable.
 */
export async function hubDiscover(
  state: Exclude<HubDiscoveryState, { mode: "none" }>,
): Promise<HubDiscovery> {
  if (state.mode === "typed" && fold(state.find).length < HUB_FIND_MIN) {
    // Not a search yet: the location is resolved only when there is one.
    const within = state.within ? await withinOnly(state.within) : null;
    return {
      mode: "typed", within, find: state.find, submitted: state.submitted ?? state.find, tooShort: true, map: null, total: 0, counts: emptyCounts(),
      page: 1, pageSize: HUB_PAGE_SIZE, pageCount: 1, first: 0, last: 0, results: [], summary: null,
    };
  }
  const { ev, candidates, helpers } = await discoveryIndex();
  const store = ev.hotspots as HotspotStore;

  if (state.mode === "place") {
    // The chosen place itself, as its own row: the county, state or region,
    // country or hotspot, never everything inside it (td-a6f8a1).
    const where = resolveWithin(ev, helpers, state.within);
    const own = where.view.known
      ? where.hotspotIndex !== undefined
        ? hotspotCandidate(ev, where.hotspotIndex, helpers)
        : candidates.find((c) => c.id === where.view.code)
      : undefined;
    const counts = emptyCounts();
    if (own) counts[own.type] = 1;
    return {
      mode: "place", within: where.view, find: null, submitted: null, tooShort: false, map: null,
      total: own ? 1 : 0, counts, page: 1, pageSize: HUB_PAGE_SIZE, pageCount: 1,
      first: own ? 1 : 0, last: own ? 1 : 0, results: own ? [strip(own)] : [], summary: null,
    };
  }

  if (state.mode === "typed") {
    const where = state.within ? resolveWithin(ev, helpers, state.within) : null;
    const folded = fold(state.find);
    const code = state.find.replace(/\s+/g, "").toUpperCase();
    const nameRank = (n: string) =>
      n === folded ? 1 : n.startsWith(folded) ? 2 : n.includes(folded) ? 3 : -1;
    // One packed integer per match: low two bits are rank, bit 2 marks a
    // hotspot, remaining bits are the candidate/store index. A broad context
    // query can match nearly every hotspot; retaining one JS object per match
    // would otherwise recreate a sizeable search-time heap spike.
    const HOTSPOT_MATCH = 4;
    const pack = (i: number, hotspot: boolean, rank: number) => (i << 3) | (hotspot ? HOTSPOT_MATCH : 0) | rank;
    const matchRank = (m: number) => m & 3;
    const isHotspotMatch = (m: number) => (m & HOTSPOT_MATCH) !== 0;
    const matchIndex = (m: number) => m >>> 3;
    const ranked: number[] = [];
    const hotspotEvidenceRanks = new Uint8Array(store.size);
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      if (where && !where.candidateIn(c)) continue;
      let rank = -1;
      if (c.id.toUpperCase() === code) rank = 0;
      else {
        for (const n of c.names) {
          const r = nameRank(n);
          if (r !== -1 && (rank === -1 || r < rank)) rank = r;
        }
        if (rank === -1 && c.contextFolded.includes(folded)) rank = 3;
      }
      if (rank !== -1) ranked.push(pack(i, false, rank));
    }
    for (let i = 0; i < store.size; i++) {
      // ~186k hotspots: let other requests run between slices (td-877997).
      if (i % SLICE === 0) await breathe();
      if (where && !where.storeIn(i)) continue;
      const id = store.ids[i];
      const row = ev.loaded.get(id);
      const loadedRow = row?.loc_kind === "hotspot" ? row : undefined;
      hotspotEvidenceRanks[i] = loadedRow ? 0 : ev.attempts.has(id) ? 2 : 1;
      let rank = -1;
      if (id.toUpperCase() === code) rank = 0;
      else {
        // Same rule as an eager candidate: best of its names, then its context.
        rank = nameRank(store.folded[i]);
        if (loadedRow != null) {
          const r = nameRank(fold(loadedRow.loc_name));
          if (r !== -1 && (rank === -1 || r < rank)) rank = r;
        }
        if (rank === -1 && helpers.contextFor(store.county[i], store.state[i], store.country[i]).folded.includes(folded))
          rank = 3;
      }
      if (rank !== -1) ranked.push(pack(i, true, rank));
    }
    const matchEvidenceRank = (m: number) => {
      const i = matchIndex(m);
      return isHotspotMatch(m) ? hotspotEvidenceRanks[i] : candidates[i].evidenceRank;
    };
    const matchName = (m: number) => {
      const i = matchIndex(m);
      return isHotspotMatch(m) ? (store.names[i] ?? store.ids[i]) : candidates[i].name;
    };
    const matchId = (m: number) => {
      const i = matchIndex(m);
      return isHotspotMatch(m) ? store.ids[i] : candidates[i].id;
    };
    ranked.sort((a, b) => {
      const rank = matchRank(a) - matchRank(b);
      if (rank) return rank;
      const evidence = matchEvidenceRank(a) - matchEvidenceRank(b);
      if (evidence) return evidence;
      const name = matchName(a).localeCompare(matchName(b));
      if (name) return name;
      const aid = matchId(a);
      const bid = matchId(b);
      return aid < bid ? -1 : aid > bid ? 1 : 0;
    });
    const counts = emptyCounts();
    for (const m of ranked)
      counts[isHotspotMatch(m) ? "hotspot" : candidates[matchIndex(m)].type] += 1;
    const { slice, pageCount, first, last } = paginate(ranked, state.page);
    return {
      mode: "typed", within: where?.view ?? null, find: state.find, submitted: state.submitted ?? state.find, tooShort: false, map: null, total: ranked.length, counts,
      page: state.page, pageSize: HUB_PAGE_SIZE, pageCount, first, last,
      results: slice.map((m) => {
        const i = matchIndex(m);
        return strip(isHotspotMatch(m) ? hotspotCandidate(ev, i, helpers) : candidates[i]);
      }), summary: null,
    };
  }

  // Map/radius: coordinate-known VERIFIED hotspots inside the exact great-circle
  // radius. Distance is the shared haversine (periodic in longitude, so a circle
  // crossing 180 degrees is exact); no centroid or region box is ever used.
  const km = state.dist * MILES_TO_KM;
  // Verified hotspots straight from the compact store (td-7f03b6); only the
  // returned page becomes full candidates.
  const inside: number[] = [];
  const milesByIndex = new Float64Array(store.size);
  let evaluated = 0;
  for (let i = 0; i < store.size; i++) {
    if (i % SLICE === 0) await breathe();
    const lat = store.lat[i];
    const lng = store.lng[i];
    if (lat == null || lng == null) continue;
    evaluated += 1;
    const km2 = haversineKm(state.lat, state.lng, lat, lng);
    if (km2 > km) continue;
    milesByIndex[i] = km2 / MILES_TO_KM;
    inside.push(i);
  }
  inside.sort(
    (a, b) =>
      milesByIndex[a] - milesByIndex[b] ||
      (store.names[a] ?? store.ids[a]).localeCompare(store.names[b] ?? store.ids[b]) ||
      (store.ids[a] < store.ids[b] ? -1 : store.ids[a] > store.ids[b] ? 1 : 0),
  );
  const { slice, pageCount, first, last } = paginate(inside, state.page);

  // Areas represented by these hotspots' RECORDED ancestry — not a claim that
  // the map point lies inside any boundary, and never whole-area frequency rows.
  const tally = new Map<string, number>();
  for (const i of inside) {
    for (const code of [store.country[i], store.state[i], store.county[i]])
      if (code) tally.set(code, (tally.get(code) ?? 0) + 1);
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
    within: null,
    find: null,
    submitted: null,
    tooShort: false,
    map: {
      place: state.place, lat: state.lat, lng: state.lng, dist: state.dist,
      evaluated,
      unevaluable: store.size - evaluated,
    },
    total: inside.length,
    counts,
    page: state.page, pageSize: HUB_PAGE_SIZE, pageCount, first, last,
    results: slice.map((i) => ({
      ...strip(hotspotCandidate(ev, i, helpers)),
      distanceMiles: Math.round(milesByIndex[i] * 10) / 10,
    })),
    summary: { countries: summaryFor("country"), regions: summaryFor("subnational1"), counties: summaryFor("subnational2") },
  };
}

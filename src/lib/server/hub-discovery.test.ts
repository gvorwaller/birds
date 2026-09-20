import { loadTestEnv, requireTestDb } from "$server/testing/test-env";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { query } from "$lib/db";
import { HUB_PAGE_SIZE } from "$lib/hub-discovery";
import { buildCandidates, hubDiscover, verifiedHotspotIdsAmong, type Evidence, type HubDiscovery } from "$server/hub-discovery";

/**
 * Phase 8B (td-687b1c): the discovery service against seeded evidence. Every row
 * is created here under reserved codes and removed afterwards, so assertions
 * are exact and never depend on mutable production-copy totals.
 */
loadTestEnv();
await requireTestDb(query);

const STATE = "US-FL";
const COUNTY = "US-FL-971"; // loaded county fixture (stored name only)
const COUNTY_FAILED = "US-FL-972"; // county whose load failed, never loaded
const COUNTY_UNLOADED = "US-FL-973"; // appears only in a list's ancestry

// Verified-hotspot evidence, one per accepted source.
const H_LOADED = "L99771001"; // loaded hotspot row only
const H_LIST = "L99771002"; // official list only
const H_INFO = "L99771003"; // strict positive official info only
const H_BOTH = "L99771004"; // loaded row AND list: one result
const H_FAILED = "L99771008"; // verified by list, last load failed
// Never verified: must not appear as hotspots.
const X_OBS = "L99771005"; // ebird_locations only
const X_NEG = "L99771006"; // hotspotInfo with isHotspot false
const X_REPORTED = "L99771007"; // failed hotspot load, no evidence
// Map fixtures (open Pacific, where no real hotspot is loaded).
const M_IN = "L99772001"; // (10, -179.9): ~13.6 mi across the antimeridian
const M_NEAR = "L99772002"; // (10, 179.0): ~61 mi
const M_FAR = "L99772003"; // (10, 0)
const M_LISTNOCOORD = "L99772004"; // verified, no coordinates
const M_LOADEDNOCOORD = "L99772005"; // verified by loaded row, no coordinates
const M_REPORTED = "L99772006"; // failed load, near the centre, unverified
const M_OBSONLY = "L99772007"; // ebird_locations only, near the centre
const M_UNLOADEDCOUNTY = "L99772008"; // verified, ancestry names an unloaded county
const M_REGION = "L99772009"; // verified, ancestry names a region with nothing loaded
const CENTER = { lat: 10, lng: 179.9 };
const NEMO = { lat: -48.87, lng: -123.39 };

const PAGED = Array.from({ length: 120 }, (_, i) => `L99773${String(i).padStart(3, "0")}`);
const CACHE_KEYS = [
  "hotspotsRegion:ZZ-DISC-A",
  "hotspotsRegion:ZZ-DISC-B",
  "hotspotsRegion:ZZ-DISC-P",
  `hotspotInfo:${H_INFO}`,
  `hotspotInfo:${X_NEG}`,
];
const FF = [COUNTY, H_LOADED, H_BOTH, M_LOADEDNOCOORD];
const ATTEMPTS = [COUNTY_FAILED, X_REPORTED, H_FAILED, M_REPORTED];
const ELOCS = [H_LOADED, H_BOTH, X_OBS, M_OBSONLY, M_REPORTED];

let emptyRegion: { code: string; country: string } | null = null;

async function cache(key: string, payload: unknown) {
  await query(
    `INSERT INTO ebird_cache (cache_key, payload, fetched_at) VALUES ($1, $2::jsonb, now())`,
    [key, JSON.stringify(payload)],
  );
}
async function fetchRow(code: string, kind: "region" | "hotspot", name: string, region: string | null, years: [number, number] = [2016, 2025]) {
  await query(
    `INSERT INTO frequency_fetch (loc_code,loc_kind,loc_name,begin_year,end_year,sample_sizes,n_species,region_code)
     VALUES ($1,$2,$3,$4,$5,$6,12,$7)`,
    [code, kind, name, years[0], years[1], Array(48).fill(10), region],
  );
}
async function attempt(code: string, kind: "region" | "hotspot", name: string, region: string | null, error: string) {
  await query(
    `INSERT INTO frequency_fetch_attempts (loc_code,last_attempt_at,status,error,loc_kind,loc_name,region_code)
     VALUES ($1, now(), 'error', $2, $3, $4, $5)`,
    [code, error, kind, name, region],
  );
}
const entry = (id: string, name: string, lat: number | null, lng: number | null, s1: string | null, s2: string | null) => ({
  locId: id, locName: name, ...(lat != null ? { lat } : {}), ...(lng != null ? { lng } : {}),
  countryCode: "US", ...(s1 ? { subnational1Code: s1 } : {}), ...(s2 ? { subnational2Code: s2 } : {}),
  numSpeciesAllTime: 10,
});
const typed = (find: string, page = 1) => hubDiscover({ mode: "typed", find, page });
const map = (lat: number, lng: number, dist: number, page = 1) =>
  hubDiscover({ mode: "map", place: "Fixture Point", lat, lng, dist, page });
const ids = (d: HubDiscovery) => d.results.map((r) => r.id);

describe("Hotspots & data discovery service", () => {
  beforeAll(async () => {
    // A first-level region with nothing loaded, for the "available, not loaded" shape.
    const empty = (
      await query<{ code: string; parent_code: string }>(
        `SELECT code, parent_code FROM regions r WHERE level='subnational1'
           AND NOT EXISTS (SELECT 1 FROM frequency_fetch f
             WHERE f.loc_code = r.code OR f.loc_code LIKE r.code||'-%'
                OR f.region_code = r.code OR f.region_code LIKE r.code||'-%')
           AND NOT EXISTS (SELECT 1 FROM frequency_fetch_attempts a
             WHERE a.loc_code = r.code OR a.loc_code LIKE r.code||'-%'
                OR a.region_code = r.code OR a.region_code LIKE r.code||'-%')
         ORDER BY code LIMIT 1`,
      )
    ).rows[0];
    emptyRegion = empty ? { code: empty.code, country: empty.parent_code } : null;

    await fetchRow(COUNTY, "region", "Zqsarasota", STATE);
    await fetchRow(H_LOADED, "hotspot", "Zqdisc Loaded Only", COUNTY);
    await fetchRow(H_BOTH, "hotspot", "Zqdisc Old Loaded Name", COUNTY, [2010, 2019]); // outdated
    await fetchRow(M_LOADEDNOCOORD, "hotspot", "Zqmap Loaded No Coordinates", null);
    await attempt(COUNTY_FAILED, "region", "Zqdisc Failed Equivalent", STATE, "http 500");
    await attempt(X_REPORTED, "hotspot", "Zqdisc Failed Reported", COUNTY, "eBird timeout");
    await attempt(H_FAILED, "hotspot", "Zqdisc Verified But Failed", COUNTY, "http 502");
    await attempt(M_REPORTED, "hotspot", "Zqmap Reported Near Centre", null, "timeout");
    // Coordinates for loaded/observation-only rows come from ebird_locations.
    for (const [id, name, lat, lng] of [
      [H_LOADED, "Zqdisc Loaded Only", 27.5, -82.5],
      [H_BOTH, "Zqdisc Both", 27.6, -82.6],
      [X_OBS, "Zqdisc Observation Only", 27.7, -82.7],
      [M_OBSONLY, "Zqmap Observation Only", 10, 179.9],
      [M_REPORTED, "Zqmap Reported Near Centre", 10, 179.95],
    ] as const)
      await query(`INSERT INTO ebird_locations (loc_id,loc_name,lat,lng) VALUES ($1,$2,$3,$4)`, [id, name, lat, lng]);

    await cache("hotspotsRegion:ZZ-DISC-A", [
      entry(H_LIST, "Zqdisc List Only", 27.8, -82.8, STATE, COUNTY),
      entry(H_BOTH, "Zqdisc Both", 27.6, -82.6, STATE, COUNTY),
      entry(H_FAILED, "Zqdisc Verified But Failed", 27.9, -82.9, STATE, COUNTY),
      { locName: "No locId here", lat: 1, lng: 1 },
      { locId: "not-an-id", locName: "Bad id", lat: 1, lng: 1 },
    ]);
    await cache(`hotspotInfo:${H_INFO}`, {
      locId: H_INFO, name: "Zqdisc Info Only", latitude: 28.1, longitude: -82.1,
      isHotspot: true, subnational1Code: STATE, subnational2Code: COUNTY,
    });
    await cache(`hotspotInfo:${X_NEG}`, {
      locId: X_NEG, name: "Zqdisc Negative Info", latitude: 28.2, longitude: -82.2, isHotspot: false,
    });
    await cache("hotspotsRegion:ZZ-DISC-B", [
      entry(M_IN, "Zqmap West Of Line", 10, -179.9, STATE, COUNTY),
      entry(M_NEAR, "Zqmap East Of Line", 10, 179.0, STATE, COUNTY),
      entry(M_FAR, "Zqmap Far Side", 10, 0, STATE, COUNTY),
      entry(M_LISTNOCOORD, "Zqmap List No Coordinates", null, null, STATE, COUNTY),
      entry(M_UNLOADEDCOUNTY, "Zqmap Unloaded County", 10, 179.85, STATE, COUNTY_UNLOADED),
      ...(emptyRegion
        ? [{ ...entry(M_REGION, "Zqmap Unloaded Region", 10, 179.8, emptyRegion.code, null), countryCode: emptyRegion.country }]
        : []),
    ]);
    await cache(
      "hotspotsRegion:ZZ-DISC-P",
      PAGED.map((id, i) => entry(id, `Zqpage ${String(i).padStart(3, "0")}`, 15 + i / 1000, -170, STATE, COUNTY)),
    );
  });

  afterAll(async () => {
    await query("DELETE FROM ebird_cache WHERE cache_key = ANY($1)", [CACHE_KEYS]);
    await query("DELETE FROM frequency_fetch_attempts WHERE loc_code = ANY($1)", [ATTEMPTS]);
    await query("DELETE FROM frequency_fetch WHERE loc_code = ANY($1)", [FF]);
    await query("DELETE FROM ebird_locations WHERE loc_id = ANY($1)", [ELOCS]);
  });

  describe("typed search: identities, evidence and ordering", () => {
    it("puts an exact code first for reference geography (Florida, Norway) and fixtures alike", async () => {
      const florida = await typed("us-fl");
      expect(florida.results[0]).toMatchObject({ id: "US-FL", type: "region", name: "Florida", context: "United States", loadState: expect.stringMatching(/current|outdated/) });
      const norway = await typed("NO");
      expect(norway.results[0]).toMatchObject({ id: "NO", type: "country", name: "Norway", context: "" });
      const county = await typed(COUNTY);
      expect(county.results[0]).toMatchObject({ id: COUNTY, type: "county", name: "Zqsarasota", context: "Florida, United States", target: { kind: "section", code: COUNTY } });
      const hotspot = await typed(H_LOADED.toLowerCase());
      expect(hotspot.total).toBe(1);
      expect(hotspot.results[0]).toMatchObject({ id: H_LOADED, type: "hotspot", target: { kind: "hotspot", id: H_LOADED } });
    });

    it("orders exact name, then prefix, then contains/context matches, then evidence, name and id", async () => {
      // "Zqsarasota" is the county's exact name; the hotspots inside match only by context.
      const sarasota = await typed("zqsarasota");
      expect(sarasota.results[0]).toMatchObject({ id: COUNTY, type: "county" });
      const context = sarasota.results.slice(1);
      expect(context.length).toBeGreaterThan(0);
      expect(context.every((r) => r.type === "hotspot" || r.type === "reported" || r.type === "county")).toBe(true);
      // Prefix beats contains: "Zqdisc" prefixes several names, "Loaded Only" only contains.
      const prefix = await typed("zqdisc");
      const loadedNames = prefix.results
        .filter((r) => r.loadState === "current" || r.loadState === "outdated")
        .map((r) => r.name);
      expect(loadedNames.length).toBeGreaterThan(1);
      expect(loadedNames).toEqual([...loadedNames].sort((a, b) => a.localeCompare(b)));
      // Deterministic: the same query yields the identical page.
      expect(ids(await typed("zqdisc"))).toEqual(ids(prefix));
      // Loaded/verified evidence ranks ahead of failed/unverified at equal match quality.
      const order = prefix.results.map((r) => r.loadState);
      const firstFailed = order.findIndex((s) => s === "failed" || s === "unverified");
      const lastLoaded = order.map((s, i) => (s === "current" || s === "outdated" ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
      expect(firstFailed).toBeGreaterThan(-1);
      expect(lastLoaded).toBeLessThan(firstFailed);
    });

    it("folds case, accents and whitespace when matching, and preserves the submitted text", async () => {
      const a = await typed("  ZQDISC   list  only ");
      expect(ids(a)).toEqual([H_LIST]);
      expect(a.find).toBe("  ZQDISC   list  only ");
      expect((await typed("Zqdïsc List Only")).total).toBe(1);
    });

    it("verifies a hotspot from each accepted evidence source and deduplicates by exact ID", async () => {
      const loaded = (await typed(H_LOADED)).results[0];
      expect(loaded.evidence).toEqual(["verified eBird hotspot", "loaded hotspot row"]);
      const list = (await typed(H_LIST)).results[0];
      expect(list).toMatchObject({ type: "hotspot", loadState: "available-not-loaded", row: null });
      expect(list.evidence).toEqual(["verified eBird hotspot", "official hotspot list"]);
      expect(list.context).toBe("Zqsarasota, Florida, United States");
      const info = (await typed(H_INFO)).results[0];
      expect(info).toMatchObject({ type: "hotspot", name: "Zqdisc Info Only", lat: 28.1, lng: -82.1 });
      expect(info.evidence).toEqual(["verified eBird hotspot", "official hotspot information"]);
      const both = await typed(H_BOTH);
      expect(both.total).toBe(1);
      expect(both.results[0].evidence).toEqual(["verified eBird hotspot", "loaded hotspot row", "official hotspot list"]);
      expect(both.results[0]).toMatchObject({ name: "Zqdisc Both", loadState: "outdated" }); // list name wins; row is old
      expect((await typed("zqdisc")).results.filter((r) => r.id === H_BOTH)).toHaveLength(1);
    });

    it("never promotes an observation-only, name-only, negative-info or malformed entry to a hotspot", async () => {
      for (const id of [X_OBS, X_NEG, "not-an-id"]) expect((await typed(id)).total, id).toBe(0);
      expect((await typed("Zqdisc Observation Only")).total).toBe(0);
      expect((await typed("Zqdisc Negative Info")).total).toBe(0);
      expect((await typed("Bad id")).results.filter((r) => r.type === "hotspot" && r.name === "Bad id")).toEqual([]);
      const zqdisc = await typed("zqdisc");
      expect(zqdisc.results.some((r) => r.id === X_OBS || r.id === X_NEG)).toBe(false);
    });

    it("keeps a failed, evidence-free hotspot as a reported location that stays unverified through selection", async () => {
      const reported = (await typed(X_REPORTED)).results[0];
      expect(reported).toMatchObject({
        id: X_REPORTED, type: "reported", loadState: "unverified", error: "eBird timeout",
        evidence: ["reported location — hotspot status unverified"],
        // The existing failed-load recovery row, never a hotspot page.
        target: { kind: "failed", code: X_REPORTED },
      });
      expect(reported.context).toBe("Zqsarasota, Florida, United States");
      expect(reported.lat).toBeNull();
      expect(JSON.stringify(reported.target)).not.toContain("hotspot");
      // A verified hotspot whose last load failed stays verified, with a failed state.
      const failedVerified = (await typed(H_FAILED)).results[0];
      expect(failedVerified).toMatchObject({ type: "hotspot", loadState: "failed", error: "http 502" });
      // A county whose load failed is not treated as a loaded county.
      const failedCounty = (await typed(COUNTY_FAILED)).results[0];
      expect(failedCounty).toMatchObject({ type: "county", loadState: "failed", target: { kind: "failed", code: COUNTY_FAILED }, evidence: ["failed load — county not loaded"] });
    });

    it("reports load states and selection targets for reference geography", async () => {
      const florida = (await typed("US-FL")).results[0];
      expect(florida.target).toEqual({ kind: "section", code: "US-FL" });
      expect(florida.loadedBeneath).toBeGreaterThan(0);
      if (!emptyRegion) return;
      const empty = (await typed(emptyRegion.code)).results[0];
      expect(empty).toMatchObject({ id: emptyRegion.code, type: "region", loadState: "available-not-loaded", loadedBeneath: 0 });
      expect(empty.target).toEqual({ kind: "load", country: emptyRegion.country, region: emptyRegion.code });
      // A whole country with rows recorded beneath it opens its section.
      expect((await typed("US")).results[0]).toMatchObject({ id: "US", type: "country", target: { kind: "section", code: "US" } });
    });

    it("a country or region with nothing loaded targets the existing Load workflow (hand-built evidence)", () => {
      const ref = (code: string, name: string, level: "country" | "subnational1", parent: string | null) => ({ code, name, level, parent, lat: 0, lon: 0, box: null });
      const evidence = (over: Partial<Evidence> = {}): Evidence => {
        const reference = [ref("QQ", "Fixtureland", "country", null), ref("QQ-A", "Alpha", "subnational1", "QQ")];
        return {
          loaded: new Map(), attempts: new Map(), refByCode: new Map(reference.map((r) => [r.code, r])),
          reference, hotspots: new Map(), beneath: new Map(), ...over,
        } as Evidence;
      };
      const by = (c: ReturnType<typeof buildCandidates>, id: string) => c.find((x) => x.id === id)!;
      // Nothing loaded anywhere: both are available, and select the Load workflow.
      const none = buildCandidates(evidence());
      expect(by(none, "QQ")).toMatchObject({ type: "country", loadState: "available-not-loaded", loadedBeneath: 0, target: { kind: "load", country: "QQ", region: null } });
      expect(by(none, "QQ-A")).toMatchObject({ type: "region", loadState: "available-not-loaded", target: { kind: "load", country: "QQ", region: "QQ-A" } });
      // A failed attempt is reported as failed but is still not a section to open.
      const failed = buildCandidates(evidence({ attempts: new Map([["QQ", { loc_code: "QQ", loc_kind: "region", loc_name: null, region_code: null, error: "http 500" }]]) as Evidence["attempts"] }));
      expect(by(failed, "QQ")).toMatchObject({ loadState: "failed", error: "http 500", target: { kind: "load", country: "QQ", region: null } });
      // Loaded rows recorded beneath it make it an existing section, even without its own row.
      const beneath = buildCandidates(evidence({ beneath: new Map([["QQ", 3]]) }));
      expect(by(beneath, "QQ")).toMatchObject({ loadState: "available-not-loaded", loadedBeneath: 3, target: { kind: "section", code: "QQ" } });
      // Its own row makes it current.
      const row = { loc_code: "QQ", loc_kind: "region", loc_name: "Fixtureland", region_code: null, begin_year: 2000, end_year: 9999, n_species: 5 };
      const own = buildCandidates(evidence({ loaded: new Map([["QQ", row]]) as Evidence["loaded"] }));
      expect(by(own, "QQ")).toMatchObject({ loadState: "current", target: { kind: "section", code: "QQ" } });
    });

    it("preserves the submitted text for display while searching on the normalized text", async () => {
      const d = await hubDiscover({ mode: "typed", find: "zqdisc list only", submitted: "  ZQDISC   list  only ", page: 1 });
      expect(d).toMatchObject({ find: "zqdisc list only", submitted: "  ZQDISC   list  only ", total: 1 });
      expect((await typed("zqdisc list only")).submitted).toBe("zqdisc list only");
    });

    it("finds which failed ids have affirmative hotspot evidence, from lists and strict info only", async () => {
      const verified = await verifiedHotspotIdsAmong([H_LIST, H_INFO, H_FAILED, X_REPORTED, X_OBS, X_NEG, "not-an-id"]);
      expect([...verified].sort()).toEqual([H_FAILED, H_INFO, H_LIST].sort());
      expect((await verifiedHotspotIdsAmong([])).size).toBe(0);
    });

    it("answers a too-short search with a message, not a flood, and a zero match honestly", async () => {
      const short = await typed("z");
      expect(short).toMatchObject({ tooShort: true, total: 0, results: [], page: 1 });
      const none = await typed("qqqqxxxxnomatch");
      expect(none).toMatchObject({ tooShort: false, total: 0, pageCount: 1, first: 0, last: 0, results: [] });
    });
  });

  describe("complete result access", () => {
    it("pages 50 at a time with an exact total, no silent cap, and every match reachable once", async () => {
      const first = await typed("zqpage");
      expect(HUB_PAGE_SIZE).toBe(50);
      expect(first).toMatchObject({ total: 120, pageCount: 3, page: 1, first: 1, last: 50, pageSize: 50 });
      expect(first.counts.hotspot).toBe(120);
      const second = await typed("zqpage", 2);
      const third = await typed("zqpage", 3);
      expect([first.results.length, second.results.length, third.results.length]).toEqual([50, 50, 20]);
      expect([second.first, second.last, third.first, third.last]).toEqual([51, 100, 101, 120]);
      const all = [...ids(first), ...ids(second), ...ids(third)];
      expect(new Set(all).size).toBe(120);
      expect([...all].sort()).toEqual([...PAGED].sort());
      // Deterministic order: by name at equal match quality.
      expect(all).toEqual([...PAGED]);
    });

    it("rejects a page past the end with a 404 rather than an empty page", async () => {
      await expect(typed("zqpage", 4)).rejects.toMatchObject({ status: 404 });
      await expect(typed("qqqqxxxxnomatch", 2)).rejects.toMatchObject({ status: 404 });
    });
  });

  describe("map and radius", () => {
    it("includes only coordinate-known verified hotspots inside the circle, across the antimeridian", async () => {
      const d = await map(CENTER.lat, CENTER.lng, 25);
      // Fixtures nearby: M_IN (13.6 mi, verified), M_UNLOADEDCOUNTY (0.9° ≈ 3 mi), M_REGION.
      expect(ids(d)).toContain(M_IN);
      expect(ids(d)).not.toContain(M_NEAR); // ~61 mi
      expect(ids(d)).not.toContain(M_FAR);
      expect(d.results.every((r) => r.type === "hotspot")).toBe(true);
      expect(d.results.every((r) => r.distanceMiles != null && r.distanceMiles <= 25)).toBe(true);
      // Sorted nearest first, with a stable tie-break.
      const miles = d.results.map((r) => r.distanceMiles!);
      expect(miles).toEqual([...miles].sort((a, b) => a - b));
      expect(d).toMatchObject({ mode: "map", find: null, tooShort: false });
      expect(d.map).toMatchObject({ place: "Fixture Point", lat: 10, lng: 179.9, dist: 25 });
    });

    it("grows with the radius and measures in both directions across 180 degrees", async () => {
      const wide = await map(CENTER.lat, CENTER.lng, 100);
      expect(ids(wide)).toEqual(expect.arrayContaining([M_IN, M_NEAR]));
      expect(ids(wide)).not.toContain(M_FAR);
      const west = await map(10, -179.9, 100);
      expect(ids(west)).toEqual(expect.arrayContaining([M_IN, M_NEAR]));
      const tight = await map(CENTER.lat, CENTER.lng, 13);
      const wideOne = await map(CENTER.lat, CENTER.lng, 14);
      expect(ids(tight)).not.toContain(M_IN);
      expect(ids(wideOne)).toContain(M_IN);
    });

    it("excludes unverified, observation-only and coordinate-missing rows, and discloses the unmeasured ones", async () => {
      const d = await map(CENTER.lat, CENTER.lng, 200);
      for (const excluded of [M_REPORTED, M_OBSONLY, M_LISTNOCOORD, M_LOADEDNOCOORD, X_REPORTED, X_OBS])
        expect(ids(d), excluded).not.toContain(excluded);
      // The two verified-but-coordinate-missing fixtures are counted as unmeasured.
      expect(d.map!.unevaluable).toBeGreaterThanOrEqual(2);
      const before = d.map!.unevaluable;
      await query(`DELETE FROM frequency_fetch WHERE loc_code = $1`, [M_LOADEDNOCOORD]);
      const after = await map(CENTER.lat, CENTER.lng, 200);
      expect(after.map!.unevaluable).toBe(before - 1);
      await fetchRow(M_LOADEDNOCOORD, "hotspot", "Zqmap Loaded No Coordinates", null);
    });

    it("reports unavailable coverage, never zero birds, when nothing verified lies in the circle", async () => {
      const d = await map(NEMO.lat, NEMO.lng, 25);
      expect(d).toMatchObject({ total: 0, results: [], first: 0, last: 0, pageCount: 1 });
      expect(d.summary).toEqual({ countries: [], regions: [], counties: [] });
      expect(d.map!.evaluated).toBeGreaterThan(0);
    });

    it("summarizes areas only from nearby verified hotspots' recorded ancestry, never claiming containment", async () => {
      const d = await map(CENTER.lat, CENTER.lng, 100);
      const s = d.summary!;
      expect(s.countries.map((a) => a.code)).toContain("US");
      expect(s.regions.map((a) => a.code)).toContain(STATE);
      // The loaded county is named; the one that is only a list ancestry code is not.
      expect(s.counties.map((a) => a.code)).toContain(COUNTY);
      expect(s.counties.map((a) => a.code)).not.toContain(COUNTY_UNLOADED);
      const county = s.counties.find((a) => a.code === COUNTY)!;
      expect(county).toMatchObject({ name: "Zqsarasota", type: "county", target: { kind: "section", code: COUNTY } });
      expect(county.hotspots).toBe(2); // M_IN and M_NEAR
      // A summary adds no whole-area rows to the radius result.
      expect(d.results.every((r) => r.type === "hotspot")).toBe(true);
      if (emptyRegion) {
        const region = s.regions.find((a) => a.code === emptyRegion!.code);
        expect(region).toMatchObject({ target: { kind: "load", country: emptyRegion.country, region: emptyRegion.code } });
      }
    });

    it("pages map results with the same exact-total contract", async () => {
      const d = await map(15.06, -170, 200); // the 120 paged fixtures sit on lat 15..15.12, lng -170
      expect(d.total).toBe(120);
      expect(d.pageCount).toBe(3);
      const third = await map(15.06, -170, 200, 3);
      expect(third.results).toHaveLength(20);
      await expect(map(15.06, -170, 200, 4)).rejects.toMatchObject({ status: 404 });
    });
  });

  describe("discovery is read-only", () => {
    // The statement-level proof (every SQL statement recorded and read-only) lives in
    // hub-discovery-readonly.test.ts: comparing global row counts here would race with
    // other suites' fixtures, which run in parallel against the same database.
    it("has no write, job, or eBird client in the service, API or contract sources", () => {
      for (const file of ["src/lib/server/hub-discovery.ts", "src/routes/api/hub-search/+server.ts", "src/lib/hub-discovery.ts"]) {
        const source = readFileSync(file, "utf8");
        expect(source, file).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b\s+(INTO|FROM)?/i);
        expect(source, file).not.toMatch(/enqueueJob|withTransaction|\$server\/ebird["']|\$server\/jobs|fetch\(/);
      }
    });
  });
});

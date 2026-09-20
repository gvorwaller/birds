import { randomUUID } from "node:crypto";
import { isRedirect } from "@sveltejs/kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { query } from "$lib/db";
import { haversineKm, MILES_TO_KM } from "$lib/geo";
import { GUIDE_LEVELS, guideLocationPairs, guideWasPairs, parseGuideLocation, type GuideLevel } from "$lib/guide-location";
import {
  guideCounties,
  guideHotspots,
  guideLocationCoverage,
  resolveGuideLocation,
} from "$server/guide-location";
import { setSpecialInterest } from "$server/special-interest";
import { recordSpeciesView } from "$server/species-views";
import { load } from "./+page.server";

/**
 * Phase 8A (td-82fbc1): county, verified-hotspot and map/radius selection.
 * Every row is seeded here under reserved codes and removed afterwards, so the
 * assertions are exact and never depend on mutable production-copy totals.
 */
const dbUp = await query("SELECT 1")
  .then(() => true)
  .catch(() => false);

const STATE = "US-FL";
const CA = "US-FL-901"; // county A: whole-area row + two hotspots
const CB = "US-FL-902"; // sibling county
const CC = "US-FL-904"; // pagination county
const UNLOADED = "US-FL-903";
const HA1 = "L99887201";
const HA2 = "L99887202";
const HB1 = "L99887203";
const HC = "L99887231";
const HX = "L99887241"; // distractor species live here, outside every fixture county
// Map fixtures sit in open Pacific ocean where no real hotspot is loaded.
const CENTER = { lat: 10, lng: 179.9 };
const M_IN = "L99887211"; // (10, -179.9): ~13.6 mi across the antimeridian
const M_NEAR = "L99887212"; // (10, 179.0): ~61 mi
const M_FAR = "L99887213"; // (10, 0)
const M_NOCOORD = "L99887214"; // loaded, but no ebird_locations row
const M_UNLOADED = "L99887215"; // coordinates, but never loaded
const NEMO = { lat: -48.87, lng: -123.39 }; // Point Nemo: nothing loaded

const S = (n: string) => `g8s${n}`;
const SPECIES = {
  AR: S("ar"), // county A whole-area source only
  A1: S("a1"), // HA1 + county A row
  A2: S("a2"), // HA2
  A3: S("a3"), // HA1 only
  B1: S("b1"), // county B
  MI: S("mi"),
  MN: S("mn"),
  MF: S("mf"),
  NC: S("nc"),
  UL: S("ul"),
};
// Paging uses 105 EXISTING taxonomy species (no taxonomy rows are created for
// them) plus a few fixture species that carry the personal-state assertions.
const PG_FIX = Array.from({ length: 7 }, (_, i) => `g8pf${i}`);
let PAGED_REAL: string[] = [];
let OUTSIDE_REAL: string[] = [];
const FIXTURE_SPECIES = [...Object.values(SPECIES), ...PG_FIX];
const LOCS = [CA, CB, CC, HA1, HA2, HB1, HC, HX, M_IN, M_NEAR, M_FAR, M_NOCOORD];
const ELOCS = [M_IN, M_NEAR, M_FAR, M_UNLOADED];

let uid: number;
let emptyState: string | null = null;
let componentCounty = "";
const users: number[] = [];

function event(path: string, userId = uid) {
  return {
    locals: { scopeId: userId, user: { id: userId } },
    depends: () => {},
    url: new URL(`http://localhost${path}`),
  } as unknown as Parameters<typeof load>[0];
}
async function run(path: string, userId = uid) {
  return (await load(event(path, userId))) as any;
}
const codesOf = (data: any) => data.results.map((r: { species_code: string }) => r.species_code).sort();

async function fetchRow(
  code: string,
  kind: "region" | "hotspot",
  name: string,
  region: string | null,
  years: [number, number] = [2016, 2025],
) {
  await query(
    `INSERT INTO frequency_fetch
     (loc_code,loc_kind,loc_name,begin_year,end_year,sample_sizes,n_species,region_code)
     VALUES ($1,$2,$3,$4,$5,$6,1,$7)`,
    [code, kind, name, years[0], years[1], Array(48).fill(10), region],
  );
}
async function freq(loc: string, ...codes: string[]) {
  for (const code of codes)
    await query(
      `INSERT INTO species_month_freq (loc_code,species_code,month,num) VALUES ($1,$2,6,3)`,
      [loc, code],
    );
}

describe.runIf(dbUp)("Field Guide county, hotspot and map/radius selection", () => {
  beforeAll(async () => {
    uid = (
      await query<{ id: number }>("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1")
    ).rows[0].id;
    const real = (
      await query<{ species_code: string }>(
        `SELECT species_code FROM taxonomy_cache
          WHERE category='species' AND species_code NOT LIKE 'g8%'
          ORDER BY species_code LIMIT 135`,
      )
    ).rows.map((r) => r.species_code);
    if (real.length !== 135) throw Error("Requires 135 real taxonomy species");
    PAGED_REAL = real.slice(0, 105);
    OUTSIDE_REAL = real.slice(105);
    for (const code of FIXTURE_SPECIES)
      await query(
        `INSERT INTO taxonomy_cache (species_code,com_name,sci_name,category)
         VALUES ($1,$2,$3,'species')`,
        [
          code,
          code.startsWith("g8pf") ? `Aaa Pgtest Marsh ${code}` : `Geography Fixture ${code}`,
          `Testus ${code}`,
        ],
      );

    // County A (whole-area row) and its hotspots; sibling county B; paging county C.
    await fetchRow(CA, "region", "Fixture Equivalent Nine", STATE, [2016, 2025]);
    await fetchRow(CB, "region", "Fixture Sibling Nine", STATE);
    await fetchRow(CC, "region", "Fixture Paging Nine", STATE);
    await fetchRow(HA1, "hotspot", "Dup Fixture Marsh", CA);
    await fetchRow(HA2, "hotspot", "Dup Fixture Marsh", CA, [2014, 2024]);
    await fetchRow(HB1, "hotspot", "Sibling Fixture Marsh", CB);
    await fetchRow(HC, "hotspot", "Paging Fixture Marsh", CC);
    await fetchRow(HX, "hotspot", "Distractor Fixture Marsh", "US-TX-901");
    await freq(CA, SPECIES.AR, SPECIES.A1);
    await freq(HA1, SPECIES.A1, SPECIES.A3);
    await freq(HA2, SPECIES.A2);
    await freq(CB, SPECIES.B1);
    await freq(HB1, SPECIES.B1);
    await freq(HC, ...PAGED_REAL, ...PG_FIX);
    await freq(HX, ...OUTSIDE_REAL);

    // Map fixtures.
    for (const [id, lat, lng, name] of [
      [M_IN, 10, -179.9, "Antimeridian West Fixture"],
      [M_NEAR, 10, 179.0, "Antimeridian East Fixture"],
      [M_FAR, 10, 0, "Far Fixture"],
      [M_UNLOADED, 10, 179.95, "Unloaded Fixture"],
    ] as const)
      await query(
        `INSERT INTO ebird_locations (loc_id,loc_name,lat,lng) VALUES ($1,$2,$3,$4)`,
        [id, name, lat, lng],
      );
    for (const id of [M_IN, M_NEAR, M_FAR, M_NOCOORD])
      await fetchRow(id, "hotspot", `Map fixture ${id}`, null, id === M_NEAR ? [2012, 2022] : [2016, 2025]);
    await freq(M_IN, SPECIES.MI);
    await freq(M_NEAR, SPECIES.MN);
    await freq(M_FAR, SPECIES.MF);
    await freq(M_NOCOORD, SPECIES.NC);

    // A state with nothing loaded, to build a component-only fixture.
    emptyState =
      (
        await query<{ code: string }>(
          `SELECT code FROM regions r WHERE level='subnational1'
             AND NOT EXISTS (SELECT 1 FROM frequency_fetch f
               WHERE f.loc_code = r.code OR f.loc_code LIKE r.code||'-%'
                  OR f.region_code = r.code OR f.region_code LIKE r.code||'-%')
           ORDER BY code LIMIT 1`,
        )
      ).rows[0]?.code ?? null;
    if (emptyState) {
      componentCounty = `${emptyState}-901`;
      LOCS.push(componentCounty);
      await fetchRow(componentCounty, "region", "Component Fixture", emptyState);
      await freq(componentCounty, SPECIES.UL);
    }

    // Personal state for the pagination user.
    const user = (
      await query<{ id: number }>(
        "INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Geography QA','!unset','user') RETURNING id",
        ["geo-" + randomUUID()],
      )
    ).rows[0].id;
    users.push(user);
    await query("INSERT INTO seen_species(user_id,species_code) VALUES($1,$2)", [user, PG_FIX[3]]);
    await setSpecialInterest(user, PG_FIX[4], true);
    await recordSpeciesView(user, PG_FIX[5], randomUUID());
    await query(
      `INSERT INTO species_media
       (species_code,kind,rank,provider,provider_id,media_url,thumbnail_url,source_url,creator,license_code,license_url)
       VALUES ($1,'photo',1,'wikimedia_commons','geo-test','https://example.org/o.jpg',
       'https://example.org/t.jpg','https://example.org/s','Geo photographer','CC BY 4.0','https://example.org/l')`,
      [PG_FIX[6]],
    );
  });

  afterAll(async () => {
    await query("DELETE FROM species_media WHERE species_code=ANY($1)", [FIXTURE_SPECIES]);
    // The throwaway user owns every personal row; deleting it cascades them.
    await query("DELETE FROM users WHERE id=ANY($1::int[])", [users]);
    await query("DELETE FROM species_view_history WHERE species_code=ANY($1)", [FIXTURE_SPECIES]);
    await query("DELETE FROM species_special_interest WHERE species_code=ANY($1)", [FIXTURE_SPECIES]);
    await query("DELETE FROM seen_species WHERE species_code=ANY($1)", [FIXTURE_SPECIES]);
    await query("DELETE FROM frequency_fetch WHERE loc_code=ANY($1)", [LOCS]);
    await query("DELETE FROM ebird_locations WHERE loc_id=ANY($1)", [ELOCS]);
    await query("DELETE FROM taxonomy_cache WHERE species_code=ANY($1)", [FIXTURE_SPECIES]);
  });

  describe("county and hotspot identity", () => {
    it("county coverage is the exact county row plus its recorded hotspots, never a sibling", async () => {
      const coverage = await guideLocationCoverage(CA);
      expect([...coverage.locCodes].sort()).toEqual([CA, HA1, HA2].sort());
      expect(coverage.wholeArea).toBe(true);
      expect(coverage.beginYear).toBe(2014);
      expect(coverage.endYear).toBe(2025);
      expect(coverage.locCodes).not.toContain(CB);
      expect(coverage.locCodes).not.toContain(HB1);
    });

    it("selecting a county filters the guide to that county's sources and reports its identity", async () => {
      const data = await run(`/species?country=US&region=${STATE}&county=${CA}`);
      expect(codesOf(data)).toEqual([SPECIES.A1, SPECIES.A2, SPECIES.A3, SPECIES.AR].sort());
      expect(data.total).toBe(4);
      expect(data.selection).toEqual({ kind: "county", country: "US", region: STATE, county: CA });
      expect(data.county).toBe(CA);
      expect(data.hotspot).toBe("");
      expect(data.location).toMatchObject({
        kind: "county",
        label: "Fixture Equivalent Nine",
        officialCountyName: false,
        sourceCount: 3,
        wholeArea: true,
        beginYear: 2014,
        endYear: 2025,
        map: null,
      });
      expect(data.active).toBe(true);
    });

    it("selecting a county without ancestry derives it, and the sibling county stays separate", async () => {
      const data = await run(`/species?county=${CB}`);
      expect(data.selection).toMatchObject({ kind: "county", country: "US", region: STATE });
      expect(codesOf(data)).toEqual([SPECIES.B1]);
    });

    it("a hotspot selection is only that exact loaded hotspot, visibly narrower than its county", async () => {
      const data = await run(`/species?country=US&region=${STATE}&county=${CA}&hotspot=${HA1.toLowerCase()}`);
      expect(data.hotspot).toBe(HA1);
      expect(data.selection).toEqual({ kind: "hotspot", country: "US", region: STATE, county: CA, hotspot: HA1 });
      expect(codesOf(data)).toEqual([SPECIES.A1, SPECIES.A3].sort());
      expect(data.location).toMatchObject({
        kind: "hotspot",
        label: "Dup Fixture Marsh",
        sourceCount: 1,
        wholeArea: false,
        beginYear: 2016,
        endYear: 2025,
      });
      const county = await run(`/species?county=${CA}`);
      expect(data.total).toBeLessThan(county.total);
    });

    it("lists every loaded county and hotspot, name-sorted with a stable code tie-break, uncapped", async () => {
      const counties = await guideCounties(STATE);
      const fixture = counties.filter((c) => [CA, CB, CC].includes(c.code));
      expect(fixture.map((c) => c.code)).toEqual([CA, CC, CB]); // Equivalent, Paging, Sibling
      // Every real Florida county row that is loaded is offered; nothing is sampled.
      const loaded = (
        await query<{ n: number }>(
          `SELECT count(*)::int AS n FROM frequency_fetch WHERE loc_kind='region' AND loc_code ~ '^US-FL-[A-Z0-9]+$'`,
        )
      ).rows[0].n;
      expect(counties).toHaveLength(loaded);
      expect(new Set(counties.map((c) => c.code)).size).toBe(loaded);
      expect(await guideHotspots(CA)).toEqual([
        { code: HA1, name: "Dup Fixture Marsh" },
        { code: HA2, name: "Dup Fixture Marsh" },
      ]);
      const data = await run(`/species?county=${CA}`);
      expect(data.counties.map((c: { code: string }) => c.code)).toEqual(counties.map((c) => c.code));
      expect(data.hotspots.map((h: { code: string }) => h.code)).toEqual([HA1, HA2]);
      expect((await run(`/species?region=${STATE}`)).hotspots).toEqual([]);
    });

    it("uses the official county-equivalent label when this exact code is known", async () => {
      const sarasota = await query("SELECT 1 FROM frequency_fetch WHERE loc_code='US-FL-115' AND loc_kind='region'");
      if (sarasota.rowCount === 0) return; // not part of this database
      const resolved = await resolveGuideLocation({ kind: "county", country: "US", region: STATE, county: "US-FL-115" });
      expect(resolved).toMatchObject({ kind: "county", label: "Sarasota County", officialCountyName: true });
    });

    it("rejects unverifiable identities with a 400 instead of guessing", async () => {
      for (const path of [
        `/species?region=${STATE}&county=${UNLOADED}`, // shaped right, never loaded
        `/species?region=US-TX&county=${CA}`, // county belongs to another state
        `/species?country=CA&county=${CA}`,
        `/species?county=${CA}&hotspot=${HB1}`, // hotspot recorded under the sibling
        `/species?county=${CA}&hotspot=L99887299`, // shaped right, never loaded
        `/species?county=${CA}&hotspot=P12345`, // personal location shape
        `/species?county=${CA}&hotspot=${M_NOCOORD}`, // loaded hotspot with no county
        `/species?region=${STATE}&hotspot=${HA1}`, // county omitted
        `/species?county=US-FL`,
        `/species?country=invalid`,
        `/species?region=US-ZZ`,
        `/species?country=CA&region=${STATE}`,
      ])
        await expect(run(path), path).rejects.toMatchObject({ status: 400 });
    });

    it("rejects mixed, incomplete and malformed map URLs before any query", async () => {
      const map = "place=P&lat=10&lng=179.9&dist=25";
      for (const path of [
        `/species?country=US&${map}`,
        `/species?county=${CA}&${map}`,
        `/species?place=P&lat=10&lng=179.9`,
        `/species?place=P&lat=10&dist=25`,
        `/species?lat=10&lng=179.9&dist=25`,
        `/species?place=P&lat=91&lng=0&dist=25`,
        `/species?place=P&lat=10&lng=181&dist=25`,
        `/species?place=P&lat=10&lng=0&dist=0`,
        `/species?place=P&lat=10&lng=0&dist=201`,
        `/species?place=P&lat=10&lng=0&dist=2.5`,
        `/species?place=${"x".repeat(201)}&lat=10&lng=0&dist=5`,
      ])
        await expect(run(path), path).rejects.toMatchObject({ status: 400 });
    });
  });

  describe("map and radius", () => {
    const q = (lat: number, lng: number, dist: number, extra = "") =>
      `/species?place=Fixture+Point&lat=${lat}&lng=${lng}&dist=${dist}${extra}`;

    it("includes only coordinate-known loaded hotspots inside the circle, across the antimeridian", async () => {
      const data = await run(q(CENTER.lat, CENTER.lng, 25));
      expect(data.location).toMatchObject({ kind: "map", sourceCount: 1, wholeArea: false, beginYear: 2016, endYear: 2025 });
      expect(data.selection).toEqual({ kind: "map", place: "Fixture Point", lat: 10, lng: 179.9, dist: 25 });
      expect(data.map).toMatchObject({ place: "Fixture Point", lat: 10, lng: 179.9, dist: 25 });
      expect(data.country).toBe("");
      expect(codesOf(data)).toEqual([SPECIES.MI]);
      expect(data.total).toBe(1);
    });

    it("grows with the explicit radius and reports the honest year range of what it used", async () => {
      const data = await run(q(CENTER.lat, CENTER.lng, 100));
      expect(codesOf(data)).toEqual([SPECIES.MI, SPECIES.MN].sort());
      expect(data.location).toMatchObject({ sourceCount: 2, beginYear: 2012, endYear: 2025 });
      expect(codesOf(await run(q(CENTER.lat, CENTER.lng, 200)))).not.toContain(SPECIES.MF);
    });

    it("never includes unloaded, coordinate-missing, or far hotspots and discloses the unevaluated ones", async () => {
      const data = await run(q(CENTER.lat, CENTER.lng, 200));
      expect(codesOf(data)).not.toContain(SPECIES.NC);
      expect(codesOf(data)).not.toContain(SPECIES.UL);
      expect(data.map.coordinateMissing).toBeGreaterThanOrEqual(1);
      const resolved = await resolveGuideLocation({ kind: "map", place: "P", lat: 10, lng: 179.9, dist: 200 });
      expect(resolved?.locCodes).not.toContain(M_UNLOADED);
      expect(resolved?.locCodes).not.toContain(M_NOCOORD);
      expect(resolved?.locCodes.every((c) => /^L\d+$/.test(c))).toBe(true);
    });

    it("measures great-circle distance in both directions across 180 degrees", async () => {
      const west = await resolveGuideLocation({ kind: "map", place: "P", lat: 10, lng: -179.9, dist: 100 });
      expect(west?.locCodes).toEqual(expect.arrayContaining([M_IN, M_NEAR]));
      expect(west?.locCodes).not.toContain(M_FAR);
      const inside = haversineKm(10, 179.9, 10, -179.9) / MILES_TO_KM;
      expect(inside).toBeGreaterThan(13);
      expect(inside).toBeLessThan(14);
      const tight = await resolveGuideLocation({ kind: "map", place: "P", lat: 10, lng: 179.9, dist: 13 });
      const wide = await resolveGuideLocation({ kind: "map", place: "P", lat: 10, lng: 179.9, dist: 14 });
      expect(tight?.locCodes).not.toContain(M_IN);
      expect(wide?.locCodes).toContain(M_IN);
    });

    it("reports unavailable coverage, never zero birds, when nothing loaded falls in the circle", async () => {
      const data = await run(q(NEMO.lat, NEMO.lng, 25));
      expect(data.location).toMatchObject({ kind: "map", sourceCount: 0, wholeArea: false, beginYear: null, endYear: null });
      expect(data.results).toEqual([]);
      expect(data.total).toBe(0);
      expect(data.active).toBe(true);
    });

    it("does not select on the map view, a region centroid, or a saved radius", async () => {
      // Only frequency sources with same-ID coordinates count: the county rows
      // and hotspots seeded above have no coordinates and stay out of any circle.
      const resolved = await resolveGuideLocation({ kind: "map", place: "P", lat: 27.5, lng: -82, dist: 1 });
      for (const code of [CA, CB, CC, HA1, HA2, HB1, HC, M_NOCOORD])
        expect(resolved?.locCodes).not.toContain(code);
      await expect(run(`/species?place=P&lat=10&lng=179.9`)).rejects.toMatchObject({ status: 400 });
    });
  });

  describe("coverage shapes", () => {
    it("state selection with only county sources is component-only", async () => {
      if (!emptyState) return;
      const coverage = await guideLocationCoverage(emptyState);
      expect(coverage.locCodes).toEqual([componentCounty]);
      expect(coverage.wholeArea).toBe(false);
      // The county row is a whole-area source for the county, never for its
      // state: through the loader the state reads as component-only.
      const state = await run(`/species?region=${emptyState}`);
      expect(state.location).toMatchObject({ kind: "region", sourceCount: 1, wholeArea: false });
      expect(codesOf(state)).toEqual([SPECIES.UL]);
      const county = await run(`/species?county=${componentCounty}`);
      expect(county.location).toMatchObject({ kind: "county", sourceCount: 1, wholeArea: true });
    });

    it("a valid state with no loaded sources is unavailable rather than an empty answer", async () => {
      const none = (
        await query<{ code: string }>(
          `SELECT code FROM regions r WHERE level='subnational1'
             AND code <> ALL($1::text[])
             AND NOT EXISTS (SELECT 1 FROM frequency_fetch f
               WHERE f.loc_code = r.code OR f.loc_code LIKE r.code||'-%'
                  OR f.region_code = r.code OR f.region_code LIKE r.code||'-%')
           ORDER BY code DESC LIMIT 1`,
          [[emptyState ?? ""]],
        )
      ).rows[0]?.code;
      if (!none) return;
      const data = await run(`/species?region=${none}`);
      expect(data.location).toMatchObject({ sourceCount: 0, wholeArea: false, beginYear: null, endYear: null });
      expect(data.results).toEqual([]);
      expect(data.counties).toEqual([]);
    });
  });

  describe("results, pagination and personal state", () => {
    let user: number;
    beforeAll(() => {
      user = users[0];
    });

    it("intersects the location before pagination and keeps the complete count and next/previous links", async () => {
      const TOTAL = PAGED_REAL.length + PG_FIX.length; // 112
      const first = await run(`/species?county=${CC}&sort=name&future=kept`, user);
      expect(first.total).toBe(TOTAL);
      expect(first.results).toHaveLength(100);
      expect(first.previous).toBeNull();
      expect(first.next).toContain("county=US-FL-904");
      expect(first.next).toContain("future=kept");
      expect(first.next).toContain("page=2");
      expect(first.next.endsWith("#results")).toBe(true);

      const second = await run(`/species?county=${CC}&sort=name&future=kept&page=2`, user);
      expect(second.total).toBe(TOTAL);
      expect(second.results).toHaveLength(TOTAL - 100);
      expect(second.next).toBeNull();
      expect(second.previous).toContain("county=US-FL-904");
      expect(second.previous).toContain("page=1");
      const seen = new Set([...first.results, ...second.results].map((r: { species_code: string }) => r.species_code));
      expect(seen.size).toBe(TOTAL);
      // Species that only occur outside the county never displace or join the page.
      for (const code of OUTSIDE_REAL) expect(seen.has(code), code).toBe(false);
      for (const code of [...PAGED_REAL, ...PG_FIX]) expect(seen.has(code), code).toBe(true);
    });

    it("the same location keeps Seen/Need, Viewed, Special interest, thumbnails and provenance", async () => {
      const data = await run(`/species?county=${CC}&sort=name&q=Pgtest`, user);
      expect(data.total).toBe(PG_FIX.length);
      const byCode = new Map<string, any>(data.results.map((r: any) => [r.species_code, r]));
      expect(byCode.get(PG_FIX[3]).seen).toBe(true);
      expect(byCode.get(PG_FIX[2]).seen).toBe(false);
      expect(data.interests).toContain(PG_FIX[4]);
      expect(Object.keys(data.viewed)).toContain(PG_FIX[5]);
      expect(byCode.get(PG_FIX[6]).photo).toEqual({
        url: "https://example.org/t.jpg",
        creator: "Geo photographer",
        sourceUrl: "https://example.org/s",
        licenseCode: "CC BY 4.0",
        licenseUrl: "https://example.org/l",
      });
      expect(byCode.get(PG_FIX[0]).match_provenance).toBe("name_or_code");
      // A location with no text search names no match provenance.
      const locationOnly = await run(`/species?county=${CC}&sort=name`, user);
      expect(locationOnly.results[0].match_provenance).toBeNull();
    });

    it("intersects with the family, tag and interest filters as before", async () => {
      const interestOnly = await run(`/species?county=${CC}&interest=1`, user);
      expect(codesOf(interestOnly)).toEqual([PG_FIX[4]]);
      const noMatch = await run(`/species?county=${CA}&tags=habitat%3Amudflat`, user);
      expect(noMatch.results).toEqual([]);
    });

    it("keeps geography read-only shared data: the same URL gives another account its own personal state", async () => {
      const other = await run(`/species?county=${CC}&sort=name&q=Pgtest`, uid);
      expect(other.results.find((r: any) => r.species_code === PG_FIX[3]).seen).toBe(false);
      expect(other.interests ?? []).not.toContain(PG_FIX[4]);
    });
  });

  describe("native no-JavaScript hierarchy changes", () => {
    const EXTRA = "future=kept&sort=name&q=Geography&tags=habitat%3Amudflat&family=";
    const HOTSPOT = `country=US&region=${STATE}&county=${CA}&hotspot=${HA1}`;
    const COUNTY = `country=US&region=${STATE}&county=${CA}`;

    /**
     * What a browser sends when a reader with JavaScript off changes ONE select
     * and presses Apply filters: the hidden state, the applied ("was") values,
     * then every enabled select at its displayed value. A select is disabled
     * (and so unsent) while the level above it is empty.
     */
    function nativeQuery(applied: string, level: GuideLevel, value: string) {
      const parsed = parseGuideLocation(new URLSearchParams(applied));
      if (!parsed.ok) throw Error(parsed.message);
      const q = new URLSearchParams(EXTRA);
      for (const [name, was] of guideWasPairs(parsed.selection)) q.append(name, was);
      const shown = Object.fromEntries(guideLocationPairs(parsed.selection));
      GUIDE_LEVELS.forEach((l, i) => {
        if (i === 0 || shown[GUIDE_LEVELS[i - 1]]) q.append(l, l === level ? value : (shown[l] ?? ""));
      });
      return `/species?${q}`;
    }
    /** Submits natively: expects the 303 canonicalization, then loads its target. */
    async function change(applied: string, level: GuideLevel, value: string) {
      const err = await run(nativeQuery(applied, level, value)).then(
        () => null,
        (e) => e,
      );
      expect(isRedirect(err), "a native change canonicalizes with a redirect").toBe(true);
      expect(err.status).toBe(303);
      const target = new URL(err.location, "http://localhost");
      expect(target.pathname).toBe("/species");
      expect(target.hash).toBe("#results");
      for (const gone of ["was_country", "was_region", "was_county", "was_hotspot", "page"])
        expect(target.searchParams.has(gone), gone).toBe(false);
      // Every other parameter survives the round trip.
      expect(target.searchParams.get("future")).toBe("kept");
      expect(target.searchParams.get("sort")).toBe("name");
      expect(target.searchParams.get("q")).toBe("Geography");
      expect(target.searchParams.getAll("tags")).toEqual(["habitat:mudflat"]);
      const data = await run(`${target.pathname}${target.search}`);
      return { target, data };
    }
    const geo = (u: URL) => Object.fromEntries(GUIDE_LEVELS.filter((l) => u.searchParams.get(l)).map((l) => [l, u.searchParams.get(l)]));

    it("changing the country from a hotspot or county clears region, county and hotspot", async () => {
      for (const from of [HOTSPOT, COUNTY]) {
        const { target, data } = await change(from, "country", "CA");
        expect(geo(target)).toEqual({ country: "CA" });
        expect(data.selection).toEqual({ kind: "country", country: "CA" });
        expect(data.region).toBe("");
        expect(data.county).toBe("");
        expect(data.hotspot).toBe("");
      }
    });

    it("changing the state or region from a hotspot or county keeps the country, clears county and hotspot", async () => {
      for (const from of [HOTSPOT, COUNTY]) {
        const { target, data } = await change(from, "region", "US-TX");
        expect(geo(target)).toEqual({ country: "US", region: "US-TX" });
        expect(data.selection).toEqual({ kind: "region", country: "US", region: "US-TX" });
      }
    });

    it("changing the county from a hotspot keeps ancestors and clears the hotspot", async () => {
      const { target, data } = await change(HOTSPOT, "county", CB);
      expect(geo(target)).toEqual({ country: "US", region: STATE, county: CB });
      expect(data.selection).toMatchObject({ kind: "county", county: CB });
      expect(data.hotspot).toBe("");
    });

    it("changing only the hotspot keeps the whole ancestry", async () => {
      const { target, data } = await change(HOTSPOT, "hotspot", HA2);
      expect(geo(target)).toEqual({ country: "US", region: STATE, county: CA, hotspot: HA2 });
      expect(data.selection).toMatchObject({ kind: "hotspot", hotspot: HA2 });
    });

    it("clearing each level clears it and everything below", async () => {
      expect(geo((await change(HOTSPOT, "country", "")).target)).toEqual({});
      expect((await change(HOTSPOT, "country", "")).data.selection).toEqual({ kind: "anywhere" });
      expect(geo((await change(HOTSPOT, "region", "")).target)).toEqual({ country: "US" });
      expect(geo((await change(HOTSPOT, "county", "")).target)).toEqual({ country: "US", region: STATE });
      const hotspotCleared = await change(HOTSPOT, "hotspot", "");
      expect(geo(hotspotCleared.target)).toEqual({ country: "US", region: STATE, county: CA });
      expect(hotspotCleared.data.selection).toMatchObject({ kind: "county", county: CA });
    });

    it("a first choice from Anywhere and an unchanged Apply both canonicalize cleanly", async () => {
      const first = await change("", "country", "US");
      expect(first.data.selection).toEqual({ kind: "country", country: "US" });
      const same = await change(HOTSPOT, "hotspot", HA1);
      expect(geo(same.target)).toEqual({ country: "US", region: STATE, county: CA, hotspot: HA1 });
    });

    it("resets the page even when the submitting URL was on a later page", async () => {
      const err = await run(`${nativeQuery(HOTSPOT, "country", "CA")}&page=3`).then(() => null, (e) => e);
      expect(isRedirect(err)).toBe(true);
      expect(new URL(err.location, "http://localhost").searchParams.has("page")).toBe(false);
    });

    it("leaves strict 400 handling for a copied, genuinely conflicting URL", async () => {
      for (const path of [
        `/species?country=CA&region=${STATE}&county=${CA}&hotspot=${HA1}`,
        `/species?country=US&region=US-TX&county=${CA}`,
        `/species?country=US&region=${STATE}&county=${CB}&hotspot=${HA1}`,
      ])
        await expect(run(path), path).rejects.toMatchObject({ status: 400 });
    });

    it("rejects a partial, repeated or duplicated-hierarchy intent with a 400 instead of sanitizing it", async () => {
      const wasAll = "was_country=&was_region=&was_county=&was_hotspot=";
      const message = async (path: string) => {
        const err = await run(path).then(() => null, (e) => e);
        expect(isRedirect(err), `${path} must not be canonicalized`).toBe(false);
        expect(err?.status, path).toBe(400);
        return err.body.message as string;
      };
      // Partial "was" fields.
      expect(await message(`/species?was_country=US&country=US`)).toMatch(/incomplete or repeated/);
      expect(await message(`/species?was_country=&was_region=&was_county=&country=US`)).toMatch(/incomplete or repeated/);
      expect(await message(`/species?was_hotspot=&country=US&region=${STATE}`)).toMatch(/incomplete or repeated/);
      // Repeated "was" field, even with an otherwise valid submission.
      expect(await message(`/species?${wasAll}&was_country=US&country=US`)).toMatch(/incomplete or repeated/);
      // Valid intent, repeated hierarchy parameters (delete/append would have hidden them).
      expect(await message(`/species?${wasAll}&country=US&country=CA`)).toBe("Use only one country value.");
      expect(await message(`/species?${wasAll}&country=US&region=${STATE}&region=US-TX`)).toBe("Use only one region value.");
      expect(await message(`/species?${wasAll}&country=US&region=${STATE}&county=${CA}&county=${CB}`)).toBe("Use only one county value.");
      expect(await message(`/species?${wasAll}&country=US&region=${STATE}&county=${CA}&hotspot=${HA1}&hotspot=${HA2}`)).toBe("Use only one hotspot value.");
      // Repeats without any intent stay strictly rejected by the contract itself.
      expect(await message(`/species?country=US&country=CA`)).toBe("Use only one country value.");
    });

    it("does not treat a native submission as valid when the canonical result is still unverifiable", async () => {
      // Change the county to one shaped correctly but never loaded: the redirect
      // is issued, and the canonical target then fails identity checks with a 400.
      const err = await run(nativeQuery(HOTSPOT, "county", UNLOADED)).then(() => null, (e) => e);
      expect(isRedirect(err)).toBe(true);
      await expect(run(err.location)).rejects.toMatchObject({ status: 400 });
    });
  });
});

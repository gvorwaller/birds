import { loadTestEnv, requireTestDb } from "$server/testing/test-env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { query } from "$lib/db";
import { GET } from "../../api/hub-search/+server";
import { load } from "./+page.server";

/**
 * Phase 8B (td-687b1c): the /forecast/data loader and /api/hub-search under the
 * strict discovery contract, against small seeded fixtures (reserved codes,
 * removed afterwards). The loader is run for real: only the account owner
 * differs from a viewer, and discovery itself never depends on the role.
 */
loadTestEnv();
await requireTestDb(query);

const COUNTY = "US-FL-981";
const H_LOADED = "L99781001";
const H_LIST = "L99781002";
const H_REPORTED = "L99781003"; // failed hotspot load, no evidence
const H_VFAILED = "L99781005"; // list-verified, last load failed
const H_ANTI = "L99781004"; // list-verified, across the antimeridian (its own patch of ocean: files run in parallel)
const CACHE_KEYS = ["hotspotsRegion:ZZ-LOADER"];
const ATTEMPT = [H_REPORTED, H_VFAILED];

let owner: number;
function event(path: string, role: "user" | "viewer" = "user") {
  return {
    locals: { scopeId: owner, user: { id: owner, role } },
    depends: () => {},
    url: new URL(`http://localhost${path}`),
  } as unknown as Parameters<typeof load>[0];
}
const run = async (path: string, role: "user" | "viewer" = "user") =>
  (await load(event(path, role))) as any;
const api = async (path: string, scopeId: number | null = owner) =>
  GET({ locals: { scopeId }, url: new URL(`http://localhost/api/hub-search${path}`) } as unknown as Parameters<typeof GET>[0]);
const rejection = (p: Promise<unknown>) => p.then(() => null, (e) => e);

describe("Hotspots & data discovery route contract", () => {
  beforeAll(async () => {
    owner = (await query<{ id: number }>("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1")).rows[0].id;
    for (const [code, kind, name, region] of [
      [COUNTY, "region", "Zqloader County", "US-FL"],
      [H_LOADED, "hotspot", "Zqloader Marsh", COUNTY],
    ] as const)
      await query(
        `INSERT INTO frequency_fetch (loc_code,loc_kind,loc_name,begin_year,end_year,sample_sizes,n_species,region_code)
         VALUES ($1,$2,$3,2016,2025,$4,9,$5)`,
        [code, kind, name, Array(48).fill(10), region],
      );
    await query(
      `INSERT INTO frequency_fetch_attempts (loc_code,last_attempt_at,status,error,loc_kind,loc_name,region_code)
       VALUES ($1, now(), 'error', 'timeout', 'hotspot', 'Zqloader Reported', $2)`,
      [H_REPORTED, COUNTY],
    );
    await query(
      `INSERT INTO frequency_fetch_attempts (loc_code,last_attempt_at,status,error,loc_kind,loc_name,region_code)
       VALUES ($1, now(), 'error', 'http 500', 'hotspot', 'Zqloader Verified Failed', $2)`,
      [H_VFAILED, COUNTY],
    );
    const entry = (id: string, name: string, lat: number, lng: number) => ({
      locId: id, locName: name, lat, lng, countryCode: "US", subnational1Code: "US-FL", subnational2Code: COUNTY,
    });
    await query(`INSERT INTO ebird_cache (cache_key,payload,fetched_at) VALUES ($1,$2::jsonb,now())`, [
      CACHE_KEYS[0],
      JSON.stringify([entry(H_LIST, "Zqloader List Bird", 27.1, -82.1), entry(H_ANTI, "Zqloader Across The Line", 6, -179.9), entry(H_VFAILED, "Zqloader Verified Failed", 27.2, -82.2)]),
    ]);
  });
  afterAll(async () => {
    await query("DELETE FROM ebird_cache WHERE cache_key = ANY($1)", [CACHE_KEYS]);
    await query("DELETE FROM frequency_fetch_attempts WHERE loc_code = ANY($1)", [ATTEMPT]);
    await query("DELETE FROM frequency_fetch WHERE loc_code = ANY($1)", [[COUNTY, H_LOADED]]);
  });

  describe("discovery state", () => {
    it("renders typed discovery in the loader, with exact totals, types and load states", async () => {
      const data = await run("/forecast/data?find=%20%20zqloader%20%20&future=kept");
      const d = data.discovery;
      expect(d).toMatchObject({ mode: "typed", find: "zqloader", total: 6, page: 1, pageCount: 1, first: 1, last: 6 });
      // Searched on the normalized text; the submitted text is kept for display.
      expect(d.submitted).toBe("  zqloader  ");
      expect(d.counts).toEqual({ country: 0, region: 0, county: 1, hotspot: 4, reported: 1 });
      const by = Object.fromEntries(d.results.map((r: any) => [r.id, r]));
      expect(by[COUNTY]).toMatchObject({ type: "county", name: "Zqloader County", loadState: "current", context: "Florida, United States" });
      expect(by[H_LOADED]).toMatchObject({ type: "hotspot", loadState: "current" });
      expect(by[H_LIST]).toMatchObject({ type: "hotspot", loadState: "available-not-loaded" });
      expect(by[H_REPORTED]).toMatchObject({ type: "reported", loadState: "unverified", evidence: ["reported location — hotspot status unverified"], target: { kind: "failed", code: H_REPORTED } });
      expect(by[H_VFAILED]).toMatchObject({ type: "hotspot", loadState: "failed", target: { kind: "hotspot", id: H_VFAILED } });
    });

    it("renders map discovery in the loader across the antimeridian", async () => {
      const data = await run("/forecast/data?place=Fixture+Point&lat=6&lng=179.9&dist=25");
      expect(data.discovery).toMatchObject({ mode: "map", total: 1 });
      expect(data.discovery.results[0]).toMatchObject({ id: H_ANTI, type: "hotspot", target: { kind: "hotspot", id: H_ANTI } });
      expect(data.discovery.map).toMatchObject({ place: "Fixture Point", dist: 25 });
    });

    it("flags failed rows without hotspot evidence as unverified reported locations", async () => {
      const data = await run("/forecast/data");
      const byCode = Object.fromEntries(data.failed.map((f: any) => [f.locCode, f]));
      expect(byCode[H_REPORTED].unverified).toBe(true);
      expect(byCode[H_VFAILED].unverified).toBe(false); // list-verified, only its load failed
      expect(data.failed.some((f: any) => typeof f.unverified !== "boolean")).toBe(false);
    });

    it("has no discovery without discovery parameters, and ignores a blank submitted search", async () => {
      expect((await run("/forecast/data")).discovery).toBeNull();
      expect((await run("/forecast/data?find=&place=&lat=&lng=&dist=&future=kept")).discovery).toBeNull();
    });

    it("answers a page past the end with 404 and a too-short search with a message", async () => {
      expect((await rejection(run("/forecast/data?find=zqloader&findPage=2"))).status).toBe(404);
      expect((await run("/forecast/data?find=z")).discovery).toMatchObject({ tooShort: true, total: 0 });
    });

    it("rejects malformed, repeated, incomplete or mixed discovery with a clear 400", async () => {
      const base = "place=P&lat=10&lng=179.9&dist=25";
      for (const path of [
        "/forecast/data?find=ab&find=cd",
        `/forecast/data?find=ab&${base}`,
        "/forecast/data?findPage=2",
        "/forecast/data?mapPage=2",
        "/forecast/data?find=ab&findPage=0",
        `/forecast/data?${base}&mapPage=abc`,
        "/forecast/data?place=P&lat=10&lng=179.9",
        "/forecast/data?place=P&lat=91&lng=0&dist=5",
        "/forecast/data?place=P&lat=10&lng=181&dist=5",
        "/forecast/data?place=P&lat=10&lng=0&dist=0",
        "/forecast/data?place=P&lat=10&lng=0&dist=201",
        "/forecast/data?place=P&lat=10&lng=0&dist=2.5",
        `/forecast/data?find=${"x".repeat(101)}`,
        `/forecast/data?place=${"x".repeat(201)}&lat=1&lng=1&dist=5`,
        `/forecast/data?${base}&dist=30`,
      ]) {
        const err = await rejection(run(path));
        expect(err?.status, path).toBe(400);
        expect(typeof err.body.message, path).toBe("string");
      }
    });

    it("serves the identical result model to a viewer", async () => {
      const [a, b] = [await run("/forecast/data?find=zqloader"), await run("/forecast/data?find=zqloader", "viewer")];
      expect(b.isViewer).toBe(true);
      expect(b.discovery).toEqual(a.discovery);
    });
  });

  describe("selection destinations", () => {
    it("treats an explicit country (a country-only Load destination) as a local-only single value", async () => {
      const data = await run("/forecast/data?country=CO");
      expect(data.offlineView).toBe(true);
      expect((await run("/forecast/data")).offlineView).toBe(false);
      for (const path of ["/forecast/data?country=CO&country=NO", "/forecast/data?country=US&country=US"])
        expect((await rejection(run(path)))?.status, path).toBe(400);
    });

    it("opens a loaded county with its country and region disclosures, loading only that group's detail", async () => {
      const data = await run(`/forecast/data?show=${COUNTY}`);
      expect(data.focus).toEqual({
        kind: "area", code: COUNTY, targetId: `hub-node-${COUNTY}`, area: "north-america",
        states: ["US", "US-FL"], county: COUNTY,
      });
      expect(Object.keys(data.focusDetail)).toEqual(["US-FL"]);
      const block = data.focusDetail["US-FL"].countyBlocks.find((b: any) => b.countyCode === COUNTY);
      expect(block).toMatchObject({ countyName: "Zqloader County" });
      expect(block.hotspots.map((h: any) => h.locCode)).toEqual([H_LOADED]);
    });

    it("opens a loaded region and a loaded country the same way, and never ships detail unasked", async () => {
      const region = await run("/forecast/data?show=US-FL");
      expect(region.focus).toMatchObject({ kind: "area", code: "US-FL", states: ["US", "US-FL"], county: null, targetId: "hub-node-US-FL" });
      expect(Object.keys(region.focusDetail)).toEqual(["US-FL"]);
      const country = await run("/forecast/data?show=US");
      expect(country.focus).toMatchObject({ kind: "area", code: "US", states: ["US"], county: null });
      expect(Object.keys(country.focusDetail)).toEqual(["US"]);
      const none = await run("/forecast/data");
      expect(none.focus).toBeNull();
      expect(none.focusDetail).toEqual({});
    });

    it("opens the existing failed-load row for a failed hotspot, and degrades gracefully for the unknown", async () => {
      expect((await run(`/forecast/data?show=${H_REPORTED}`)).focus).toEqual({ kind: "failed", code: H_REPORTED });
      expect((await run("/forecast/data?show=L99781999")).focus).toEqual({ kind: "unavailable", code: "L99781999" });
      expect((await run("/forecast/data?show=ZZ-QQ")).focus).toEqual({ kind: "unavailable", code: "ZZ-QQ" });
      for (const path of ["/forecast/data?show=not-a-code", "/forecast/data?show=US&show=NO"])
        expect((await rejection(run(path)))?.status, path).toBe(400);
    });

    it("preselects the existing Load workflow for an unloaded region without submitting anything", async () => {
      const jobsBefore = (await query<{ n: string }>("SELECT count(*) AS n FROM jobs")).rows[0].n;
      // The regions the existing Load form offers right now (unloaded, in an
      // offered country); none offered means there is nothing to preselect.
      const base = await run("/forecast/data");
      const offered: { code: string }[] = base.states;
      for (const region of offered.slice(0, 5)) {
        const data = await run(`/forecast/data?country=${base.selectedCountry}&region=${region.code}`);
        expect(data.preselectRegion).toBe(region.code);
        expect(data.selectedCountry).toBe(base.selectedCountry);
        // A region alone derives its country.
        const derived = await run(`/forecast/data?region=${region.code}`);
        expect(derived.preselectRegion).toBe(region.code);
      }
      // A region the form does not offer (loaded, or in a country not offered) is not preselected.
      expect((await run("/forecast/data?region=US-FL")).preselectRegion).toBeNull();
      // Selecting is navigation only: no job, no write.
      expect((await query<{ n: string }>("SELECT count(*) AS n FROM jobs")).rows[0].n).toBe(jobsBefore);
    });

    it("rejects a malformed or conflicting region preselect", async () => {
      for (const path of [
        "/forecast/data?region=US",
        "/forecast/data?region=US-FL-115",
        "/forecast/data?region=nonsense",
        "/forecast/data?country=CA&region=US-FL",
        "/forecast/data?region=US-FL&region=US-GA",
      ])
        expect((await rejection(run(path)))?.status, path).toBe(400);
    });
  });

  describe("/api/hub-search", () => {
    it("serves the same result model as the page loader, one page at a time", async () => {
      const res = await api("?find=zqloader");
      expect(res.status).toBe(200);
      const body = await res.json();
      const page = await run("/forecast/data?find=zqloader");
      expect(body.discovery).toEqual(page.discovery);
      const map = await (await api("?place=Fixture+Point&lat=6&lng=179.9&dist=25")).json();
      expect(map.discovery.results.map((r: any) => r.id)).toEqual([H_ANTI]);
    });

    it("is never an uncapped dump: 50 per page with an exact total and continuation", async () => {
      const first = (await (await api("?find=florida")).json()).discovery;
      expect(first.results).toHaveLength(50);
      expect(first.total).toBeGreaterThan(50);
      expect(first).toMatchObject({ pageSize: 50, page: 1, first: 1, last: 50 });
      const second = (await (await api("?find=florida&findPage=2")).json()).discovery;
      expect(second).toMatchObject({ page: 2, first: 51, total: first.total });
      expect(second.results.map((r: any) => r.id)).not.toEqual(first.results.map((r: any) => r.id));
    });

    it("answers no discovery with null and rejects the same malformed input as the page", async () => {
      expect(await (await api("")).json()).toEqual({ discovery: null });
      expect(await (await api("?find=&future=kept")).json()).toEqual({ discovery: null });
      for (const qs of ["?find=ab&find=cd", "?find=ab&place=P&lat=1&lng=1&dist=5", "?findPage=2", "?place=P&lat=1&lng=1", "?place=P&lat=1&lng=1&dist=500"])
        expect((await rejection(api(qs)))?.status, qs).toBe(400);
      expect((await rejection(api("?find=abc", null)))?.status).toBe(401);
      expect((await rejection(api("?find=zqloader&findPage=9")))?.status).toBe(404);
    });
  });
});

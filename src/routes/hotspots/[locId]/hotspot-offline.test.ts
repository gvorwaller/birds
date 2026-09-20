import { loadTestEnv, requireTestDb } from "$server/testing/test-env";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { query } from "$lib/db";
import { hubHotspotPath } from "$lib/hub-discovery";
import { guardEbird } from "$server/testing/ebird-guard";

const seen = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("$server/ebird", async (importOriginal) =>
  guardEbird(await importOriginal<Record<string, unknown>>(), seen.calls, "placeholder-key"),
);

import { actions, load } from "./+page.server";

/**
 * Phase 8B P1: selecting a discovery result opens a hotspot workspace, and that
 * must not call eBird even for an owner account WITH an API key. Here every
 * network-capable eBird function records and throws, and the key is present.
 */
loadTestEnv();
await requireTestDb(query);

const H_LIST = "L99796001"; // verified by an official list, never loaded
const H_LOADED = "L99796002"; // verified and loaded
const H_UNKNOWN = "L99796003"; // nothing known anywhere
const H_PLACE = "L99796004"; // known from place data only: NOT verified
const KEY = "hotspotsRegion:ZZ-OFFLINE";
const ELOC = [H_PLACE];
let owner: number;

function event(locId: string, search = "") {
  return {
    locals: { scopeId: owner, user: { id: owner, role: "user" } },
    params: { locId },
    url: new URL(`http://localhost/hotspots/${locId}${search}`),
  } as unknown as Parameters<typeof load>[0];
}

describe("hotspot workspace reached from discovery", () => {
  beforeAll(async () => {
    owner = (await query<{ id: number }>("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1")).rows[0].id;
    await query(
      `INSERT INTO frequency_fetch (loc_code,loc_kind,loc_name,begin_year,end_year,sample_sizes,n_species,region_code)
       VALUES ($1,'hotspot','Zqoffline Loaded',2016,2025,$2,9,'US-FL')`,
      [H_LOADED, Array(48).fill(10)],
    );
    await query(`INSERT INTO ebird_locations (loc_id,loc_name,lat,lng) VALUES ($1,'Zqoffline Place Only',27.3,-82.3)`, [H_PLACE]);
    const entry = (id: string, name: string) => ({ locId: id, locName: name, lat: 27.1, lng: -82.1, countryCode: "US", subnational1Code: "US-FL" });
    await query(`INSERT INTO ebird_cache (cache_key,payload,fetched_at) VALUES ($1,$2::jsonb,now())`, [
      KEY,
      JSON.stringify([entry(H_LIST, "Zqoffline List Only"), entry(H_LOADED, "Zqoffline Loaded")]),
    ]);
  });
  afterAll(async () => {
    await query("DELETE FROM ebird_cache WHERE cache_key = $1", [KEY]);
    await query("DELETE FROM frequency_fetch WHERE loc_code = $1", [H_LOADED]);
    await query("DELETE FROM ebird_locations WHERE loc_id = ANY($1)", [ELOC]);
  });

  it("discovery links to the local-only Monthly tab, keeping the named return path", () => {
    expect(hubHotspotPath("L299291")).toBe("/hotspots/L299291?tab=monthly");
    expect(hubHotspotPath("L1")).toContain("tab=monthly");
  });

  it("opens a verified, a loaded and an unknown location without any eBird call, keyed", async () => {
    for (const id of [H_LIST, H_LOADED, H_UNKNOWN]) {
      seen.calls.length = 0;
      const data = (await load(event(id, "?tab=monthly&returnTo=%2Fforecast%2Fdata%3Ffind%3Dab%23forecast-data-search-x&returnLabel=Hotspots+%26+data"))) as any;
      expect(data.tab, id).toBe("monthly");
      expect(data.hasApiKey, id).toBe(true); // the keyed branch really ran
      expect(seen.calls, id).toEqual([]);
      expect(data.days, id).toEqual([]);
      expect(data.returnLink).toMatchObject({ label: "Hotspots & data" });
    }
  });

  it("the guard is effective: the default Recent tab of a known hotspot DOES call eBird", async () => {
    seen.calls.length = 0;
    const data = (await load(event(H_LIST))) as any;
    expect(data.tab).toBe("recent");
    expect(seen.calls).toEqual(["recentHotspotObs"]);
    expect(data.recentError).toBeTruthy();
  });

  it("an unverified location known only from place data never reaches eBird, even on the default tab", async () => {
    for (const search of ["", "?tab=recent", "?tab=monthly"]) {
      seen.calls.length = 0;
      const data = (await load(event(H_PLACE, search))) as any;
      expect(data, search).toMatchObject({ known: true, verified: false, hasApiKey: true, days: [] });
      expect(seen.calls, search).toEqual([]);
    }
  });

  it("an unloaded verified hotspot's Monthly tab says to load history rather than reaching for data", async () => {
    seen.calls.length = 0;
    const data = (await load(event(H_LIST, "?tab=monthly"))) as any;
    expect(data).toMatchObject({ known: true, verified: true, freq: null, monthly: null });
    expect(seen.calls).toEqual([]);
  });

  describe("the explicit verify-and-load action stays available, and is the only eBird path", () => {
    async function post(locId: string, role: "user" | "viewer") {
      const body = new FormData();
      body.set("back", "7");
      body.set("tab", "monthly");
      return (await actions.load_hotspot({
        locals: { scopeId: owner, user: { id: owner, role } },
        params: { locId },
        request: new Request(`http://localhost/hotspots/${locId}?/load_hotspot`, { method: "POST", body }),
      } as unknown as Parameters<typeof actions.load_hotspot>[0])) as any;
    }
    const jobs = async () => (await query<{ n: string }>("SELECT count(*) AS n FROM jobs")).rows[0].n;

    it("the default GET of an unverified page makes zero eBird calls; the owner's POST is the authorized path to eBird", async () => {
      for (const id of [H_PLACE, H_UNKNOWN]) {
        seen.calls.length = 0;
        await load(event(id));
        expect(seen.calls, `GET ${id}`).toEqual([]);
        const before = await jobs();
        const res = await post(id, "user");
        // The guard refuses the request, so nothing is verified and no job is queued.
        expect(seen.calls, `POST ${id}`).toEqual(["ebirdFetchOrNull"]);
        expect(res.status, id).toBe(502);
        expect(res.data.verificationRequired, id).toBe(true);
        expect(await jobs(), id).toBe(before);
      }
    });

    it("a viewer's POST is refused before any eBird call", async () => {
      seen.calls.length = 0;
      const res = await post(H_PLACE, "viewer");
      expect(res.status).toBe(403);
      expect(seen.calls).toEqual([]);
    });
  });
});

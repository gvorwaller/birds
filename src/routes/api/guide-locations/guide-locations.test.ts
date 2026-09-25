/**
 * /api/guide-locations (td-daff98): the Field Guide's Place choices. Owned
 * fixture rows only (a disposable county and its hotspots), deleted exactly.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { query } from "$lib/db";
import { guideCounties, guideHotspots, guideRegions } from "$server/guide-location";
import { GET } from "./+server";

const dbUp = await query("SELECT 1")
  .then(() => true)
  .catch(() => false);

const RUN = String(process.pid % 100000).padStart(5, "0");
const COUNTY = `US-FL-Z${RUN}`;
const EMPTY_COUNTY = `US-FL-Y${RUN}`;
const SPOTS = [`L97${RUN}1`, `L97${RUN}2`];

async function cleanup() {
  await query("DELETE FROM frequency_fetch WHERE loc_code = ANY($1::text[])", [[COUNTY, EMPTY_COUNTY, ...SPOTS]]);
}

type Handler = (e: { locals: unknown; url: URL }) => Promise<Response>;
async function call(q: string, locals: unknown = { scopeId: 1, user: { id: 1, role: "owner" } }) {
  try {
    const res = await (GET as unknown as Handler)({ locals, url: new URL(`http://localhost/api/guide-locations?${q}`) });
    return { status: res.status, body: await res.json(), headers: res.headers };
  } catch (err) {
    return { status: (err as { status?: number }).status ?? 500, body: null, headers: null };
  }
}

describe.runIf(dbUp)("/api/guide-locations", () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  beforeAll(async () => {
    await cleanup();
    const row = (code: string, kind: string, name: string, region: string | null) =>
      query(
        `INSERT INTO frequency_fetch (loc_code, loc_kind, loc_name, begin_year, end_year, sample_sizes, n_species, region_code)
         VALUES ($1, $2, $3, 2015, 2024, array_fill(0, ARRAY[48]), 0, $4)`,
        [code, kind, name, region],
      );
    await row(COUNTY, "region", "Zz Fixture County", "US-FL");
    await row(EMPTY_COUNTY, "region", "Yy Empty Fixture County", "US-FL");
    await row(SPOTS[1], "hotspot", "b fixture pond", COUNTY);
    await row(SPOTS[0], "hotspot", "A Fixture Marsh", COUNTY);
  });
  afterAll(async () => {
    await cleanup();
    fetchSpy.mockRestore();
  });

  it("requires a signed-in session", async () => {
    expect((await call("level=region&parent=US", {})).status).toBe(401);
  });

  it("rejects malformed, repeated, missing and extra parameters", async () => {
    for (const q of ["level=region", "level=region&parent=US&parent=CA", "level=region&parent=US&x=1", "level=county&parent=US", "level=hotspot&parent=L1"])
      expect((await call(q)).status, q).toBe(400);
  });

  it("rejects a well-shaped parent that does not exist", async () => {
    expect((await call("level=region&parent=XX")).status).toBe(400);
    expect((await call("level=county&parent=US-ZZ")).status).toBe(400);
    expect((await call("level=hotspot&parent=US-FL-999999")).status).toBe(400);
  });

  it("returns the loader's own lists, identical and uncapped", async () => {
    const regions = await call("level=region&parent=US");
    expect(regions.status).toBe(200);
    expect(regions.body.choices).toEqual(await guideRegions("US"));
    const counties = await call("level=county&parent=us-fl");
    expect(counties.body.parent).toBe("US-FL");
    expect(counties.body.choices).toEqual(await guideCounties("US-FL"));
    expect(counties.body.choices.map((c: { code: string }) => c.code)).toContain(COUNTY);
    const spots = await call(`level=hotspot&parent=${COUNTY}`);
    expect(spots.body.choices).toEqual(await guideHotspots(COUNTY));
    // One fixed, case-insensitive order.
    expect(spots.body.choices.map((c: { name: string }) => c.name)).toEqual(["A Fixture Marsh", "b fixture pond"]);
    expect(spots.headers?.get("cache-control")).toBe("private, max-age=300");
  });

  it("returns an empty list for a real county with no loaded hotspots", async () => {
    const res = await call(`level=hotspot&parent=${EMPTY_COUNTY}`);
    expect(res.status).toBe(200);
    expect(res.body.choices).toEqual([]);
  });

  it("makes no network requests", () => {
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("/api/guide-locations module", () => {
  it("imports only DB/reference helpers: no eBird client, credentials or jobs", async () => {
    const { readFile } = await import("node:fs/promises");
    const sources = [
      await readFile(new URL("./+server.ts", import.meta.url), "utf8"),
      await readFile(new URL("../../../lib/server/guide-location.ts", import.meta.url), "utf8"),
    ].join("\n");
    expect(sources).not.toMatch(/\$server\/(ebird|jobs|credentials|user-ebird)/);
    expect(sources).not.toMatch(/getEbirdApiKey|enqueueJob/);
  });
});

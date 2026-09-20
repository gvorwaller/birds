import { loadTestEnv, requireTestDb } from "$server/testing/test-env";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { query } from "$lib/db";
import { guardEbird } from "$server/testing/ebird-guard";

const seen = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("$server/ebird", async (importOriginal) =>
  guardEbird(await importOriginal<Record<string, unknown>>(), seen.calls, "placeholder-key"),
);

import { GET } from "../../api/hub-search/+server";
import { load } from "./+page.server";

/**
 * Phase 8B P1: a discovery or selection view is local-only, even for an owner
 * account WITH an eBird API key. Every network-capable eBird function records and
 * throws (the page loader swallows such errors, so the RECORD is what proves it).
 */
loadTestEnv();
await requireTestDb(query);

let owner: number;
function event(path: string) {
  return {
    locals: { scopeId: owner, user: { id: owner, role: "user" } },
    depends: () => {},
    url: new URL(`http://localhost${path}`),
  } as unknown as Parameters<typeof load>[0];
}
const run = async (path: string) => {
  seen.calls.length = 0;
  return (await load(event(path))) as any;
};

describe("Hotspots & data never contacts eBird from a discovery or selection view", () => {
  beforeAll(async () => {
    owner = (await query<{ id: number }>("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1")).rows[0].id;
  });
  afterAll(() => {
    seen.calls.length = 0;
  });

  it("the guard is effective: an ordinary keyed visit DOES fan out to eBird region lists", async () => {
    const data = await run("/forecast/data");
    expect(data.hasApiKey).toBe(true);
    expect(data.offlineView).toBe(false);
    expect(seen.calls).toContain("subregions");
  });

  it("typed and map discovery, keyed, make no eBird request", async () => {
    for (const path of [
      "/forecast/data?find=Sarasota",
      "/forecast/data?find=Florida&findPage=2",
      "/forecast/data?place=Myakka+River+SP&lat=27.240503&lng=-82.314817&dist=25",
    ]) {
      const data = await run(path);
      expect(data.hasApiKey, path).toBe(true);
      expect(data.offlineView, path).toBe(true);
      expect(data.discovery, path).not.toBeNull();
      expect(seen.calls, path).toEqual([]);
    }
  });

  it("every selection landing, keyed, makes no eBird request while still rendering its chain", async () => {
    for (const path of [
      "/forecast/data?show=US",
      "/forecast/data?show=US-FL",
      "/forecast/data?show=US-FL-115",
      "/forecast/data?country=CO&region=CO-ANT",
      "/forecast/data?region=CO-ANT",
      "/forecast/data?show=L99799999",
      "/forecast/data?country=CO",
      "/forecast/data?country=US",
      "/forecast/data?country=NO#load-region",
    ]) {
      const data = await run(path);
      expect(data.hasApiKey, path).toBe(true);
      expect(data.offlineView, path).toBe(true);
      expect(seen.calls, path).toEqual([]);
    }
    const county = await run("/forecast/data?show=US-FL-115");
    expect(county.focus).toMatchObject({ kind: "area", county: "US-FL-115", states: ["US", "US-FL"] });
    expect(Object.keys(county.focusDetail)).toEqual(["US-FL"]);
  });

  it("a repeated country is rejected before anything else happens", async () => {
    seen.calls.length = 0;
    await expect(load(event("/forecast/data?country=CO&country=NO"))).rejects.toMatchObject({ status: 400 });
    expect(seen.calls).toEqual([]);
  });

  it("the JSON search endpoint makes no eBird request either, keyed", async () => {
    seen.calls.length = 0;
    for (const qs of ["?find=Sarasota", "?place=Myakka+River+SP&lat=27.240503&lng=-82.314817&dist=25"]) {
      const res = await GET({ locals: { scopeId: owner }, url: new URL(`http://localhost/api/hub-search${qs}`) } as unknown as Parameters<typeof GET>[0]);
      expect(res.status).toBe(200);
    }
    expect(seen.calls).toEqual([]);
  });
});

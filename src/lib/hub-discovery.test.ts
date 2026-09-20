import { describe, expect, it } from "vitest";
import {
  HUB_DISCOVERY_PARAMS,
  HUB_PAGE_SIZE,
  clearHubDiscovery,
  hubHotspotPath,
  hubHref,
  hubSelectHref,
  normalizeHubFind,
  parseHubDiscovery,
  withHubMap,
  withHubPage,
  withHubTyped,
} from "./hub-discovery";

const parse = (qs: string) => parseHubDiscovery(new URLSearchParams(qs));
const ok = (qs: string) => {
  const r = parse(qs);
  if (!r.ok) throw new Error(`expected ok for ${qs}: ${r.message}`);
  return r.state;
};
const bad = (qs: string) => {
  const r = parse(qs);
  if (r.ok) throw new Error(`expected rejection for ${qs}`);
  return r.message;
};
const MAP = "place=Myakka+River+SP&lat=27.240503&lng=-82.314817&dist=25";

describe("parseHubDiscovery", () => {
  it("treats no discovery, and blank native-form values, as none", () => {
    expect(ok("")).toEqual({ mode: "none" });
    expect(ok("find=&place=&lat=&lng=&dist=")).toEqual({ mode: "none" });
    expect(ok("find=%20%20&future=kept&country=NO")).toEqual({ mode: "none" });
  });

  it("parses a typed query, collapsing whitespace but keeping the submitted text", () => {
    expect(ok("find=Myakka")).toEqual({ mode: "typed", find: "Myakka", page: 1, submitted: "Myakka" });
    // Normalized for searching and URLs; the submitted text is kept for display.
    expect(ok("find=%20%20Myakka%20%20River%09SP%20")).toEqual({
      mode: "typed",
      find: "Myakka River SP",
      page: 1,
      submitted: "  Myakka  River\tSP ",
    });
    expect(ok("find=Ålesund")).toMatchObject({ find: "Ålesund" });
    expect(ok("find=Myakka&findPage=3")).toEqual({ mode: "typed", find: "Myakka", page: 3, submitted: "Myakka" });
  });

  it("parses a map state into finite numbers, a whole-mile radius and a page", () => {
    expect(ok(MAP)).toEqual({
      mode: "map",
      place: "Myakka River SP",
      lat: 27.240503,
      lng: -82.314817,
      dist: 25,
      page: 1,
    });
    expect(ok(`${MAP}&mapPage=2`)).toMatchObject({ mode: "map", page: 2 });
    expect(ok("place=Edge&lat=-90&lng=180&dist=200")).toMatchObject({ lat: -90, lng: 180, dist: 200 });
  });

  it("never mixes typed and map state", () => {
    expect(bad(`find=Myakka&${MAP}`)).toMatch(/not both/);
    expect(bad("find=Myakka&place=Somewhere")).toMatch(/not both/);
    expect(bad(`findPage=2&${MAP}`)).toMatch(/not both/);
    expect(bad(`find=x1&mapPage=2`)).toMatch(/not both/);
  });

  it("requires all four map values and never fills a radius", () => {
    const parts = ["place=Myakka", "lat=27.2", "lng=-82.3", "dist=25"];
    for (let skip = 0; skip < parts.length; skip++) {
      const partial = parts.filter((_, i) => i !== skip).join("&");
      expect(bad(partial), partial).toMatch(/needs a place name, latitude, longitude and radius/);
    }
    expect(bad("mapPage=2")).toBe("A results page needs a map point.");
    expect(bad("findPage=2")).toBe("A results page needs a search.");
  });

  it("rejects malformed coordinates, radii, pages and long values", () => {
    for (const [field, value] of [
      ["lat", "90.5"], ["lat", "abc"], ["lat", "1e1"], ["lng", "181"], ["lng", "NaN"],
      ["dist", "0"], ["dist", "201"], ["dist", "2.5"], ["dist", "-3"],
      ["mapPage", "0"], ["mapPage", "1.5"], ["mapPage", "abc"], ["mapPage", "99999999999"],
    ] as const) {
      const p = new URLSearchParams(MAP);
      p.set(field, value);
      expect(parseHubDiscovery(p).ok, `${field}=${value}`).toBe(false);
    }
    for (const value of ["0", "-1", "1.5", "x", "99999999999"])
      expect(parse(`find=ab&findPage=${value}`).ok, value).toBe(false);
    expect(bad(`find=${"x".repeat(101)}`)).toMatch(/limited to 100 characters/);
    expect(parse(`find=${"x".repeat(100)}`).ok).toBe(true);
    expect(parse(`place=${"x".repeat(201)}&lat=1&lng=1&dist=5`).ok).toBe(false);
  });

  it("rejects a repeated owned parameter instead of picking one", () => {
    for (const qs of ["find=a1&find=b1", "findPage=2&findPage=3&find=ab", `${MAP}&dist=30`, `${MAP}&mapPage=2&mapPage=3`])
      expect(bad(qs), qs).toMatch(/^Use only one \w+ value\.$/);
  });
});

describe("URL transitions", () => {
  const base = new URLSearchParams("future=kept&country=NO&find=old&findPage=4&show=US-FL&region=NO-03");

  it("a new typed search resets the page, map state and stale selection, and keeps unrelated parameters", () => {
    const next = withHubTyped(new URLSearchParams(`${MAP}&mapPage=3&future=kept&country=NO&show=US-FL&region=NO-03`), "  Sarasota   County ");
    expect(next.toString()).toBe("future=kept&country=NO&find=Sarasota+County");
    expect(withHubTyped(base, "   ").toString()).toBe("future=kept&country=NO");
  });

  it("a new map point clears typed state, the page and stale selection", () => {
    const built = withHubMap(base, { place: "  Myakka River SP ", lat: 27.240503, lng: -82.314817, dist: 25 });
    expect(built.ok && built.params.toString()).toBe(`future=kept&country=NO&${MAP}`);
    const tiny = withHubMap(base, { place: "P", lat: 1e-7, lng: -0.5, dist: 5 });
    expect(tiny.ok && tiny.params.get("lat")).toBe("0.000000");
  });

  it("validates the radius and coordinates before building a map URL", () => {
    for (const dist of [0, 201, 2.5, NaN])
      expect(withHubMap(base, { place: "P", lat: 1, lng: 1, dist })).toMatchObject({ ok: false });
    expect(withHubMap(base, { place: "P", lat: 91, lng: 1, dist: 5 })).toMatchObject({ ok: false });
    expect(withHubMap(base, { place: "P", lat: 1, lng: NaN, dist: 5 })).toMatchObject({ ok: false });
    expect(withHubMap(base, { place: "   ", lat: 1, lng: 1, dist: 5 })).toMatchObject({ ok: false });
    const long = withHubMap(base, { place: "y".repeat(300), lat: 1, lng: 1, dist: 5 });
    expect(long.ok && long.params.get("place")).toHaveLength(200);
  });

  it("page 1 is the canonical absence of a continuation parameter", () => {
    const typed = new URLSearchParams("find=ab");
    expect(withHubPage(typed, "typed", 3).toString()).toBe("find=ab&findPage=3");
    expect(withHubPage(new URLSearchParams("find=ab&findPage=3"), "typed", 1).toString()).toBe("find=ab");
    expect(withHubPage(new URLSearchParams(MAP), "map", 2).toString()).toBe(`${MAP}&mapPage=2`);
  });

  it("clearing removes only the owned discovery parameters", () => {
    const cleared = clearHubDiscovery(new URLSearchParams(`${MAP}&mapPage=2&find=x1&findPage=2&future=kept&show=US-FL&country=NO`));
    for (const name of HUB_DISCOVERY_PARAMS) expect(cleared.has(name), name).toBe(false);
    expect(cleared.toString()).toBe("future=kept&show=US-FL&country=NO");
    expect(hubHref(cleared)).toBe("/forecast/data?future=kept&show=US-FL&country=NO#discovery-results");
    expect(hubHref(new URLSearchParams(), "")).toBe("/forecast/data");
  });

  it("normalizes search text", () => {
    expect(normalizeHubFind("  a \t b\n c  ")).toBe("a b c");
    expect(HUB_PAGE_SIZE).toBe(50);
  });
});

describe("selection destinations", () => {
  const base = new URLSearchParams(`future=kept&${MAP}&mapPage=2&show=OLD&region=OLD`);

  it("opens an existing section by code and drops discovery and stale selection state", () => {
    expect(hubSelectHref(base, { kind: "section", code: "US-FL-115" })).toBe(
      "/forecast/data?future=kept&show=US-FL-115#hub-node-US-FL-115",
    );
  });

  it("preselects the existing Load workflow without submitting anything", () => {
    expect(hubSelectHref(base, { kind: "load", country: "NO", region: "NO-03" })).toBe(
      "/forecast/data?future=kept&country=NO&region=NO-03#load-region",
    );
    expect(hubSelectHref(base, { kind: "load", country: "NO", region: null })).toBe(
      "/forecast/data?future=kept&country=NO#load-region",
    );
  });

  it("opens a failed load's existing recovery row", () => {
    expect(hubSelectHref(base, { kind: "failed", code: "L123" })).toBe(
      "/forecast/data?future=kept&show=L123#hub-failed-L123",
    );
  });

  it("returns null for targets that are not on this page", () => {
    expect(hubSelectHref(base, { kind: "hotspot", id: "L1" })).toBeNull();
    expect(hubSelectHref(base, { kind: "none" })).toBeNull();
  });

  it("opens a hotspot at its local-only Monthly tab so selection never reaches eBird", () => {
    expect(hubHotspotPath("L299291")).toBe("/hotspots/L299291?tab=monthly");
    expect(hubHotspotPath("L1")).toBe("/hotspots/L1?tab=monthly");
    expect(hubHotspotPath("L1")).not.toContain("tab=recent");
  });
});

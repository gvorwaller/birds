import { describe, expect, it } from "vitest";
import {
  parseGuideChoicesRequest,
  GUIDE_LOCATION_PARAMS,
  GUIDE_WAS_PARAMS,
  canonicalizeGuideLevelChange,
  clearGuideLocation,
  descendantsOf,
  guideCoverage,
  guideLocationPairs,
  guideMapHref,
  guideMapSelection,
  guideResultsHref,
  guideScopeText,
  guideWasPairs,
  parseGuideLocation,
  withGuideLevel,
  withGuideLocation,
  type GuideLocationView,
} from "./guide-location";

const parse = (qs: string) => parseGuideLocation(new URLSearchParams(qs));
const ok = (qs: string) => {
  const r = parse(qs);
  if (!r.ok) throw new Error(`expected ok for ${qs}: ${r.message}`);
  return r.selection;
};
const bad = (qs: string) => {
  const r = parse(qs);
  if (r.ok) throw new Error(`expected rejection for ${qs}`);
  return r.message;
};
const MAP = "place=Myakka+River+SP&lat=27.240503&lng=-82.314817&dist=25";

describe("parseGuideLocation: the six selection kinds", () => {
  it("treats no geography, and empty native-form values, as Anywhere", () => {
    expect(ok("")).toEqual({ kind: "anywhere" });
    expect(ok("country=&region=&county=&hotspot=")).toEqual({ kind: "anywhere" });
    expect(ok("country=%20&q=owl&future=kept")).toEqual({ kind: "anywhere" });
  });

  it("parses country, region, county and hotspot with normalized codes", () => {
    expect(ok("country=us")).toEqual({ kind: "country", country: "US" });
    expect(ok("country=US&region=us-fl")).toEqual({
      kind: "region",
      country: "US",
      region: "US-FL",
    });
    expect(ok("country=US&region=US-FL&county=us-fl-115")).toEqual({
      kind: "county",
      country: "US",
      region: "US-FL",
      county: "US-FL-115",
    });
    expect(
      ok("country=US&region=US-FL&county=US-FL-115&hotspot=l299291"),
    ).toEqual({
      kind: "hotspot",
      country: "US",
      region: "US-FL",
      county: "US-FL-115",
      hotspot: "L299291",
    });
  });

  it("keeps existing region-only URLs compatible and derives omitted ancestors from the code shape", () => {
    expect(ok("region=US-FL")).toMatchObject({ kind: "region", country: "US" });
    expect(ok("county=US-FL-115")).toMatchObject({
      kind: "county",
      country: "US",
      region: "US-FL",
    });
    expect(ok("county=GB-ENG-102&hotspot=L1")).toMatchObject({
      kind: "hotspot",
      country: "GB",
      region: "GB-ENG",
    });
  });

  it("parses a map selection into finite numbers and a whole-mile radius", () => {
    expect(ok(MAP)).toEqual({
      kind: "map",
      place: "Myakka River SP",
      lat: 27.240503,
      lng: -82.314817,
      dist: 25,
    });
    expect(ok("place=Edge&lat=-90&lng=180&dist=200")).toMatchObject({
      lat: -90,
      lng: 180,
      dist: 200,
    });
    expect(ok("place=Edge&lat=90&lng=-180&dist=1")).toMatchObject({ dist: 1 });
  });
});

describe("parseGuideLocation: strict rejection", () => {
  it("never mixes a hierarchy with a map selection", () => {
    for (const hierarchy of [
      "country=US",
      "region=US-FL",
      "county=US-FL-115",
      "hotspot=L299291",
    ])
      expect(bad(`${hierarchy}&${MAP}`)).toMatch(/not both/);
    expect(bad(`country=US&place=Somewhere`)).toMatch(/not both/);
  });

  it("requires all four map values and never fills a radius", () => {
    const parts = ["place=Myakka", "lat=27.2", "lng=-82.3", "dist=25"];
    for (let skip = 0; skip < parts.length; skip++) {
      const partial = parts.filter((_, i) => i !== skip).join("&");
      expect(bad(partial), partial).toMatch(/needs a place name, latitude, longitude and radius/);
    }
    expect(bad("place=Myakka&lat=27.2&lng=-82.3&dist=")).toMatch(/radius/i);
    expect(bad("lat=27.2&lng=-82.3")).toMatch(/needs a place name/);
  });

  it("rejects malformed coordinates, radii and place names", () => {
    for (const [field, value] of [
      ["lat", "90.0001"],
      ["lat", "-91"],
      ["lat", "abc"],
      ["lat", "1e1"],
      ["lat", "Infinity"],
      ["lat", "0x10"],
      ["lng", "180.5"],
      ["lng", "-181"],
      ["lng", "NaN"],
      ["dist", "0"],
      ["dist", "201"],
      ["dist", "2.5"],
      ["dist", "25.0"],
      ["dist", "-5"],
      ["dist", "ten"],
    ] as const) {
      const p = new URLSearchParams("place=P&lat=27.2&lng=-82.3&dist=25");
      p.set(field, value);
      expect(parseGuideLocation(p).ok, `${field}=${value}`).toBe(false);
    }
    const long = new URLSearchParams({ place: "x".repeat(201), lat: "1", lng: "1", dist: "5" });
    expect(parseGuideLocation(long)).toMatchObject({ ok: false });
    const max = new URLSearchParams({ place: "x".repeat(200), lat: "1", lng: "1", dist: "5" });
    expect(parseGuideLocation(max)).toMatchObject({ ok: true });
  });

  it("rejects malformed codes and conflicting ancestry with a clear message", () => {
    expect(bad("country=invalid")).toBe("Choose a recognized country.");
    expect(bad("country=US-FL")).toBe("Choose a recognized country.");
    expect(bad("region=US")).toBe("Choose a recognized state or region.");
    expect(bad("region=US-FL-115")).toBe("Choose a recognized state or region.");
    expect(bad("country=CA&region=US-FL")).toBe("That region is not in the selected country.");
    expect(bad("county=US-FL")).toBe("Choose a recognized county.");
    expect(bad("region=US-GA&county=US-FL-115")).toBe("That county is not in the selected state or region.");
    expect(bad("country=CA&county=US-FL-115")).toBe("That county is not in the selected country.");
    expect(bad("county=US-FL-115&hotspot=P123")).toBe("Choose a recognized eBird hotspot.");
    expect(bad("county=US-FL-115&hotspot=L12x")).toBe("Choose a recognized eBird hotspot.");
    expect(bad("region=US-FL&hotspot=L299291")).toBe("Choose the county before choosing a hotspot.");
    expect(bad("hotspot=L299291")).toBe("Choose the county before choosing a hotspot.");
  });

  it("rejects a repeated geography parameter instead of picking one", () => {
    expect(bad("country=US&country=CA")).toBe("Use only one country value.");
    expect(bad("place=A&place=B&lat=1&lng=1&dist=5")).toBe("Use only one place value.");
  });
});

describe("canonical URLs", () => {
  it("emits exactly the frozen parameter shapes", () => {
    const pairs = (qs: string) => new URLSearchParams(guideLocationPairs(ok(qs))).toString();
    expect(pairs("")).toBe("");
    expect(pairs("country=US")).toBe("country=US");
    expect(pairs("region=US-FL")).toBe("country=US&region=US-FL");
    expect(pairs("county=US-FL-115")).toBe("country=US&region=US-FL&county=US-FL-115");
    expect(pairs("county=US-FL-115&hotspot=L299291")).toBe(
      "country=US&region=US-FL&county=US-FL-115&hotspot=L299291",
    );
    expect(pairs(MAP)).toBe(MAP);
  });

  it("round-trips every kind through parse", () => {
    for (const qs of [
      "country=US",
      "country=US&region=US-FL",
      "country=US&region=US-FL&county=US-FL-115",
      "country=US&region=US-FL&county=US-FL-115&hotspot=L299291",
      MAP,
    ]) {
      const first = ok(qs);
      expect(ok(new URLSearchParams(guideLocationPairs(first)).toString())).toEqual(first);
    }
  });

  it("rounds generated coordinates to six decimals", () => {
    const sel = guideMapSelection({ place: "P", lat: 27.24050312345, lng: -82.3148, dist: 25 });
    expect(sel.ok && new URLSearchParams(guideLocationPairs(sel.selection)).get("lat")).toBe("27.240503");
    expect(sel.ok && new URLSearchParams(guideLocationPairs(sel.selection)).get("lng")).toBe("-82.314800");
  });
});

describe("hierarchy transitions", () => {
  const base = new URLSearchParams(
    "q=owl&family=strigi&sort=name&interest=1&tags=habitat%3Amudflat&tags=tide%3Alow&future=kept&country=US&region=US-FL&county=US-FL-115&hotspot=L299291&page=3",
  );

  it("lists the deeper levels of each level", () => {
    expect(descendantsOf("country")).toEqual(["region", "county", "hotspot"]);
    expect(descendantsOf("region")).toEqual(["county", "hotspot"]);
    expect(descendantsOf("county")).toEqual(["hotspot"]);
    expect(descendantsOf("hotspot")).toEqual([]);
  });

  it("changing a country clears region, county and hotspot only", () => {
    const next = withGuideLevel(base, "country", "ca");
    expect(next.get("country")).toBe("CA");
    for (const gone of ["region", "county", "hotspot", "page"]) expect(next.has(gone), gone).toBe(false);
  });

  it("changing a region keeps the country and clears county and hotspot", () => {
    const next = withGuideLevel(base, "region", "US-GA");
    expect(next.get("country")).toBe("US");
    expect(next.get("region")).toBe("US-GA");
    for (const gone of ["county", "hotspot", "page"]) expect(next.has(gone), gone).toBe(false);
  });

  it("changing a county keeps ancestors and clears only the hotspot", () => {
    const next = withGuideLevel(base, "county", "US-FL-057");
    expect(next.get("county")).toBe("US-FL-057");
    expect(next.get("region")).toBe("US-FL");
    expect(next.get("country")).toBe("US");
    expect(next.has("hotspot")).toBe(false);
    expect(next.has("page")).toBe(false);
  });

  it("setting a hotspot keeps the whole ancestry and resets the page", () => {
    const next = withGuideLevel(base, "hotspot", "L1");
    expect(next.get("hotspot")).toBe("L1");
    expect(next.get("county")).toBe("US-FL-115");
    expect(next.has("page")).toBe(false);
  });

  it("an empty value clears that level and below, keeping ancestors", () => {
    const next = withGuideLevel(base, "region", "");
    expect(next.get("country")).toBe("US");
    for (const gone of ["region", "county", "hotspot"]) expect(next.has(gone)).toBe(false);
  });

  it("fills ancestors the shape implies when a deeper level is set directly", () => {
    const next = withGuideLevel(new URLSearchParams("q=owl"), "county", "us-fl-115");
    expect(next.toString()).toBe("q=owl&county=US-FL-115&region=US-FL&country=US");
    expect(ok(next.toString())).toMatchObject({ kind: "county", country: "US" });
  });

  it("choosing a hierarchy level removes any map selection", () => {
    const withMap = new URLSearchParams(`${MAP}&q=owl`);
    const next = withGuideLevel(withMap, "country", "US");
    for (const gone of ["place", "lat", "lng", "dist"]) expect(next.has(gone)).toBe(false);
    expect(next.get("q")).toBe("owl");
    expect(ok(next.toString())).toEqual({ kind: "country", country: "US" });
  });

  it("preserves every unrelated and unknown parameter through every transition", () => {
    const keep = ["q=owl", "family=strigi", "sort=name", "interest=1", "future=kept"];
    for (const next of [
      withGuideLevel(base, "country", "CA"),
      withGuideLevel(base, "region", ""),
      withGuideLevel(base, "county", "US-FL-057"),
      clearGuideLocation(base),
      withGuideLocation(base, ok(MAP)),
    ]) {
      for (const pair of keep) {
        const [k, v] = pair.split("=");
        expect(next.get(k), `${k}`).toBe(v);
      }
      expect(next.getAll("tags")).toEqual(["habitat:mudflat", "tide:low"]);
      expect(next.has("page")).toBe(false);
    }
  });
});

describe("map/radius and clear transitions", () => {
  const base = new URLSearchParams(
    "q=owl&future=kept&country=US&region=US-FL&county=US-FL-115&page=2",
  );

  it("applying a map point clears all hierarchical parameters and resets the page", () => {
    const next = withGuideLocation(base, ok(MAP));
    for (const gone of ["country", "region", "county", "hotspot", "page"]) expect(next.has(gone), gone).toBe(false);
    expect(next.get("place")).toBe("Myakka River SP");
    expect(next.get("dist")).toBe("25");
    expect(next.get("future")).toBe("kept");
  });

  it("clearing removes every geographic parameter and nothing else", () => {
    const cleared = clearGuideLocation(new URLSearchParams(`${MAP}&q=owl&future=kept&tags=habitat%3Amudflat&page=4`));
    for (const name of GUIDE_LOCATION_PARAMS) expect(cleared.has(name), name).toBe(false);
    expect(cleared.toString()).toBe("q=owl&future=kept&tags=habitat%3Amudflat");
    expect(guideResultsHref(cleared)).toBe("/species?q=owl&future=kept&tags=habitat%3Amudflat#results");
    expect(guideResultsHref(clearGuideLocation(new URLSearchParams("country=US")))).toBe("/species#results");
  });

  it("builds an apply URL from the picker and validates the radius before navigating", () => {
    const built = guideMapHref(base, { place: "  Myakka River SP ", lat: 27.240503, lng: -82.314817, dist: 25 });
    expect(built).toEqual({
      ok: true,
      href: "/species?q=owl&future=kept&place=Myakka+River+SP&lat=27.240503&lng=-82.314817&dist=25#results",
    });
    expect(guideMapHref(base, { place: "P", lat: 1, lng: 1, dist: 0 })).toMatchObject({ ok: false });
    expect(guideMapHref(base, { place: "P", lat: 1, lng: 1, dist: 201 })).toMatchObject({ ok: false });
    expect(guideMapHref(base, { place: "P", lat: 1, lng: 1, dist: 2.5 })).toMatchObject({ ok: false });
    expect(guideMapHref(base, { place: "P", lat: NaN, lng: 1, dist: 5 })).toMatchObject({ ok: false });
    expect(guideMapHref(base, { place: "   ", lat: 1, lng: 1, dist: 5 })).toMatchObject({ ok: false });
    const long = guideMapHref(base, { place: "y".repeat(300), lat: 1, lng: 1, dist: 5 });
    expect(long.ok && new URL(long.href, "http://x").searchParams.get("place")).toHaveLength(200);
  });
});

describe("coverage wording", () => {
  const view = (over: Partial<GuideLocationView>): GuideLocationView => ({
    kind: "county",
    label: "Sarasota County",
    sourceCount: 124,
    wholeArea: true,
    beginYear: 2016,
    endYear: 2025,
    map: null,
    ...over,
  });

  it("names the type, label, source count, years and a whole-area source", () => {
    const { status, text } = guideCoverage(view({ officialCountyName: true }));
    expect(status).toBe("whole-area");
    expect(text).toContain("Sarasota County (county)");
    const unknown = guideCoverage(view({ label: "Cornwall", officialCountyName: false }));
    expect(unknown.text).toContain("Cornwall (county or equivalent)");
    expect(text).toContain("2016–2025");
    expect(text).toContain("124 loaded sources");
    expect(text).toContain("including the whole-area source");
    expect(text).toContain("recorded presence, not a complete list");
  });

  it("says places without loaded data are not covered when only components are loaded", () => {
    const { status, text } = guideCoverage(view({ wholeArea: false, sourceCount: 1 }));
    expect(status).toBe("component-only");
    expect(text).toContain("1 loaded source;");
    expect(text).toContain("no whole-area source is loaded");
    expect(text).toContain("places without loaded data are not covered");
    expect(text).not.toContain("including the whole-area source");
  });

  it("treats zero sources as unavailable, never as zero birds", () => {
    for (const kind of ["country", "region", "county", "hotspot"] as const) {
      const { status, text } = guideCoverage(view({ kind, sourceCount: 0, wholeArea: false, beginYear: null, endYear: null }));
      expect(status).toBe("unavailable");
      expect(text).toContain("does not mean there are no birds here");
      expect(text).not.toMatch(/0 (birds|species)/);
    }
  });

  it("describes an exact hotspot as narrower than its county", () => {
    const { status, text } = guideCoverage(view({ kind: "hotspot", label: "Myakka River SP", sourceCount: 1, wholeArea: false }));
    expect(status).toBe("hotspot");
    expect(text).toContain("verified eBird hotspot");
    expect(text).toContain("Only this hotspot's own loaded data is used");
  });

  it("describes radius coverage with its evaluated count and the coordinate-missing disclosure", () => {
    const map = { place: "Myakka River SP", dist: 25, coordinateMissing: 4887 };
    const radius = guideCoverage(view({ kind: "map", label: "Myakka River SP", sourceCount: 99, wholeArea: false, map }));
    expect(radius.status).toBe("radius");
    expect(radius.text).toContain("99 loaded eBird hotspots within 25 miles of Myakka River SP");
    expect(radius.text).toContain("4887 loaded hotspots have no recorded coordinates and could not be evaluated");
    expect(radius.text).toContain("region-wide data is not used");
    expect(radius.text).toContain("map view is not a boundary");
    const one = guideCoverage(view({ kind: "map", sourceCount: 1, wholeArea: false, map: { ...map, dist: 1, coordinateMissing: 1 } }));
    expect(one.text).toContain("1 loaded eBird hotspot within 1 mile of");
    expect(one.text).toContain("1 loaded hotspot has no recorded coordinates");
    const none = guideCoverage(view({ kind: "map", sourceCount: 0, wholeArea: false, beginYear: null, endYear: null, map }));
    expect(none.status).toBe("unavailable");
    expect(none.text).toContain("25-mile circle around Myakka River SP is unavailable");
    expect(none.text).toContain("does not mean there are no birds here");
  });

  it("names the exact selected type in the scope chip without inventing a county suffix", () => {
    expect(guideScopeText({ kind: "county", label: "Sarasota County", map: null, officialCountyName: true })).toBe("Sarasota County");
    expect(guideScopeText({ kind: "county", label: "Cornwall", map: null, officialCountyName: false })).toBe("Cornwall · county or equivalent");
    expect(guideScopeText({ kind: "hotspot", label: "Myakka River SP", map: null })).toBe("Myakka River SP · verified eBird hotspot");
    expect(guideScopeText({ kind: "region", label: "Florida, United States", map: null })).toBe("Florida, United States");
    expect(guideScopeText({ kind: "map", label: "Myakka River SP", map: { place: "Myakka River SP", dist: 25, coordinateMissing: 0 } })).toBe("Within 25 miles of Myakka River SP");
  });
});

describe("native (no-JavaScript) level changes", () => {
  /** The canonical parameters of a well-formed native submission. */
  const canon = (p: URLSearchParams) => {
    const r = canonicalizeGuideLevelChange(p);
    if (r === null) return null;
    if (!r.ok) throw new Error(r.message);
    return r.params;
  };
  const applied = "q=owl&family=strigi&sort=name&tags=habitat%3Amudflat&future=kept";
  const HOTSPOT = "country=US&region=US-FL&county=US-FL-115&hotspot=L299291";
  const was = (qs: string) => new URLSearchParams(guideWasPairs(ok(qs))).toString();
  /** The submission a browser makes: hidden state, "was" values, then the selects. */
  const submit = (appliedGeo: string, level: string, value: string) => {
    const p = new URLSearchParams(applied);
    for (const [k, v] of guideWasPairs(ok(appliedGeo))) p.append(k, v);
    const values = Object.fromEntries(guideLocationPairs(ok(appliedGeo)));
    const levels = ["country", "region", "county", "hotspot"];
    levels.forEach((l, i) => {
      // A select is disabled, and so not submitted, while its parent is empty.
      const enabled = i === 0 || !!values[levels[i - 1]];
      if (enabled) p.append(l, l === level ? value : (values[l] ?? ""));
    });
    return p;
  };
  const geo = (p: URLSearchParams | null) =>
    p ? Object.fromEntries(["country", "region", "county", "hotspot"].filter((k) => p.has(k)).map((k) => [k, p.get(k)])) : null;

  it("emits one 'was' value per level for the applied selection, empty when unselected", () => {
    expect(GUIDE_WAS_PARAMS).toEqual(["was_country", "was_region", "was_county", "was_hotspot"]);
    expect(was("")).toBe("was_country=&was_region=&was_county=&was_hotspot=");
    expect(was("country=US")).toBe("was_country=US&was_region=&was_county=&was_hotspot=");
    expect(was(HOTSPOT)).toBe("was_country=US&was_region=US-FL&was_county=US-FL-115&was_hotspot=L299291");
    expect(was(MAP)).toBe("was_country=&was_region=&was_county=&was_hotspot=");
  });

  it("does nothing to a copied link: no 'was' values means strict validation still decides", () => {
    expect(canonicalizeGuideLevelChange(new URLSearchParams(`${applied}&country=CA&region=US-FL`))).toBeNull();
    expect(bad("country=CA&region=US-FL")).toBe("That region is not in the selected country.");
  });

  it("changing the country from a county or hotspot drops every stale lower value", () => {
    for (const from of [HOTSPOT, "country=US&region=US-FL&county=US-FL-115"]) {
      const next = canon(submit(from, "country", "CA"));
      expect(geo(next)).toEqual({ country: "CA" });
      expect(ok(next!.toString())).toEqual({ kind: "country", country: "CA" });
    }
  });

  it("changing the state or region from a county or hotspot keeps the country and drops county and hotspot", () => {
    for (const from of [HOTSPOT, "country=US&region=US-FL&county=US-FL-115"]) {
      const next = canon(submit(from, "region", "US-GA"));
      expect(geo(next)).toEqual({ country: "US", region: "US-GA" });
      expect(ok(next!.toString())).toMatchObject({ kind: "region", region: "US-GA" });
    }
  });

  it("changing the county from a hotspot keeps ancestors and drops the hotspot", () => {
    const next = canon(submit(HOTSPOT, "county", "US-FL-057"));
    expect(geo(next)).toEqual({ country: "US", region: "US-FL", county: "US-FL-057" });
    expect(ok(next!.toString())).toMatchObject({ kind: "county", county: "US-FL-057" });
  });

  it("changing only the hotspot keeps the whole ancestry", () => {
    const next = canon(submit(HOTSPOT, "hotspot", "L1"));
    expect(geo(next)).toEqual({ country: "US", region: "US-FL", county: "US-FL-115", hotspot: "L1" });
  });

  it("clearing each level clears it and everything below, keeping ancestors", () => {
    expect(geo(canon(submit(HOTSPOT, "country", "")))).toEqual({});
    expect(geo(canon(submit(HOTSPOT, "region", "")))).toEqual({ country: "US" });
    expect(geo(canon(submit(HOTSPOT, "county", "")))).toEqual({ country: "US", region: "US-FL" });
    expect(geo(canon(submit(HOTSPOT, "hotspot", "")))).toEqual({ country: "US", region: "US-FL", county: "US-FL-115" });
    expect(ok(canon(submit(HOTSPOT, "country", ""))!.toString())).toEqual({ kind: "anywhere" });
  });

  it("choosing a first country from Anywhere works", () => {
    expect(geo(canon(submit("", "country", "US")))).toEqual({ country: "US" });
  });

  it("a submission that changed no level (only sort, say) keeps the applied selection", () => {
    const p = submit(HOTSPOT, "hotspot", "L299291");
    p.set("sort", "taxonomic");
    const next = canon(p)!;
    expect(geo(next)).toEqual({ country: "US", region: "US-FL", county: "US-FL-115", hotspot: "L299291" });
    expect(next.get("sort")).toBe("taxonomic");
  });

  it("resets the page, removes the transient values, and preserves every other parameter", () => {
    const p = submit(HOTSPOT, "country", "CA");
    p.set("page", "4");
    const next = canon(p)!;
    for (const name of [...GUIDE_WAS_PARAMS, "page"]) expect(next.has(name), name).toBe(false);
    for (const [k, v] of [["q", "owl"], ["family", "strigi"], ["sort", "name"], ["future", "kept"]]) expect(next.get(k), k).toBe(v);
    expect(next.getAll("tags")).toEqual(["habitat:mudflat"]);
    // Canonical output carries no intent, so it is never canonicalized twice.
    expect(canon(next)).toBeNull();
  });

  it("normalizes case and still leaves a genuinely conflicting map mix to strict validation", () => {
    expect(geo(canon(new URLSearchParams("was_country=us&was_region=us-fl&was_county=&was_hotspot=&country=ca&region=us-fl")))).toEqual({ country: "CA" });
    const mixed = canon(new URLSearchParams(`was_country=&was_region=&was_county=&was_hotspot=&country=US&${MAP}`))!;
    expect(bad(mixed.toString())).toMatch(/not both/);
  });

  it("rejects a partial, repeated or duplicated-hierarchy intent instead of sanitizing it", () => {
    const wasAll = "was_country=&was_region=&was_county=&was_hotspot=";
    const reject = (qs: string) => {
      const r = canonicalizeGuideLevelChange(new URLSearchParams(qs));
      if (r === null || r.ok) throw new Error(`expected rejection for ${qs}`);
      return r.message;
    };
    // Partial: any "was" field without the other three.
    expect(reject("was_country=US&country=US")).toBe("The location form values are incomplete or repeated.");
    expect(reject("was_hotspot=&country=US")).toBe("The location form values are incomplete or repeated.");
    expect(reject("was_country=&was_region=&was_county=&country=US")).toBe("The location form values are incomplete or repeated.");
    // Repeated "was" field.
    expect(reject(`${wasAll}&was_country=US&country=US`)).toBe("The location form values are incomplete or repeated.");
    // Valid intent but a repeated hierarchy parameter (would otherwise be hidden by delete/append).
    expect(reject(`${wasAll}&country=US&country=CA`)).toBe("Use only one country value.");
    expect(reject(`${wasAll}&country=US&region=US-FL&region=US-GA`)).toBe("Use only one region value.");
    expect(reject(`${wasAll}&country=US&region=US-FL&county=US-FL-115&county=US-FL-057`)).toBe("Use only one county value.");
    expect(reject(`${wasAll}&country=US&region=US-FL&county=US-FL-115&hotspot=L1&hotspot=L2`)).toBe("Use only one hotspot value.");
    // A well-formed one is accepted, including an omitted disabled select.
    expect(canonicalizeGuideLevelChange(new URLSearchParams(`${wasAll}&country=US`))).toMatchObject({ ok: true });
  });
});

describe("parseGuideChoicesRequest (td-daff98)", () => {
  const parse = (q: string) => parseGuideChoicesRequest(new URLSearchParams(q));
  it("accepts one level with a parent of the matching shape", () => {
    expect(parse("level=region&parent=us")).toEqual({ ok: true, level: "region", parent: "US" });
    expect(parse("level=county&parent=US-FL")).toEqual({ ok: true, level: "county", parent: "US-FL" });
    expect(parse("level=hotspot&parent=US-FL-115")).toEqual({ ok: true, level: "hotspot", parent: "US-FL-115" });
  });
  it("rejects missing, blank, repeated and extra keys", () => {
    for (const q of ["", "level=region", "parent=US", "level=&parent=US", "level=region&parent=%20", "level=region&level=county&parent=US", "level=region&parent=US&parent=CA", "level=region&parent=US&x=1"])
      expect(parse(q).ok, q).toBe(false);
  });
  it("rejects an unknown level and a parent of the wrong level", () => {
    for (const q of ["level=country&parent=US", "level=region&parent=US-FL", "level=county&parent=US", "level=hotspot&parent=US-FL", "level=hotspot&parent=L123"])
      expect(parse(q).ok, q).toBe(false);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NO_LOADING,
  PlaceChoiceLoader,
  PlaceListsController,
  childLevel,
  hotspotParent,
  listParent,
  type PlaceListsState,
  fetchGuideChoices,
  guideDraftKey,
  placeLevels,
  toggledTag,
  withDraftLevel,
  type GuideDraft,
} from "./guide-draft";
import { parseGuideLocation } from "./guide-location";

const base: GuideDraft = { interest: false, family: "", sort: "relevance", tags: [], place: { kind: "anywhere" } };

afterEach(() => vi.unstubAllGlobals());

function applied(query: string, tags: string[] = []): GuideDraft {
  // Mirrors what the loader hands the page: normalized selection and tags.
  const parsed = parseGuideLocation(new URLSearchParams(query));
  if (!parsed.ok) throw new Error(parsed.message);
  return { ...base, tags, place: parsed.selection };
}

describe("guideDraftKey", () => {
  it("is equal for the same applied state however the URL was written", () => {
    expect(guideDraftKey(applied("country=us&region=us-fl"))).toBe(
      guideDraftKey(applied("region=US-FL")),
    );
    expect(guideDraftKey({ ...base, tags: ["b:y", "a:x", "a:x"] })).toBe(
      guideDraftKey({ ...base, tags: ["a:x", "b:y"] }),
    );
  });
  it("omits defaults so an empty panel matches a plain page", () => {
    expect(guideDraftKey(base)).toBe("");
  });
  it("changes on any real edit", () => {
    const start = guideDraftKey(base);
    expect(guideDraftKey({ ...base, interest: true })).not.toBe(start);
    expect(guideDraftKey({ ...base, family: "fal1" })).not.toBe(start);
    expect(guideDraftKey({ ...base, sort: "name" })).not.toBe(start);
    expect(guideDraftKey({ ...base, tags: ["habitat:grassland"] })).not.toBe(start);
    expect(guideDraftKey({ ...base, place: { kind: "country", country: "US" } })).not.toBe(start);
  });
});

describe("toggledTag", () => {
  it("returns a new sorted list on each toggle and never mutates the input", () => {
    const first: string[] = [];
    const second = toggledTag(first, "habitat:grassland");
    const third = toggledTag(second, "find:conspicuous");
    const fourth = toggledTag(third, "habitat:grassland");
    expect(first).toEqual([]);
    expect(second).toEqual(["habitat:grassland"]);
    expect(third).toEqual(["find:conspicuous", "habitat:grassland"]);
    expect(fourth).toEqual(["find:conspicuous"]);
    expect(third).not.toBe(second);
  });
});

describe("withDraftLevel", () => {
  const hotspot = applied("country=US&region=US-FL&county=US-FL-115&hotspot=L123456");
  it("keeps ancestors and clears every deeper level", () => {
    expect(withDraftLevel(hotspot.place, "region", "US-GA")).toEqual({
      kind: "region",
      country: "US",
      region: "US-GA",
    });
    expect(withDraftLevel(hotspot.place, "country", "CA")).toEqual({ kind: "country", country: "CA" });
  });
  it("clearing a level leaves its parent chosen", () => {
    expect(withDraftLevel(hotspot.place, "county", "")).toEqual({
      kind: "region",
      country: "US",
      region: "US-FL",
    });
    expect(withDraftLevel(hotspot.place, "country", "")).toEqual({ kind: "anywhere" });
  });
  it("replaces a map point (hierarchy XOR map)", () => {
    const map = { kind: "map" as const, place: "X", lat: 1, lng: 2, dist: 5 };
    expect(withDraftLevel(map, "country", "US")).toEqual({ kind: "country", country: "US" });
    expect(placeLevels(map)).toEqual({ country: "", region: "", county: "", hotspot: "" });
  });
  it("keeps a hotspot with no county: one eBird records directly under the state (td-327dd6)", () => {
    const region = applied("country=NO&region=NO-18").place;
    expect(withDraftLevel(region, "hotspot", "l1")).toEqual({
      kind: "hotspot", country: "NO", region: "NO-18", county: null, hotspot: "L1",
    });
    const direct = withDraftLevel(region, "hotspot", "L1");
    expect(withDraftLevel(direct, "hotspot", "")).toEqual({ kind: "region", country: "NO", region: "NO-18" });
    expect(withDraftLevel(direct, "county", "NO-18-001")).toEqual({
      kind: "county", country: "NO", region: "NO-18", county: "NO-18-001",
    });
  });
  it("hangs the hotspot list under the county, else the state", () => {
    expect(hotspotParent({ country: "US", region: "US-FL", county: "US-FL-115", hotspot: "" })).toBe("US-FL-115");
    expect(hotspotParent({ country: "US", region: "US-FL", county: "", hotspot: "" })).toBe("US-FL");
    expect(hotspotParent({ country: "US", region: "", county: "", hotspot: "" })).toBe("");
    expect(listParent("county", { country: "US", region: "US-FL", county: "", hotspot: "" })).toBe("US-FL");
    expect(listParent("region", { country: "US", region: "", county: "", hotspot: "" })).toBe("US");
  });
  it("names the level each choice unlocks", () => {
    expect(childLevel("country")).toBe("region");
    expect(childLevel("county")).toBe("hotspot");
    expect(childLevel("hotspot")).toBeNull();
  });
});

describe("PlaceChoiceLoader", () => {
  function deferredFetcher() {
    const pending: { level: string; parent: string; resolve: (v: { code: string; name: string }[]) => void; signal: AbortSignal }[] = [];
    const fetcher = (level: string, parent: string, signal: AbortSignal) =>
      new Promise<{ code: string; name: string }[]>((resolve) => pending.push({ level, parent, resolve, signal }));
    return { pending, fetcher };
  }

  it("delivers a current response", async () => {
    const { pending, fetcher } = deferredFetcher();
    const loader = new PlaceChoiceLoader(fetcher);
    let county = "US-FL";
    const result = loader.load("county", "US-FL", () => county);
    pending[0].resolve([{ code: "US-FL-115", name: "Sarasota" }]);
    expect(await result).toEqual({ status: "ok", choices: [{ code: "US-FL-115", name: "Sarasota" }] });
    county = "";
  });

  it("drops a county list for an old state after the COUNTRY changes (ancestor switch)", async () => {
    const { pending, fetcher } = deferredFetcher();
    const loader = new PlaceChoiceLoader(fetcher);
    let region = "US-FL";
    const oldCounties = loader.load("county", "US-FL", () => region);
    // Country changes: region is cleared, no new county request is started.
    loader.invalidate();
    region = "";
    expect(pending[0].signal.aborted).toBe(true);
    pending[0].resolve([{ code: "US-FL-115", name: "Sarasota" }]);
    expect(await oldCounties).toEqual({ status: "stale" });
  });

  it("drops out-of-order same-level responses", async () => {
    const { pending, fetcher } = deferredFetcher();
    const loader = new PlaceChoiceLoader(fetcher);
    let region = "US-FL";
    const first = loader.load("county", "US-FL", () => region);
    loader.invalidate();
    region = "US-GA";
    const second = loader.load("county", "US-GA", () => region);
    pending[1].resolve([{ code: "US-GA-001", name: "Appling" }]);
    pending[0].resolve([{ code: "US-FL-115", name: "Sarasota" }]);
    expect(await second).toEqual({ status: "ok", choices: [{ code: "US-GA-001", name: "Appling" }] });
    expect(await first).toEqual({ status: "stale" });
  });

  it("reports a failure for the current parent and serves the memo afterwards", async () => {
    let fail = true;
    const loader = new PlaceChoiceLoader(async () => {
      if (fail) throw new Error("Couldn't load choices (HTTP 500).");
      return [{ code: "L1", name: "Pond" }];
    });
    expect(await loader.load("hotspot", "US-FL-115", () => "US-FL-115")).toEqual({
      status: "error",
      message: "Couldn't load choices (HTTP 500).",
    });
    fail = false;
    expect(await loader.load("hotspot", "US-FL-115", () => "US-FL-115")).toEqual({
      status: "ok",
      choices: [{ code: "L1", name: "Pond" }],
    });
    expect(loader.cached("hotspot", "US-FL-115")).toEqual([{ code: "L1", name: "Pond" }]);
  });
});

describe("fetchGuideChoices", () => {
  it("accepts the endpoint contract and rejects malformed JSON as an error, not an empty list", async () => {
    const signal = new AbortController().signal;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            level: "county",
            parent: "US-FL",
            choices: [{ code: "US-FL-115", name: "Sarasota" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    await expect(fetchGuideChoices("county", "US-FL", signal)).resolves.toEqual([
      { code: "US-FL-115", name: "Sarasota" },
    ]);

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: "not-an-array" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(fetchGuideChoices("county", "US-FL", signal)).rejects.toThrow(
      "invalid response",
    );
  });
});

describe("PlaceListsController (td-327dd6, CODEX1)", () => {
  type Pending = { level: string; parent: string; resolve: (v: { code: string; name: string }[]) => void; reject: (e: Error) => void; signal: AbortSignal };
  const FL_COUNTIES = [{ code: "US-FL-115", name: "Sarasota" }];
  const FL_DIRECT = [{ code: "L3499263", name: "Everglades NP" }];
  const COUNTY_SPOTS = [{ code: "L299291", name: "Myakka River SP" }];

  const US_STATES = [{ code: "US-FL", name: "Florida" }];
  /** Starts like the page: the applied place's lists come with it, seeded. */
  function setup(start: string, seed: (loader: PlaceChoiceLoader) => void = () => {}) {
    const pending: Pending[] = [];
    const loader = new PlaceChoiceLoader(
      (level, parent, signal) =>
        new Promise((resolve, reject) => pending.push({ level, parent, resolve, reject, signal })),
    );
    loader.seed("region", "US", US_STATES);
    seed(loader);
    let place = applied(start).place;
    const levels = placeLevels(place);
    let state: PlaceListsState = {
      lists: {
        region: US_STATES,
        county: (levels.region && loader.cached("county", levels.region)) || [],
        hotspot: (hotspotParent(levels) && loader.cached("hotspot", hotspotParent(levels))) || [],
      },
      loading: { ...NO_LOADING },
      errors: {},
    };
    const lists = new PlaceListsController(
      loader,
      () => state,
      (patch) => (state = { ...state, ...patch }),
      () => placeLevels(place),
    );
    const choose = (level: "country" | "region" | "county" | "hotspot", code: string) => {
      place = withDraftLevel(place, level, code);
      return lists.afterChoice(level);
    };
    const flush = () => new Promise((r) => setTimeout(r, 0));
    return { pending, lists, choose, flush, get state() { return state; } };
  }

  it("choosing a state loads its counties, then its own hotspots", async () => {
    const t = setup("country=US");
    const done = t.choose("region", "US-FL");
    await t.flush();
    expect(t.pending.map((p) => `${p.level}:${p.parent}`)).toEqual(["county:US-FL"]);
    expect(t.state.loading).toMatchObject({ county: true, hotspot: false });
    t.pending[0].resolve(FL_COUNTIES);
    await t.flush();
    expect(t.pending.map((p) => `${p.level}:${p.parent}`)).toEqual(["county:US-FL", "hotspot:US-FL"]);
    expect(t.state.loading).toMatchObject({ county: false, hotspot: true });
    t.pending[1].resolve(FL_DIRECT);
    await done;
    expect(t.state.lists).toEqual({ region: US_STATES, county: FL_COUNTIES, hotspot: FL_DIRECT });
    expect(t.state.loading).toEqual(NO_LOADING);
  });

  it("a county failure keeps its own error; the state's hotspots still load, and Retry fixes counties only", async () => {
    const t = setup("country=US");
    const done = t.choose("region", "US-FL");
    await t.flush();
    t.pending[0].reject(new Error("HTTP 503"));
    await t.flush();
    t.pending[1].resolve(FL_DIRECT);
    await done;
    expect(t.state.errors).toEqual({ county: { parent: "US-FL", message: "HTTP 503" } });
    expect(t.state.lists.hotspot).toEqual(FL_DIRECT);
    const retry = t.lists.load("county", "US-FL");
    expect(t.state.errors).toEqual({});
    await t.flush();
    t.pending[2].resolve(FL_COUNTIES);
    expect(await retry).toBe("ok");
    expect(t.state.lists).toMatchObject({ county: FL_COUNTIES, hotspot: FL_DIRECT });
  });

  it("a hotspot failure does not erase a county failure; each retries alone", async () => {
    const t = setup("country=US");
    const done = t.choose("region", "US-FL");
    await t.flush();
    t.pending[0].reject(new Error("counties down"));
    await t.flush();
    t.pending[1].reject(new Error("hotspots down"));
    await done;
    expect(Object.keys(t.state.errors).sort()).toEqual(["county", "hotspot"]);
    const retry = t.lists.load("hotspot", "US-FL");
    expect(Object.keys(t.state.errors)).toEqual(["county"]);
    await t.flush();
    t.pending[2].resolve(FL_DIRECT);
    await retry;
    expect(Object.keys(t.state.errors)).toEqual(["county"]);
  });

  it("picking one of the state's own hotspots while its counties load re-asks for the counties", async () => {
    // The state's own hotspots are already known (served with the page).
    const t = setup("country=US", (loader) => loader.seed("hotspot", "US-FL", FL_DIRECT));
    const done = t.choose("region", "US-FL");
    await t.flush();
    expect(t.pending.map((p) => `${p.level}:${p.parent}`)).toEqual(["county:US-FL"]);
    // Counties still loading; the person picks Everglades NP from the hotspot list.
    const pick = t.choose("hotspot", "L3499263");
    expect(t.pending[0].signal.aborted).toBe(true);
    await t.flush();
    expect(t.pending.map((p) => `${p.level}:${p.parent}`)).toEqual(["county:US-FL", "county:US-FL"]);
    t.pending[0].resolve([]); // the cancelled answer is ignored
    t.pending[1].resolve(FL_COUNTIES);
    await Promise.all([done, pick]);
    expect(t.state.lists.county).toEqual(FL_COUNTIES);
    expect(t.state.loading).toEqual(NO_LOADING);
  });

  it("clearing the county brings back the state's own hotspots without Apply", async () => {
    const t = setup("country=US&region=US-FL&county=US-FL-115", (loader) => {
      loader.seed("county", "US-FL", FL_COUNTIES);
      loader.seed("hotspot", "US-FL-115", COUNTY_SPOTS);
    });
    await t.lists.fill();
    expect(t.state.lists).toMatchObject({ county: FL_COUNTIES, hotspot: COUNTY_SPOTS });
    const cleared = t.choose("county", "");
    await t.flush();
    expect(t.pending.map((p) => `${p.level}:${p.parent}`)).toEqual(["hotspot:US-FL"]);
    t.pending[0].resolve(FL_DIRECT);
    await cleared;
    expect(t.state.lists.hotspot).toEqual(FL_DIRECT);
    // County again, then cleared again: both lists now come from the memo.
    await t.choose("county", "US-FL-115");
    expect(t.state.lists.hotspot).toEqual(COUNTY_SPOTS);
    await t.choose("county", "");
    expect(t.state.lists.hotspot).toEqual(FL_DIRECT);
    expect(t.pending).toHaveLength(1);
  });

  it("a country switch while lists load drops them, and loads nothing for the old state", async () => {
    const t = setup("country=US");
    const done = t.choose("region", "US-FL");
    await t.flush();
    const switched = t.choose("country", "CA");
    await t.flush();
    expect(t.pending.map((p) => `${p.level}:${p.parent}`)).toEqual(["county:US-FL", "region:CA"]);
    t.pending[0].resolve(FL_COUNTIES);
    t.pending[1].resolve([{ code: "CA-ON", name: "Ontario" }]);
    await Promise.all([done, switched]);
    expect(t.state.lists).toEqual({ region: [{ code: "CA-ON", name: "Ontario" }], county: [], hotspot: [] });
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PlaceChoiceLoader,
  childLevel,
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

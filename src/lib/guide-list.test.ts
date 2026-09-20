import { describe, expect, it } from "vitest";
import {
  GUIDE_LISTS,
  GUIDE_LIST_LABEL,
  GUIDE_LIST_MEANING,
  GUIDE_LIST_NOUN,
  guideListHref,
  parseGuideList,
  withGuideList,
} from "./guide-list";

const parse = (qs: string) => parseGuideList(new URLSearchParams(qs));

describe("parseGuideList", () => {
  it("treats an absent list as All without marking it explicit", () => {
    expect(parse("")).toEqual({ ok: true, list: "all", explicit: false });
    expect(parse("q=owl&county=US-FL-115&future=kept")).toEqual({ ok: true, list: "all", explicit: false });
  });

  it("accepts exactly all, need and seen as explicit scopes", () => {
    for (const list of GUIDE_LISTS) expect(parse(`list=${list}`)).toEqual({ ok: true, list, explicit: true });
  });

  it("rejects blank, unknown, differently-cased, padded and repeated values instead of guessing", () => {
    for (const qs of ["list=", "list=%20", "list=ALL", "list=Need", "list=%20need", "list=need%20", "list=both", "list=seen,need", "list=1", "list=null"])
      expect(parse(qs).ok, qs).toBe(false);
    expect(parse("list=all&list=need")).toEqual({ ok: false, message: "Use only one list value." });
    expect(parse("list=need&list=need")).toEqual({ ok: false, message: "Use only one list value." });
    expect(parse("list=")).toMatchObject({ message: "Choose a list: all, need or seen." });
    expect(parse("list=both")).toMatchObject({ message: "Choose a recognized list: all, need or seen." });
  });
});

describe("scope switching", () => {
  const base = new URLSearchParams(
    "q=owl&family=strigi&sort=name&interest=1&tags=habitat%3Amudflat&tags=tide%3Alow&country=US&region=US-FL&county=US-FL-115&future=kept&future=twice&page=4&list=seen",
  );

  it("changes only the scope and the stale page, preserving every other parameter and repeat", () => {
    for (const list of GUIDE_LISTS) {
      const next = withGuideList(base, list);
      expect(next.get("list")).toBe(list);
      expect(next.has("page")).toBe(false);
      expect(next.getAll("tags")).toEqual(["habitat:mudflat", "tide:low"]);
      expect(next.getAll("future")).toEqual(["kept", "twice"]);
      for (const [k, v] of [["q", "owl"], ["family", "strigi"], ["sort", "name"], ["interest", "1"], ["country", "US"], ["region", "US-FL"], ["county", "US-FL-115"]])
        expect(next.get(k), k).toBe(v);
    }
  });

  it("makes All canonical as list=all and targets the results fragment", () => {
    expect(guideListHref(new URLSearchParams(""), "all")).toBe("/species?list=all#results");
    expect(guideListHref(new URLSearchParams("q=owl&page=3"), "need")).toBe("/species?q=owl&list=need#results");
    expect(guideListHref(new URLSearchParams("list=seen&page=2&future=kept"), "all")).toBe("/species?list=all&future=kept#results");
  });

  it("names each scope in words", () => {
    expect(GUIDE_LIST_LABEL).toEqual({ all: "All", need: "Need", seen: "Seen" });
    expect(GUIDE_LIST_NOUN).toEqual({ all: "All species", need: "Need species", seen: "Seen species" });
    expect(GUIDE_LIST_MEANING.need).toContain("life list this page displays");
    expect(GUIDE_LIST_MEANING.seen).toContain("life list this page displays");
    expect(GUIDE_LIST_MEANING.need).not.toContain("your life list");
    expect(GUIDE_LIST_MEANING.seen).not.toContain("your life list");
  });
});

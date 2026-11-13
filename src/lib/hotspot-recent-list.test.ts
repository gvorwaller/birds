import { describe, expect, it } from "vitest";
import {
  filterRecentDays,
  hotspotRecentListHref,
  parseHotspotRecentList,
  recentListCounts,
} from "./hotspot-recent-list";

const r = (code: string, need: boolean) => ({ speciesCode: code, need });
const DAYS = [
  { date: "2026-11-13", reports: [r("shshaw", true), r("graspa", true), r("whiibi", false)] },
  { date: "2026-11-12", reports: [r("baleag", false)] },
  { date: "2026-11-11", reports: [r("lbbgul", true)] },
];

describe("parseHotspotRecentList", () => {
  const p = (q: string) => parseHotspotRecentList(new URLSearchParams(q));

  it("absent means All, so existing links render as before", () => {
    expect(p("")).toEqual({ list: "all", valid: true });
    expect(p("back=14")).toEqual({ list: "all", valid: true });
  });

  it("accepts exactly one all / need / seen", () => {
    expect(p("list=need")).toEqual({ list: "need", valid: true });
    expect(p("list=seen")).toEqual({ list: "seen", valid: true });
    expect(p("list=all")).toEqual({ list: "all", valid: true });
  });

  it("rejects unknown, blank, wrong-case or repeated values instead of guessing", () => {
    for (const q of ["list=needs", "list=", "list=Need", "list=need&list=seen"]) {
      expect(p(q)).toEqual({ list: "all", valid: false });
    }
  });
});

describe("hotspotRecentListHref", () => {
  const url = new URL("https://x.test/hotspots/L127286?back=14&returnTo=%2Fhotspots");

  it("keeps every other parameter and sets the lens", () => {
    const href = hotspotRecentListHref(url, "need");
    const q = new URLSearchParams(href.split("?")[1]);
    expect(href.startsWith("/hotspots/L127286?")).toBe(true);
    expect(q.get("back")).toBe("14");
    expect(q.get("returnTo")).toBe("/hotspots");
    expect(q.getAll("list")).toEqual(["need"]);
  });

  it("All is canonical without a list param", () => {
    const withNeed = new URL("https://x.test/hotspots/L1?list=need");
    expect(hotspotRecentListHref(withNeed, "all")).toBe("/hotspots/L1");
  });
});

describe("filterRecentDays", () => {
  it("All returns every day and report unchanged", () => {
    expect(filterRecentDays(DAYS, "all")).toEqual(DAYS);
  });

  it("Need keeps only needs and drops days left empty", () => {
    const out = filterRecentDays(DAYS, "need");
    expect(out.map((d) => d.date)).toEqual(["2026-11-13", "2026-11-11"]);
    expect(out[0].reports.map((x) => x.speciesCode)).toEqual(["shshaw", "graspa"]);
  });

  it("Seen keeps only seen species, in order", () => {
    const out = filterRecentDays(DAYS, "seen");
    expect(out.map((d) => [d.date, d.reports.map((x) => x.speciesCode)])).toEqual([
      ["2026-11-13", ["whiibi"]],
      ["2026-11-12", ["baleag"]],
    ]);
  });

  it("does not mutate the loaded days", () => {
    const before = JSON.stringify(DAYS);
    filterRecentDays(DAYS, "need");
    expect(JSON.stringify(DAYS)).toBe(before);
  });
});

describe("recentListCounts", () => {
  it("counts species per lens; All is Need + Seen", () => {
    expect(recentListCounts(DAYS)).toEqual({ all: 5, need: 3, seen: 2 });
    expect(recentListCounts([])).toEqual({ all: 0, need: 0, seen: 0 });
  });
});

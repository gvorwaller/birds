import { describe, expect, it } from "vitest";
import { homeListHref, parseHomeList } from "./home-list";

const params = (q: string) => new URLSearchParams(q);

describe("parseHomeList (td-ee2b56)", () => {
  it("defaults to Need so a bare Home URL is unchanged", () => {
    expect(parseHomeList(params(""))).toEqual({ list: "need", valid: true });
  });

  it("accepts exactly all, need or seen", () => {
    for (const list of ["all", "need", "seen"] as const) {
      expect(parseHomeList(params(`list=${list}`))).toEqual({
        list,
        valid: true,
      });
    }
  });

  it("flags blank, unknown, differently cased or repeated values for repair", () => {
    for (const q of [
      "list=",
      "list=everything",
      "list=All",
      "list=all&list=seen",
    ]) {
      expect(parseHomeList(params(q))).toEqual({ list: "need", valid: false });
    }
  });
});

describe("homeListHref", () => {
  const url = new URL(
    "https://example.test/?place=Bar+Harbor&dist=24&back=7&loc=L123",
  );

  it("keeps every other param, including the focused place", () => {
    const href = homeListHref(url, "all");
    const next = new URL(href, url);
    expect(next.pathname).toBe("/");
    expect(Object.fromEntries(next.searchParams)).toEqual({
      place: "Bar Harbor",
      dist: "24",
      back: "7",
      loc: "L123",
      list: "all",
    });
  });

  it("drops list for Need, the canonical default", () => {
    const withList = new URL("https://example.test/?back=7&list=seen&list=all");
    expect(homeListHref(withList, "need")).toBe("/?back=7");
    expect(
      homeListHref(new URL("https://example.test/?list=seen"), "need"),
    ).toBe("/");
  });
});

import { describe, expect, it } from "vitest";
import { homeUrlWithQuery, safeReturnTo } from "./return-link";

describe("homeUrlWithQuery", () => {
  it("maps a bare legacy URL to the canonical route", () => {
    expect(homeUrlWithQuery("")).toBe("/");
    expect(homeUrlWithQuery(null)).toBe("/");
    expect(homeUrlWithQuery("?")).toBe("/");
  });

  it("preserves every query parameter", () => {
    expect(homeUrlWithQuery("?place=Bar+Harbor%2C+ME&dist=25&back=7")).toBe(
      "/?place=Bar+Harbor%2C+ME&dist=25&back=7",
    );
  });

  it("accepts a query string with or without the leading question mark", () => {
    expect(homeUrlWithQuery("back=30")).toBe("/?back=30");
    expect(homeUrlWithQuery("?back=30")).toBe("/?back=30");
  });

  it("does not re-encode already-encoded values", () => {
    const search = "?place=Ha%C3%B1a%2C+HI&back=1";
    expect(homeUrlWithQuery(search)).toBe(`/${search}`);
  });
});

describe("safeReturnTo", () => {
  it("falls back to the canonical Home, not the legacy route", () => {
    expect(safeReturnTo(null)).toEqual({ href: "/", label: "Home" });
    expect(safeReturnTo("")).toEqual({ href: "/", label: "Home" });
  });

  it("rejects non-local and protocol-relative targets", () => {
    expect(safeReturnTo("https://evil.example/x")).toEqual({
      href: "/",
      label: "Home",
    });
    expect(safeReturnTo("//evil.example/x")).toEqual({
      href: "/",
      label: "Home",
    });
    expect(safeReturnTo("evil.example")).toEqual({ href: "/", label: "Home" });
  });

  it("labels the canonical Home view Home", () => {
    expect(safeReturnTo("/")).toEqual({ href: "/", label: "Home" });
    expect(safeReturnTo("/?place=Bar+Harbor%2C+ME&back=7")).toEqual({
      href: "/?place=Bar+Harbor%2C+ME&back=7",
      label: "Home",
    });
  });

  it("keeps legacy /targets links working and labels them Home", () => {
    expect(safeReturnTo("/targets")).toEqual({
      href: "/targets",
      label: "Home",
    });
    expect(safeReturnTo("/targets?place=Bar+Harbor%2C+ME&dist=25")).toEqual({
      href: "/targets?place=Bar+Harbor%2C+ME&dist=25",
      label: "Home",
    });
  });

  it("labels other local routes generically", () => {
    expect(safeReturnTo("/trips/4")).toEqual({
      href: "/trips/4",
      label: "Back",
    });
  });
});

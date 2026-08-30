import { describe, expect, it } from "vitest";
import { homeUrlWithQuery, returnTrail, safeReturnTo } from "./return-link";

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

  it("names known origin pages on the back link", () => {
    expect(safeReturnTo("/forecast?place=Blue+Hill%2C+ME&month=8")).toEqual({
      href: "/forecast?place=Blue+Hill%2C+ME&month=8",
      label: "Forecast",
    });
    // Most-specific prefix wins: /forecast/species is not labeled "Forecast".
    expect(safeReturnTo("/forecast/species?species=y00678&region=US-FL")).toEqual({
      href: "/forecast/species?species=y00678&region=US-FL",
      label: "Species forecast",
    });
    expect(safeReturnTo("/forecast/data")).toEqual({
      href: "/forecast/data",
      label: "Hotspots & data",
    });
    expect(safeReturnTo("/trips/4")).toEqual({
      href: "/trips/4",
      label: "Trips",
    });
  });

  it("labels unknown local routes generically", () => {
    expect(safeReturnTo("/settings")).toEqual({
      href: "/settings",
      label: "Back",
    });
  });
});

describe("Field guide returnTo (plan Phase 3)", () => {
  it("labels /species exact-or-query as Field guide; detail pages fall through to Back", () => {
    expect(safeReturnTo("/species")).toEqual({ href: "/species", label: "Field guide" });
    expect(safeReturnTo("/species?q=mudflat&tags=tide%3Alow")).toEqual({
      href: "/species?q=mudflat&tags=tide%3Alow",
      label: "Field guide",
    });
    expect(safeReturnTo("/species/margod")).toEqual({
      href: "/species/margod",
      label: "Back",
    });
  });
});

describe("returnTrail (species forecast breadcrumb, 2026-08-29)", () => {
  it("expands a species-page returnTo into guide → bird", () => {
    const nested = encodeURIComponent("/species?q=gull");
    expect(returnTrail(`/species/gbbgul?returnTo=${nested}`)).toEqual([
      { href: "/species?q=gull", label: "Field guide" },
      {
        href: `/species/gbbgul?returnTo=${nested}`,
        label: "Species",
        speciesCode: "gbbgul",
      },
    ]);
  });

  it("keeps whatever page the species drill actually started from", () => {
    const nested = encodeURIComponent("/?place=Bar+Harbor%2C+ME&back=7");
    const trail = returnTrail(`/species/gbbgul?returnTo=${nested}`);
    expect(trail[0]).toEqual({
      href: "/?place=Bar+Harbor%2C+ME&back=7",
      label: "Home",
    });
  });

  it("yields a single crumb for a species page with no back link of its own", () => {
    expect(returnTrail("/species/gbbgul")).toEqual([
      { href: "/species/gbbgul", label: "Species", speciesCode: "gbbgul" },
    ]);
  });

  it("passes a non-species returnTo through as one labeled crumb", () => {
    expect(returnTrail("/life")).toEqual([{ href: "/life", label: "Life list" }]);
  });

  it("is empty for a missing returnTo and never follows an off-site one", () => {
    expect(returnTrail(null)).toEqual([]);
    expect(returnTrail("")).toEqual([]);
    expect(returnTrail("https://evil.example/x")).toEqual([]);
    expect(returnTrail("//evil.example/x")).toEqual([]);
    // A nested off-site value is dropped; the species crumb itself survives.
    const nested = encodeURIComponent("https://evil.example/x");
    expect(returnTrail(`/species/gbbgul?returnTo=${nested}`)).toEqual([
      {
        href: `/species/gbbgul?returnTo=${nested}`,
        label: "Species",
        speciesCode: "gbbgul",
      },
    ]);
  });
});

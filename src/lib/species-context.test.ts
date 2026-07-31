import { describe, expect, it } from "vitest";
import {
  parseSpeciesLocationContext,
  speciesLinkHref,
  SPECIES_DEFAULT_DIST_KM,
} from "./species-context";

function parse(search: string) {
  return parseSpeciesLocationContext(new URLSearchParams(search));
}

describe("parseSpeciesLocationContext", () => {
  it("returns null when coordinates are absent, so the loader keeps using home", () => {
    expect(parse("back=7")).toBeNull();
    expect(parse("lat=44.39")).toBeNull();
    expect(parse("lng=-68.21")).toBeNull();
  });

  it("returns null for unusable coordinates instead of guessing", () => {
    expect(parse("lat=abc&lng=-68.21")).toBeNull();
    expect(parse("lat=44.39&lng=NaN")).toBeNull();
    expect(parse("lat=91&lng=-68.21")).toBeNull();
    expect(parse("lat=44.39&lng=181")).toBeNull();
  });

  it("reads a valid searched origin", () => {
    expect(
      parse("lat=44.3876&lng=-68.2039&dist=25&loc=Bar+Harbor%2C+ME"),
    ).toEqual({
      lat: 44.3876,
      lng: -68.2039,
      distKm: 25,
      label: "Bar Harbor, ME",
    });
  });

  it("never lets a URL push the radius past the eBird boundary", () => {
    expect(parse("lat=44&lng=-68&dist=0")?.distKm).toBe(1);
    expect(parse("lat=44&lng=-68&dist=-5")?.distKm).toBe(1);
    expect(parse("lat=44&lng=-68&dist=999")?.distKm).toBe(50);
    expect(parse("lat=44&lng=-68&dist=12.6")?.distKm).toBe(13);
  });

  it("falls back to the historical species radius when dist is missing or junk", () => {
    expect(parse("lat=44&lng=-68")?.distKm).toBe(SPECIES_DEFAULT_DIST_KM);
    expect(parse("lat=44&lng=-68&dist=abc")?.distKm).toBe(
      SPECIES_DEFAULT_DIST_KM,
    );
    expect(parse("lat=44&lng=-68&dist=")?.distKm).toBe(SPECIES_DEFAULT_DIST_KM);
  });

  it("accepts boundary coordinates and treats a blank label as absent", () => {
    expect(parse("lat=90&lng=-180&loc=++")).toEqual({
      lat: 90,
      lng: -180,
      distKm: SPECIES_DEFAULT_DIST_KM,
      label: null,
    });
  });

  it("caps an overlong label", () => {
    const ctx = parse(`lat=44&lng=-68&loc=${"x".repeat(500)}`);
    expect(ctx?.label?.length).toBe(120);
  });
});

describe("speciesLinkHref", () => {
  it("carries window and return target when there is no location context", () => {
    expect(
      speciesLinkHref("bkcchi", { backDays: 7, returnTo: "/?back=7" }),
    ).toBe("/species/bkcchi?back=7&returnTo=%2F%3Fback%3D7");
  });

  it("round-trips a searched origin through the parser", () => {
    const context = {
      lat: 44.38760123,
      lng: -68.20394567,
      distKm: 25,
      label: "Bar Harbor, ME",
    };
    const href = speciesLinkHref("bkcchi", {
      backDays: 14,
      returnTo: "/?place=Bar+Harbor%2C+ME&dist=25&back=14",
      context,
    });
    const parsed = parseSpeciesLocationContext(
      new URLSearchParams(href.slice(href.indexOf("?"))),
    );
    expect(parsed).toEqual({
      lat: 44.3876,
      lng: -68.20395,
      distKm: 25,
      label: "Bar Harbor, ME",
    });
  });

  it("escapes the return target and the species code", () => {
    const href = speciesLinkHref("y00478", {
      backDays: 1,
      returnTo: "/?place=Ha%C3%B1a%2C+HI",
    });
    expect(href).toContain("returnTo=%2F%3Fplace%3DHa%25C3%25B1a%252C%2BHI");
    expect(
      new URLSearchParams(href.slice(href.indexOf("?"))).get("returnTo"),
    ).toBe("/?place=Ha%C3%B1a%2C+HI");
  });
});

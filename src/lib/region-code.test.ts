import { describe, expect, it } from "vitest";
import {
  childLevel,
  countryOf,
  isCountry,
  isSubnational1,
  isSubnational2,
  parentOf,
  parseRegionCode,
  regionLevel,
} from "./region-code";

describe("parseRegionCode", () => {
  it("parses a subnational1 US state", () => {
    expect(parseRegionCode("US-FL")).toEqual({
      code: "US-FL",
      country: "US",
      level: "subnational1",
      parent: "US",
    });
  });

  it("parses a subnational2 US county", () => {
    expect(parseRegionCode("US-FL-057")).toEqual({
      code: "US-FL-057",
      country: "US",
      level: "subnational2",
      parent: "US-FL",
    });
  });

  it("parses a bare country code", () => {
    expect(parseRegionCode("NO")).toEqual({
      code: "NO",
      country: "NO",
      level: "country",
      parent: null,
    });
  });

  it("parses non-US subnational1/2 shapes with varying segment widths", () => {
    expect(parseRegionCode("NO-03")).toEqual({
      code: "NO-03",
      country: "NO",
      level: "subnational1",
      parent: "NO",
    });
    expect(parseRegionCode("MX-ROO")).toEqual({
      code: "MX-ROO",
      country: "MX",
      level: "subnational1",
      parent: "MX",
    });
    expect(parseRegionCode("GB-ENG")).toEqual({
      code: "GB-ENG",
      country: "GB",
      level: "subnational1",
      parent: "GB",
    });
    expect(parseRegionCode("GB-ENG-102")).toEqual({
      code: "GB-ENG-102",
      country: "GB",
      level: "subnational2",
      parent: "GB-ENG",
    });
  });

  it("normalizes via trim().toUpperCase() before validating", () => {
    expect(parseRegionCode("  us-fl  ")).toEqual({
      code: "US-FL",
      country: "US",
      level: "subnational1",
      parent: "US",
    });
    expect(parseRegionCode("no-03")).toEqual(
      expect.objectContaining({ code: "NO-03" }),
    );
  });

  it("rejects hotspot ids and other non-region shapes", () => {
    expect(parseRegionCode("L602509")).toBeNull();
    expect(parseRegionCode("")).toBeNull();
    expect(parseRegionCode("US-")).toBeNull();
    expect(parseRegionCode("US-FL-057-EXTRA")).toBeNull();
    expect(parseRegionCode(null)).toBeNull();
    expect(parseRegionCode(undefined)).toBeNull();
  });
});

describe("regionLevel / parentOf / countryOf", () => {
  it("regionLevel returns the parsed level or null", () => {
    expect(regionLevel("US")).toBe("country");
    expect(regionLevel("US-FL")).toBe("subnational1");
    expect(regionLevel("US-FL-057")).toBe("subnational2");
    expect(regionLevel("L602509")).toBeNull();
  });

  it("parentOf climbs one level, null at country", () => {
    expect(parentOf("US-FL-057")).toBe("US-FL");
    expect(parentOf("US-FL")).toBe("US");
    expect(parentOf("US")).toBeNull();
    expect(parentOf("L602509")).toBeNull();
  });

  it("countryOf returns the country segment at any level", () => {
    expect(countryOf("GB-ENG-102")).toBe("GB");
    expect(countryOf("GB-ENG")).toBe("GB");
    expect(countryOf("GB")).toBe("GB");
    expect(countryOf("L602509")).toBeNull();
  });
});

describe("isCountry / isSubnational1 / isSubnational2", () => {
  it("classify each level correctly and reject the others", () => {
    expect(isCountry("IS")).toBe(true);
    expect(isCountry("US-FL")).toBe(false);
    expect(isCountry("US-FL-057")).toBe(false);

    expect(isSubnational1("NO-03")).toBe(true);
    expect(isSubnational1("NO")).toBe(false);
    expect(isSubnational1("US-FL-057")).toBe(false);

    expect(isSubnational2("US-FL-057")).toBe(true);
    expect(isSubnational2("US-FL")).toBe(false);
    expect(isSubnational2("US")).toBe(false);
  });
});

describe("childLevel", () => {
  it("steps down one level, null past subnational2", () => {
    expect(childLevel("country")).toBe("subnational1");
    expect(childLevel("subnational1")).toBe("subnational2");
    expect(childLevel("subnational2")).toBeNull();
  });
});

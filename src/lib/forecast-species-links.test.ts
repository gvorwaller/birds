import { describe, expect, it } from "vitest";
import { speciesPageHref } from "./forecast-species-links";

describe("speciesPageHref", () => {
  it("keeps the country when no region is picked", () => {
    // Owner flow 2026-11-02: Norway chosen, species searched, result tapped;
    // the link dropped the country and the page fell back to United States.
    expect(
      speciesPageHref({ country: "NO", region: null, county: null, month: 11 }, "grehe1"),
    ).toBe("?species=grehe1&country=NO&month=11");
  });

  it("keeps region and month for a result link", () => {
    expect(
      speciesPageHref({ country: "NO", region: "NO-18", county: null, month: 6 }, "grehe1"),
    ).toBe("?species=grehe1&country=NO&region=NO-18&month=6");
  });

  it("drops the species for the change link", () => {
    expect(speciesPageHref({ country: "US", region: "US-ME", county: null, month: 5 })).toBe(
      "?country=US&region=US-ME&month=5",
    );
  });

  it("keeps a county only while it belongs to the region", () => {
    expect(
      speciesPageHref({ country: "US", region: "US-ME", county: "US-ME-005", month: 5 }),
    ).toBe("?country=US&region=US-ME&month=5&county=US-ME-005");
    expect(
      speciesPageHref({ country: "US", region: "US-NH", county: "US-ME-005", month: 5 }),
    ).toBe("?country=US&region=US-NH&month=5");
  });
});

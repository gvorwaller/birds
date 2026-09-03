import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  GEOGRAPHIC_AREAS,
  geographicAreaForCountry,
  groupCountriesByGeographicArea,
} from "./geographic-areas";

describe("geographic area drilldown", () => {
  it("assigns every country in the checked-in eBird reference catalog exactly once", () => {
    const manifest = JSON.parse(
      readFileSync(
        new URL("../../backend/db/regions-manifest.json", import.meta.url),
        "utf8",
      ),
    ) as { regions: Record<string, { level: string }> };
    const catalogCodes = Object.entries(manifest.regions)
      .filter(([, region]) => region.level === "country")
      .map(([code]) => code)
      .sort();
    const assignedCodes = GEOGRAPHIC_AREAS.flatMap((area) => [
      ...area.countryCodes,
    ]).sort();

    expect(new Set(assignedCodes).size).toBe(assignedCodes.length);
    expect(assignedCodes).toEqual(catalogCodes);
    expect(
      catalogCodes.every((code) => geographicAreaForCountry(code) !== "other"),
    ).toBe(true);
  });

  it("orders areas geographically and countries alphabetically", () => {
    const grouped = groupCountriesByGeographicArea([
      { countryCode: "US", countryName: "United States" },
      { countryCode: "CA", countryName: "Canada" },
      { countryCode: "FR", countryName: "France" },
    ]);

    expect(grouped.map((area) => area.name)).toEqual([
      "North America",
      "Europe",
    ]);
    expect(grouped[0].countries.map((country) => country.countryName)).toEqual([
      "Canada",
      "United States",
    ]);
  });
});

import { describe, expect, it } from "vitest";
import {
  filterCountriesNeedingFrequencyLoad,
  terminalFrequencyAttemptCodes,
  type Region,
} from "./regions";

function country(code: string, name: string): Region {
  return {
    code,
    name,
    level: "country",
    parent: null,
    lat: 0,
    lon: 0,
    box: null,
  };
}

describe("unfinished country picker", () => {
  const countries = [
    country("US", "United States"),
    country("BB", "Beta"),
    country("AA", "Alpha"),
    country("CC", "Childless"),
  ];
  const children = new Map([
    ["US", [{ code: "US-FL" }, { code: "US-GA" }]],
    ["AA", [{ code: "AA-1" }, { code: "AA-2" }]],
    ["BB", [{ code: "BB-1" }]],
  ]);

  it("keeps partial countries and sorts them alphabetically", () => {
    const loaded = new Set(["AA-1"]);
    expect(
      filterCountriesNeedingFrequencyLoad(countries, children, loaded).map(
        (c) => c.code,
      ),
    ).toEqual(["AA", "BB", "CC", "US"]);
  });

  it("removes a non-US country after its countrywide load despite partial child failures", () => {
    const loaded = new Set(["AA", "AA-1"]);
    expect(
      filterCountriesNeedingFrequencyLoad([countries[2]], children, loaded),
    ).toEqual([]);
  });

  it("removes a non-US country after every child region loads without a countrywide row", () => {
    const loaded = new Set(["AA-1", "AA-2"]);
    expect(
      filterCountriesNeedingFrequencyLoad([countries[2]], children, loaded),
    ).toEqual([]);
  });

  it("treats US states as complete without requiring a countrywide US row", () => {
    const loaded = new Set(["US-FL", "US-GA"]);
    expect(
      filterCountriesNeedingFrequencyLoad([countries[0]], children, loaded),
    ).toEqual([]);
  });

  it("requires a countrywide row for a childless non-US country", () => {
    expect(
      filterCountriesNeedingFrequencyLoad([countries[3]], children, new Set()),
    ).toHaveLength(1);
    expect(
      filterCountriesNeedingFrequencyLoad(
        [countries[3]],
        children,
        new Set(["CC"]),
      ),
    ).toEqual([]);
  });

  it("removes a country when every child is loaded or terminal", () => {
    expect(
      filterCountriesNeedingFrequencyLoad(
        [countries[2]],
        children,
        new Set(["AA-1"]),
        new Set(["AA-2"]),
      ),
    ).toEqual([]);
  });

  it("removes a childless country after its countrywide attempt is terminal", () => {
    expect(
      filterCountriesNeedingFrequencyLoad(
        [countries[3]],
        children,
        new Set(),
        new Set(["CC"]),
      ),
    ).toEqual([]);
  });
});

describe("terminal frequency attempts for the picker", () => {
  const zeroChecklists =
    "Barchart has zero checklists in every week — nothing to store.";
  const http500 = "eBird returned HTTP 500 for this request.";

  it("treats valid zero-checklist results as terminal", () => {
    expect(
      terminalFrequencyAttemptCodes(
        [{ locCode: "AA-1", regionCode: "AA-1", error: zeroChecklists }],
        new Set(),
        new Set(),
      ),
    ).toEqual(new Set(["AA-1"]));
  });

  it("treats HTTP 500 as terminal only after the country job ends", () => {
    const attempt = [{ locCode: "AA-2", regionCode: "AA-2", error: http500 }];
    expect(
      terminalFrequencyAttemptCodes(attempt, new Set(["AA"]), new Set()),
    ).toEqual(new Set(["AA-2"]));
    expect(
      terminalFrequencyAttemptCodes(
        attempt,
        new Set(["AA"]),
        new Set(["AA"]),
      ),
    ).toEqual(new Set());
  });

  it("keeps retryable failures unfinished", () => {
    expect(
      terminalFrequencyAttemptCodes(
        [
          {
            locCode: "AA-2",
            regionCode: "AA-2",
            error: "eBird did not respond within 30 seconds.",
          },
        ],
        new Set(["AA"]),
        new Set(),
      ),
    ).toEqual(new Set());
  });
});

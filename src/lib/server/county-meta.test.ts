import { describe, expect, it } from "vitest";
import { countyMapQuery, countyMeta, countySeat } from "./county-meta";

describe("county-meta dataset", () => {
  it("resolves well-known counties with official names and seats", () => {
    expect(countyMeta("US-FL-057")).toEqual({
      name: "Hillsborough County",
      seat: "Tampa",
    });
    expect(countyMeta("US-FL-103")).toEqual({
      name: "Pinellas County",
      seat: "Clearwater",
    });
    expect(countyMeta("US-ME-019")).toEqual({
      name: "Penobscot County",
      seat: "Bangor",
    });
    // Louisiana keeps its official suffix — never "Orleans County".
    expect(countyMeta("US-LA-071")?.name).toBe("Orleans Parish");
  });

  it("covers every Florida and Maine county eBird can emit", () => {
    // FL county FIPS are the odd numbers 001..133 EXCEPT 025 — retired when
    // Dade County was renamed Miami-Dade (086). ME are 001..031 odd.
    for (let n = 1; n <= 133; n += 2) {
      if (n === 25) continue;
      const code = `US-FL-${String(n).padStart(3, "0")}`;
      expect(countyMeta(code), code).not.toBeNull();
    }
    for (let n = 1; n <= 31; n += 2) {
      const code = `US-ME-${String(n).padStart(3, "0")}`;
      expect(countyMeta(code), code).not.toBeNull();
    }
  });

  it("countySeat is null-safe for unknown codes and seatless equivalents", () => {
    expect(countySeat("US-XX-999")).toBeNull();
    // Anchorage is its own county equivalent — no separate seat.
    expect(countySeat("US-AK-020")).toBeNull();
  });

  it("countyMapQuery composes the official name; falls back to name + County", () => {
    expect(countyMapQuery("US-FL-001", "Alachua", "Florida")).toBe(
      "Alachua County, Florida",
    );
    expect(countyMapQuery("US-LA-071", "Orleans", "Louisiana")).toBe(
      "Orleans Parish, Louisiana",
    );
    // Unknown code → eBird's name UNCHANGED; no invented "County" suffix.
    expect(countyMapQuery("US-XX-999", "Nowhere", "Atlantis")).toBe(
      "Nowhere, Atlantis",
    );
  });
});

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

  it("lists CURRENT seats only; genuine dual-seat counties keep both (CODEX1)", () => {
    // Former seats leaked through bare wdt:P36 before the statement-level
    // query: Paris (Linn KS, 19th century) and Martinsville (Guilford NC).
    expect(countySeat("US-KS-107")).toBe("Mound City");
    expect(countySeat("US-NC-081")).toBe("Greensboro");
    // Hinds County MS genuinely has two judicial seats.
    expect(countySeat("US-MS-049")).toBe("Jackson / Raymond");
    // Vieques PR: Isabel II is the seat; the municipio is not its own seat.
    expect(countySeat("US-PR-147")).toBe("Isabel II");
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

  it("countyMapQuery composes the official name; unknown codes keep the eBird name unchanged", () => {
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

/**
 * Static completeness check for the migration ribbon's country -> continent
 * map (td-8d3526, migration ribbon build spec TD-A, P1-1/P1-5). Pure — never
 * touches the DB, unlike forecast-db.test.ts's `regions` table, whose
 * fixtures deliberately include unmapped codes (QZ, ZZ, QY, ZY) that would
 * make a live-DB completeness assertion meaningless.
 *
 * Parses backend/db/migrations/0044_regions_seed_20260831.sql directly so
 * this test fails the moment continents.json and the seed disagree, in
 * either direction — the seed has 252 level='country' rows, one of them
 * (Côte d'Ivoire, `CI`) with a doubled SQL apostrophe in its name that a
 * naive regex/grep breaks on (CODEX1 P1-1).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import continentsJson from "./data/continents.json";
import { ribbonColumnOf, type Continent } from "./regions";

const SEED_PATH = new URL(
  "../../../backend/db/migrations/0044_regions_seed_20260831.sql",
  import.meta.url,
);

const CONTINENTS = new Set<Continent>(["NA", "SA", "EU", "AF", "AS", "OC", "AN"]);

/** One VALUES row: ('CODE', 'NAME possibly containing '' escaped quotes', 'country'|'subnational1', ... */
const ROW_RE = /\('([A-Z]{2}(?:-[A-Z0-9]+)?)',\s*'(?:[^']|'')*',\s*'(country|subnational1)'/g;

function countryCodesFromSeed(): string[] {
  const sql = readFileSync(SEED_PATH, "utf8");
  const codes: string[] = [];
  for (const m of sql.matchAll(ROW_RE)) {
    const [, code, level] = m;
    if (level === "country") codes.push(code);
  }
  return codes;
}

describe("continents.json completeness against the 0044 seed", () => {
  it("has exactly the level='country' codes from 0044, no more, no fewer", () => {
    const seedCodes = countryCodesFromSeed();
    // Sanity on the parser itself, not just the map: the seed's own header
    // says 3,621 rows; guard against the regex silently matching nothing.
    expect(seedCodes.length).toBeGreaterThan(200);
    expect(new Set(seedCodes).size).toBe(seedCodes.length); // no duplicate codes in the seed

    const mapCodes = Object.keys(continentsJson);
    expect(new Set(mapCodes)).toEqual(new Set(seedCodes));
  });

  it("has 252 entries (P1-1: the doubled-apostrophe count, not the broken-grep 251)", () => {
    expect(Object.keys(continentsJson).length).toBe(252);
  });

  it("assigns Côte d'Ivoire (CI) to AF", () => {
    expect((continentsJson as Record<string, string>).CI).toBe("AF");
  });

  it("every value is one of the seven continent codes", () => {
    for (const [code, continent] of Object.entries(continentsJson)) {
      expect(CONTINENTS.has(continent as Continent), `${code} -> ${continent}`).toBe(true);
    }
  });

  it("has no lowercase keys", () => {
    for (const code of Object.keys(continentsJson)) {
      expect(code).toBe(code.toUpperCase());
    }
  });

  it("has no duplicate keys after JSON parsing (object keys are already unique; guards the source list)", () => {
    const codes = Object.keys(continentsJson);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("ribbonColumnOf", () => {
  it("splits the US at 100°W into NAW/NAE", () => {
    expect(ribbonColumnOf("US", true)).toBe("NAW");
    expect(ribbonColumnOf("US", false)).toBe("NAE");
  });

  it("does not split non-NA continents by west", () => {
    expect(ribbonColumnOf("PF", true)).toBe("OC");
    expect(ribbonColumnOf("PF", false)).toBe("OC");
  });

  it("maps Côte d'Ivoire to AF regardless of west", () => {
    expect(ribbonColumnOf("CI", false)).toBe("AF");
  });

  it("returns null for a country absent from the map", () => {
    expect(ribbonColumnOf("QZ", false)).toBeNull();
  });
});

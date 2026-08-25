/**
 * Pure-function coverage for slash-taxon expansion (td-8f0ed8, plan
 * docs/2026-08-25-similar-species-plan.md Step 1). No DB, no network.
 *
 * Every fixture below is a REAL row from taxonomy_cache, not an invented one —
 * the failure mode this guards against is producing binomials that look right
 * and resolve to nothing, so synthetic inputs would prove very little.
 */
import { describe, expect, it } from "vitest";
import { expandSlashSciNames, slashPartnersFor } from "./similar-species";

describe("expandSlashSciNames", () => {
  it("expands a two-part slash sharing one genus", () => {
    // taxonomy_cache: "Greater/Lesser Scaup"
    expect(expandSlashSciNames("Aythya marila/affinis")).toEqual([
      "Aythya marila",
      "Aythya affinis",
    ]);
  });

  it("keeps both binomials verbatim when the slash crosses genera", () => {
    // "Sharp-shinned/Cooper's Hawk" — Cooper's moved to Astur, so the most
    // confused pair in North America is now cross-genus.
    expect(expandSlashSciNames("Accipiter striatus/Astur cooperii")).toEqual([
      "Accipiter striatus",
      "Astur cooperii",
    ]);
  });

  it("REGRESSION: a bare epithet inherits the NEAREST PRECEDING genus, not the first", () => {
    // "Spotted/Little/Baillon's Crake". Zapornia pusilla exists (baicra1);
    // Porzana pusilla does not. Inheriting from the first part would produce a
    // plausible binomial that resolves to nothing.
    const out = expandSlashSciNames("Porzana porzana/Zapornia parva/pusilla");
    expect(out).toEqual([
      "Porzana porzana",
      "Zapornia parva",
      "Zapornia pusilla",
    ]);
    expect(out).not.toContain("Porzana pusilla");
  });

  it("expands a five-member slash", () => {
    // y00726 "Herring complex/Lesser Black-backed Gull"
    expect(
      expandSlashSciNames(
        "Larus smithsonianus/vegae/mongolicus/argentatus/fuscus",
      ),
    ).toEqual([
      "Larus smithsonianus",
      "Larus vegae",
      "Larus mongolicus",
      "Larus argentatus",
      "Larus fuscus",
    ]);
  });

  it("returns [] for a plain binomial with no slash", () => {
    expect(expandSlashSciNames("Dryobates pubescens")).toEqual([]);
  });

  it("returns [] when the leading part carries no genus to inherit", () => {
    expect(expandSlashSciNames("marila/affinis")).toEqual([]);
  });

  it("returns [] rather than synthesising a name from an empty part", () => {
    expect(expandSlashSciNames("Aythya marila/")).toEqual([]);
    expect(expandSlashSciNames("/affinis")).toEqual([]);
  });

  it("tolerates stray whitespace around and inside parts", () => {
    expect(expandSlashSciNames(" Aythya  marila / affinis ")).toEqual([
      "Aythya marila",
      "Aythya affinis",
    ]);
  });

  it("preserves case — callers must lowercase both sides when matching", () => {
    // The stored sci_name is capitalised too, so `lower(sci_name) = ANY($1)`
    // with an un-normalised right-hand side matches NOTHING. Pinning the
    // contract here so that bug cannot come back silently.
    const out = expandSlashSciNames("Aythya marila/affinis");
    expect(out[0]).toBe("Aythya marila");
    expect(out[0]).not.toBe("aythya marila");
  });
});

describe("slashPartnersFor", () => {
  it("returns the other members with their ordinals, excluding the focal species", () => {
    expect(
      slashPartnersFor("Porzana porzana", "Porzana porzana/Zapornia parva/pusilla"),
    ).toEqual([
      { sciName: "Zapornia parva", ordinal: 1 },
      { sciName: "Zapornia pusilla", ordinal: 2 },
    ]);
  });

  it("keeps the ordinal of the member's position, not its position among partners", () => {
    // Focal is first here, so partners start at ordinal 1 — the ordinal is the
    // slot in the slash name, which is what gives a stable within-row order.
    const out = slashPartnersFor("Aythya marila", "Aythya marila/affinis");
    expect(out).toEqual([{ sciName: "Aythya affinis", ordinal: 1 }]);
  });

  it("matches the focal species case-insensitively", () => {
    expect(slashPartnersFor("aythya MARILA", "Aythya marila/affinis")).toEqual([
      { sciName: "Aythya affinis", ordinal: 1 },
    ]);
  });

  it("returns [] when the focal species is not a member", () => {
    expect(slashPartnersFor("Dryobates pubescens", "Aythya marila/affinis")).toEqual(
      [],
    );
  });

  it("returns [] for a non-slash name", () => {
    expect(slashPartnersFor("Dryobates pubescens", "Dryobates pubescens")).toEqual(
      [],
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  MIN_PLACE_QUERY_LENGTH,
  normalizePlaceName,
  placeQueryMatches,
  tokens,
} from "./place-name";

describe("normalizePlaceName", () => {
  it("strips stopwords and punctuation", () => {
    expect(normalizePlaceName("The Ponds at Huguenot")).toBe("ponds huguenot");
    expect(normalizePlaceName("Fish & Wildlife Area")).toBe(
      "fish wildlife area",
    );
    expect(normalizePlaceName("Huguenot Memorial Park--North Beach")).toBe(
      "huguenot memorial park north beach",
    );
  });

  it("is ASCII-destructive — the reason the search matcher folds first", () => {
    expect(normalizePlaceName("Hāna")).toBe("h na");
  });

  /**
   * Pre-existing quirk, pinned deliberately rather than fixed: the stopword
   * rule removes a standalone `us` BEFORE the `xx-xx` state-code rule can see
   * `us-fl`, so the `fl` survives as its own token. The state-code rule
   * therefore only ever fires for county-style codes like `fl-du`.
   *
   * Left alone because `normalizePlaceName` feeds `placeNameScore`, which
   * decides real Google Places matches and is pinned by golden cases in
   * `$server/location-placeids.test.ts`. Changing it is a behavior change to
   * production matching, not a cleanup — and it does not hurt search, where the
   * noise appears on the *eBird name* side and is simply an extra token nobody
   * has to match (see placeQueryMatches below).
   */
  it("leaves a stray state letter behind for US-XX (documented quirk)", () => {
    expect(normalizePlaceName("US-FL Huguenot Memorial Park")).toBe(
      "fl huguenot memorial park",
    );
    expect(normalizePlaceName("Duval FL-DU")).toBe("duval");
  });
});

describe("tokens", () => {
  it("drops 1-character fragments but keeps 2-character ones", () => {
    expect(tokens("A B Park")).toEqual(["park"]);
    expect(tokens("Mt Desert Island")).toEqual(["mt", "desert", "island"]);
  });
});

describe("placeQueryMatches", () => {
  const HUGUENOT = "Huguenot Memorial Park";

  it("matches the ticket's misspelling", () => {
    // The example from td-601faf: plain `includes()` fails on this.
    expect(placeQueryMatches("hugenot", HUGUENOT)).toBe(true);
  });

  it("matches prefixes and substrings", () => {
    expect(placeQueryMatches("hugue", HUGUENOT)).toBe(true);
    expect(placeQueryMatches("memorial", HUGUENOT)).toBe(true);
    expect(placeQueryMatches("morial", HUGUENOT)).toBe(true);
  });

  it("ignores eBird noise in the place name — the direction that matters", () => {
    // Real eBird names carry this; the extra `fl` token is simply one nobody
    // has to match, because only QUERY tokens must be satisfied.
    expect(placeQueryMatches("huguenot", "US-FL Huguenot Memorial Park")).toBe(
      true,
    );
    expect(placeQueryMatches("duval", "Duval FL-DU")).toBe(true);
    expect(placeQueryMatches("ponds", "The Ponds at Huguenot")).toBe(true);
  });

  it("does not match state-code noise typed into the QUERY", () => {
    // Consequence of the normalizer quirk above: "US-FL" leaves an `fl` token
    // on the query side too, and nothing in the name satisfies it. Accepted —
    // users type place names, not eBird region prefixes.
    expect(placeQueryMatches("US-FL huguenot", HUGUENOT)).toBe(false);
  });

  it("matches hotspot subunits", () => {
    expect(
      placeQueryMatches("north beach", "Huguenot Memorial Park--North Beach"),
    ).toBe(true);
  });

  it("folds diacritics in both directions", () => {
    // The whole reason `placeQueryMatches` does not reuse the scorer's
    // normalizer: that one turns "Hāna" into "h na".
    expect(placeQueryMatches("hana", "Hāna")).toBe(true);
    expect(placeQueryMatches("hāna", "Hana")).toBe(true);
  });

  it("requires every query token to match a DISTINCT candidate token", () => {
    expect(placeQueryMatches("huguenot park", HUGUENOT)).toBe(true);
    // Only one "park" in the candidate, so "park park" must not match twice.
    expect(placeQueryMatches("park park", HUGUENOT)).toBe(false);
    // A second token that matches nothing fails the whole query.
    expect(placeQueryMatches("huguenot airport", HUGUENOT)).toBe(false);
  });

  it("finds an assignment that first-fit matching would miss", () => {
    // Regression for the greedy bipartite bug: a valid distinct assignment
    // exists (park→Park, parkside→Parkside), but consuming the first
    // acceptable candidate lets "park" swallow "Parkside" and then strands
    // "parkside" with nothing left.
    expect(placeQueryMatches("park parkside", "Parkside Park")).toBe(true);
    expect(placeQueryMatches("parkside park", "Parkside Park")).toBe(true);
    // Still correctly false when no complete assignment exists.
    expect(placeQueryMatches("park parkside", "Parkside Lot")).toBe(false);
  });

  it("does not fuzzy-match short tokens", () => {
    // 2-character tokens survive `tokens()`, so an unguarded edit-distance
    // rule would make these match. Exact and prefix still work.
    expect(placeQueryMatches("mt desert", "Mt Desert Island")).toBe(true);
    expect(placeQueryMatches("me desert", "Mt Desert Island")).toBe(false);
    // 3 characters is still below the fuzzy threshold.
    expect(placeQueryMatches("bea", "Huguenot Beach")).toBe(true);
    expect(placeQueryMatches("bec", "Huguenot Beach")).toBe(false);
  });

  it("refuses queries shorter than the minimum", () => {
    expect(MIN_PLACE_QUERY_LENGTH).toBe(3);
    expect(placeQueryMatches("hu", HUGUENOT)).toBe(false);
    expect(placeQueryMatches("  h  ", HUGUENOT)).toBe(false);
    expect(placeQueryMatches("hug", HUGUENOT)).toBe(true);
  });

  it("handles apostrophes and hyphens", () => {
    expect(placeQueryMatches("hunters", "Hunter's Creek Park")).toBe(true);
    expect(placeQueryMatches("creek", "Hunter's Creek Park")).toBe(true);
    expect(placeQueryMatches("saint johns", "Saint-Johns Bluff")).toBe(true);
  });

  it("rejects unrelated names", () => {
    expect(placeQueryMatches("downtown cafe", HUGUENOT)).toBe(false);
    expect(placeQueryMatches("huguenot", "Downtown Cafe")).toBe(false);
  });

  it("returns false rather than matching everything on empty candidates", () => {
    expect(placeQueryMatches("huguenot", "")).toBe(false);
    expect(placeQueryMatches("huguenot", "A")).toBe(false);
  });
});

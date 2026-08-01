import { describe, expect, it } from "vitest";
import { haversineMeters, placeNameScore } from "./location-placeids";

describe("eBird location Google place matching helpers", () => {
  it("scores overlapping eBird and Google place names", () => {
    expect(
      placeNameScore("Huguenot Memorial City Park", "Huguenot Park"),
    ).toBeGreaterThan(0.4);
    expect(
      placeNameScore("Huguenot Memorial City Park", "Downtown Cafe"),
    ).toBeLessThan(0.3);
  });

  /**
   * Golden cases pinning the CURRENT output of the scorer, recorded before
   * `normalizeName`/`tokens`/`placeNameScore` moved to `$lib/place-name` so the
   * client could share them. The two threshold assertions above are too coarse
   * to prove a refactor is behavior-preserving; these are the actual proof.
   *
   * `placeNameScore` still drives Google Places matching (`scoreCandidate`
   * below), so a change here is a real behavior change — reproduce it
   * deliberately, don't re-record the snapshot to make a test pass.
   */
  it("pins exact scores across the eBird name quirks the normalizer handles", () => {
    const cases: [string, string][] = [
      // identical after normalization
      ["Huguenot Memorial Park", "Huguenot Memorial Park"],
      // eBird state-code noise (`US-FL`) is stripped
      ["US-FL Huguenot Memorial Park", "Huguenot Memorial Park"],
      // stopwords (`the`, `at`, `of`, `and`) removed; `&` becomes `and`
      ["The Ponds at Huguenot", "Ponds Huguenot"],
      ["Fish & Wildlife Area", "Fish and Wildlife Area"],
      // hotspot subunit separator
      ["Huguenot Memorial Park--North Beach", "Huguenot Memorial Park"],
      // 1-char tokens are dropped by the `length > 1` filter
      ["A B Park", "Park"],
      // Diacritics are DESTROYED rather than folded: "Hāna" normalizes to
      // "h na", whose only surviving token is "na" ("h" fails the length > 1
      // filter). Both directions still score 1.0 here, but only because this
      // scorer's overlap test is SYMMETRIC and substring-based
      // (`ct.includes(t) || t.includes(ct)`), so the truncated "na" still hits.
      // That accident does not carry over to `placeQueryMatches`, which matches
      // a typed query against a place name asymmetrically — hence the separate
      // NFKD-folding pass there. Pinned in both directions so a change to the
      // overlap rule shows up here.
      ["Hāna", "Hana"],
      ["Hana", "Hāna"],
      // no overlap
      ["Huguenot Memorial Park", "Downtown Cafe"],
    ];
    expect(
      cases.map(
        ([q, c]) => `${q} | ${c} => ${placeNameScore(q, c).toFixed(4)}`,
      ),
    ).toMatchInlineSnapshot(`
      [
        "Huguenot Memorial Park | Huguenot Memorial Park => 1.0000",
        "US-FL Huguenot Memorial Park | Huguenot Memorial Park => 0.8125",
        "The Ponds at Huguenot | Ponds Huguenot => 1.0000",
        "Fish & Wildlife Area | Fish and Wildlife Area => 1.0000",
        "Huguenot Memorial Park--North Beach | Huguenot Memorial Park => 0.7000",
        "A B Park | Park => 1.0000",
        "Hāna | Hana => 1.0000",
        "Hana | Hāna => 1.0000",
        "Huguenot Memorial Park | Downtown Cafe => 0.0000",
      ]
    `);
  });

  it("computes small distances for nearby points", () => {
    expect(haversineMeters(30.411, -81.42, 30.4111, -81.4201)).toBeLessThan(20);
  });
});

import { describe, expect, it } from "vitest";
import {
  PLACE_PAGE_SIZE,
  comparePlaceChoices,
  foldForMatch,
  matchPlaceChoices,
  placePage,
  tokenStarts,
} from "./place-filter";

const c = (code: string, name: string) => ({ code, name });

describe("foldForMatch", () => {
  it("drops case, accents and extra whitespace", () => {
    expect(foldForMatch("  São   Paulo ")).toBe("sao paulo");
    expect(foldForMatch("Côte-d’Or")).toBe("cote-d’or");
    expect(foldForMatch("Åland")).toBe("aland");
  });
  it("maps letters that have no Unicode decomposition", () => {
    expect(foldForMatch("Łódź")).toBe("lodz");
    expect(foldForMatch("Tromsø")).toBe("tromso");
    expect(foldForMatch("Straße")).toBe("strasse");
  });
});

describe("tokenStarts", () => {
  it("starts a word after hyphens, apostrophes, periods and spaces", () => {
    const folded = foldForMatch("St. Mary's-by-the-Sea");
    const words = tokenStarts(folded).map((i) => folded.slice(i).split(/[^\p{L}\p{N}]/u)[0]);
    expect(words).toEqual(["st", "mary", "s", "by", "the", "sea"]);
  });
});

describe("comparePlaceChoices", () => {
  it("sorts alphabetically regardless of case, accents and numbers in names", () => {
    const sorted = [
      c("X4", "zebra Park"),
      c("X2", "Ábaco"),
      c("X3", "Area 10"),
      c("X1", "Area 9"),
      c("X5", "abbey"),
    ].sort(comparePlaceChoices);
    expect(sorted.map((x) => x.name)).toEqual(["Ábaco", "abbey", "Area 9", "Area 10", "zebra Park"]);
  });
  it("breaks equal names by code so the order is stable", () => {
    const sorted = [c("L2", "Pond"), c("L1", "Pond")].sort(comparePlaceChoices);
    expect(sorted.map((x) => x.code)).toEqual(["L1", "L2"]);
  });
});

describe("matchPlaceChoices", () => {
  const counties = [
    c("US-FL-081", "Manatee"),
    c("US-FL-021", "Naples Palm"),
    c("US-FL-099", "Palm Beach"),
    c("US-FL-115", "Sarasota"),
    c("US-FL-127", "Volusia"),
  ];
  it("returns everything, in order, for an empty query", () => {
    expect(matchPlaceChoices(counties, "  ")).toEqual(counties);
  });
  it("ranks whole-label starts, then word starts, then anywhere", () => {
    expect(matchPlaceChoices(counties, "pal").map((x) => x.name)).toEqual(["Palm Beach", "Naples Palm"]);
    expect(matchPlaceChoices(counties, "a").map((x) => x.name)[0]).toBe("Manatee");
    expect(matchPlaceChoices(counties, "ras").map((x) => x.name)).toEqual(["Sarasota"]);
  });
  it("matches accents and case either way", () => {
    const places = [c("BR-SP", "São Paulo"), c("FR-21", "Côte-d'Or"), c("PL-10", "Łódź")];
    expect(matchPlaceChoices(places, "sao").map((x) => x.code)).toEqual(["BR-SP"]);
    expect(matchPlaceChoices(places, "OR").map((x) => x.code)).toEqual(["FR-21"]);
    expect(matchPlaceChoices(places, "lodz").map((x) => x.code)).toEqual(["PL-10"]);
  });
  it("matches a hotspot by its L code", () => {
    const spots = [c("L123456", "Myakka River SP"), c("L999", "Other")];
    expect(matchPlaceChoices(spots, "l1234").map((x) => x.code)).toEqual(["L123456"]);
  });
});

describe("placePage", () => {
  const many = Array.from({ length: 450 }, (_, i) => c(`L${i}`, "Same Name Pond"));
  it("shows one page at a time and counts what remains", () => {
    expect(placePage(many, 1).shown).toHaveLength(PLACE_PAGE_SIZE);
    expect(placePage(many, 1).remaining).toBe(250);
    expect(placePage(many, 2).remaining).toBe(50);
  });
  it("reaches every match, including past the first page, without a code", () => {
    const { shown, remaining } = placePage(many, 3);
    expect(remaining).toBe(0);
    expect(shown[349].code).toBe("L349");
  });
});

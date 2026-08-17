import { describe, expect, it } from "vitest";
import { allAboutBirdsUrl } from "./species-links";

describe("allAboutBirdsUrl (td-09fdc0 — Cornell slug normalization)", () => {
  it("strips apostrophes to match Cornell's canonical slugs (CODEX1 cases)", () => {
    expect(allAboutBirdsUrl("Anna's Hummingbird")).toBe(
      "https://www.allaboutbirds.org/guide/Annas_Hummingbird",
    );
    expect(allAboutBirdsUrl("Costa's Hummingbird")).toBe(
      "https://www.allaboutbirds.org/guide/Costas_Hummingbird",
    );
    // Curly apostrophe (eBird taxonomy uses U+2019 for some names).
    expect(allAboutBirdsUrl("Clark’s Nutcracker")).toBe(
      "https://www.allaboutbirds.org/guide/Clarks_Nutcracker",
    );
  });

  it("keeps hyphens, folds diacritics, underscores whitespace", () => {
    expect(allAboutBirdsUrl("Black-capped Chickadee")).toBe(
      "https://www.allaboutbirds.org/guide/Black-capped_Chickadee",
    );
    expect(allAboutBirdsUrl("ʻŌmaʻo")).toBe("https://www.allaboutbirds.org/guide/Omao");
    expect(allAboutBirdsUrl("Kirtland's Warbler")).toBe(
      "https://www.allaboutbirds.org/guide/Kirtlands_Warbler",
    );
  });
});

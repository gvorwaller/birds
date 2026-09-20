import { describe, expect, it } from "vitest";
import { sectionHref, shouldEnhanceSectionLink } from "./section-navigation";

describe("species section navigation", () => {
  it("replaces only the fragment while preserving every query parameter", () => {
    expect(
      sectionHref(
        "/species/margod",
        "?future=kept&returnTo=%2Fspecies%3Fq%3Dgodwit&window=30",
        "best-time",
      ),
    ).toBe(
      "/species/margod?future=kept&returnTo=%2Fspecies%3Fq%3Dgodwit&window=30#best-time",
    );
  });

  it("keeps modifier clicks as native links", () => {
    const normal = {
      button: 0,
      defaultPrevented: false,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
    };
    expect(shouldEnhanceSectionLink(normal)).toBe(true);
    expect(shouldEnhanceSectionLink({ ...normal, metaKey: true })).toBe(false);
    expect(shouldEnhanceSectionLink({ ...normal, button: 1 })).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { buildEvalText, cueRanges, maskNames } from "./eval-text";
import { designHash, tagEvalDesign } from "./eval-design";

describe("evaluator text (rev 23 §B4h)", () => {
  const names = { common: "American Kestrel", scientific: "Falco sparverius" };
  it("masks the common name, its group noun (plural/possessive), the binomial, genus and epithet", () => {
    const t = maskNames(
      "The American Kestrel (Falco sparverius) is the smallest falcon. Kestrels hunt insects; the kestrel's diet varies. Other Falco species differ; sparverius means sparrow-like.",
      names,
    );
    expect(t).not.toMatch(/\b(kestrel|kestrels|sparverius|falco)\b/i);
    expect(t).toContain("[this bird] ([this bird]) is the smallest falcon");
    expect(t).toContain("Other [genus] species");
  });
  it("drops the fixed global sections, keeps the lead and habitat, and is independent of any rule set", () => {
    const a = buildEvalText(
      {
        extract: "A small falcon of open country.",
        sections: [
          { title: "Taxonomy", text: "Named by Linnaeus." },
          {
            title: "Habitat",
            text: "Open fields; sometimes seen at sea on migration.",
          },
          { title: "In culture", text: "A mascot." },
        ],
      },
      names,
      ["sea"],
    );
    expect(a.sections.map((s) => s.title)).toEqual(["", "Habitat"]);
    const b = buildEvalText(
      {
        extract: "A small falcon of open country.",
        sections: [
          {
            title: "Habitat",
            text: "Open fields; sometimes seen at sea on migration.",
          },
        ],
      },
      names,
      ["sea"],
    );
    expect(b.hash).toBe(a.hash); // denied sections do not affect what is labelled
    // …but the underlined cue words do: a page with different underlining is a different page.
    const c = buildEvalText(
      {
        extract: "A small falcon of open country.",
        sections: [
          {
            title: "Habitat",
            text: "Open fields; sometimes seen at sea on migration.",
          },
        ],
      },
      names,
      ["sea", "ocean"],
    );
    expect(c.hash).not.toBe(a.hash);
  });
  it("underlines only the frozen cue words, whole words, any case", () => {
    const d = tagEvalDesign("habitat:open-ocean")!;
    const text = "Seen at Sea and over the ocean; not seashore or Oceania.";
    expect(
      cueRanges(text, d.cueWords).map(([s, e]) => text.slice(s, e)),
    ).toEqual(["Sea", "ocean"]);
  });
  it("the design fingerprint is stable and changes with any artifact", () => {
    expect(designHash("habitat:open-ocean")).toMatch(/^[0-9a-f]{64}$/);
    expect(designHash("habitat:open-ocean")).toBe(
      designHash("habitat:open-ocean"),
    );
    expect(() => designHash("habitat:beach")).toThrow(/no evaluation design/);
  });
});

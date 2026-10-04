import { describe, expect, it } from "vitest";
import { buildEvalText, cueRanges, evalSections } from "./eval-text";
import { designHash, evaluatorHash, tagEvalDesign } from "./eval-design";

const PAGE = { evaluatorHash: "e".repeat(64), reference: null };

describe("evaluator text (rev 23 §B4h)", () => {
  it("v3 (owner 2026-10-03): the bird's names are shown, never masked", () => {
    const text =
      "The American Kestrel (Falco sparverius) is the smallest falcon. Kestrels hunt insects; the kestrel's diet varies.";
    const page = buildEvalText({ extract: text, sections: [] }, ["sea"], PAGE);
    expect(page.sections).toEqual([{ title: "", text }]);
    expect(JSON.stringify(page)).not.toMatch(/\[this bird\]|\[genus\]/);
    expect(evalSections({ extract: text, sections: [] })).toEqual(page.sections);
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
      ["sea"],
      PAGE,
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
      ["sea"],
      PAGE,
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
      ["sea", "ocean"],
      PAGE,
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

describe("evaluator text: the family reference (plan §4 option b)", () => {
  const article = {
    extract: "The Sooty Shearwater is a shearwater in the seabird family Procellariidae.",
    sections: [],
  };
  const reference = {
    familyCode: "procel1",
    title: "Procellariidae",
    revId: 1354727834,
    lead: "The family Procellariidae is a group of seabirds that includes the shearwaters. The Sooty Shearwater breeds in the south.",
  };
  const page = (over: Partial<typeof reference> = {}) =>
    buildEvalText(article, ["sea"], {
      evaluatorHash: evaluatorHash("habitat:open-ocean"),
      reference: { ...reference, ...over },
    });

  it("shows the family's lead as stored, names and all (v3: nothing masked)", () => {
    expect(page().reference).toMatchObject({
      familyCode: "procel1",
      title: "Procellariidae",
      revId: 1354727834,
      lead: reference.lead,
      displayLead: reference.lead,
    });
  });

  it("the page hash changes with the reference revision, title, family or text, and with the evaluator", () => {
    const h = page().hash;
    expect(page({ revId: 1 }).hash).not.toBe(h);
    expect(page({ title: "Petrels" }).hash).not.toBe(h);
    expect(page({ familyCode: "other1" }).hash).not.toBe(h);
    expect(page({ lead: reference.lead + " More." }).hash).not.toBe(h);
    expect(
      buildEvalText(article, ["sea"], {
        evaluatorHash: "f".repeat(64),
        reference,
      }).hash,
    ).not.toBe(h);
    expect(
      buildEvalText(article, ["sea"], {
        evaluatorHash: evaluatorHash("habitat:open-ocean"),
        reference: null,
      }).hash,
    ).not.toBe(h);
  });

  it("the evaluator hash covers the question but not the sampling proxies", () => {
    expect(evaluatorHash("habitat:open-ocean")).toMatch(/^[0-9a-f]{64}$/);
    expect(tagEvalDesign("habitat:open-ocean")!.question).toMatch(
      /its family's article/,
    );
  });
});

import { describe, expect, it } from "vitest";

process.env.ANTHROPIC_API_KEY ??= "test-key";
const {
  parseAnnotation,
  buildUserPrompt,
  EnrichmentAiError,
  FIELD_CRAFT_MAX_CHARS,
  SIMILAR_NOTE_MAX_CHARS,
  MAX_SIMILAR,
} = await import("./ai-enrichment");

describe("parseAnnotation (pure response parser)", () => {
  it("extracts bare JSON, validates tags against the vocabulary, keeps field craft", () => {
    const out = parseAnnotation(
      'Here you go:\n{"tags": ["habitat:mudflat", "tide:falling", "made:up"], "field_craft": "Scan exposed flats on a falling tide."}',
    );
    expect(out.tags).toEqual(["habitat:mudflat", "tide:falling"]);
    expect(out.droppedTags).toEqual(["made:up"]);
    expect(out.fieldCraft).toBe("Scan exposed flats on a falling tide.");
  });

  it("clamps field craft length", () => {
    const out = parseAnnotation(
      `{"tags": [], "field_craft": "${"x".repeat(FIELD_CRAFT_MAX_CHARS + 200)}"}`,
    );
    expect(out.fieldCraft).toHaveLength(FIELD_CRAFT_MAX_CHARS);
  });

  it("rejects contradictory tide cardinality — at most ONE tide tag (CODEX1 P2 #4)", () => {
    expect(() =>
      parseAnnotation(
        '{"tags": ["tide:low", "tide:high-roost"], "field_craft": "Contradictory."}',
      ),
    ).toThrow(/contradictory tide/);
    // Exactly one is fine.
    const ok = parseAnnotation('{"tags": ["tide:low"], "field_craft": "Fine."}');
    expect(ok.tags).toEqual(["tide:low"]);
  });

  it("throws typed errors on junk or empty field craft", () => {
    expect(() => parseAnnotation("no json here")).toThrow(EnrichmentAiError);
    expect(() => parseAnnotation('{"tags": ["habitat:mudflat"]}')).toThrow(/no field craft/);
    expect(() => parseAnnotation('{"tags": [], "field_craft": "  "}')).toThrow(EnrichmentAiError);
  });
});

describe("buildUserPrompt", () => {
  const input = {
    comName: "Marbled Godwit",
    sciName: "Limosa fedoa",
    family: "Scolopacidae",
    extract: "A large shorebird of mudflats.",
    sections: [
      { title: "Distribution and habitat", text: "Coastal mudflats in winter." },
      { title: "Gallery", text: "should not be included" },
    ],
  };

  it("includes identity, prose, the FULL vocabulary, and the tide instruction", () => {
    const p = buildUserPrompt(input);
    expect(p).toContain("Marbled Godwit (Limosa fedoa)");
    expect(p).toContain("Coastal mudflats in winter.");
    expect(p).not.toContain("should not be included"); // non-fieldcraft section
    expect(p).toContain("habitat: forest,"); // vocabulary listing
    expect(p).toContain("tide:"); // dimension present
    expect(p).toMatch(/tide stage is most productive/); // td-47d6d5 payload
    expect(p).toMatch(/ONLY this JSON object/);
  });
});

/**
 * Closed-set validation for the similar-species output (td-8f0ed8 Step 3).
 *
 * This is what makes an invented SPECIES impossible. It does NOT make an
 * invented field mark impossible — the note is free text — which is why the
 * card carries the same "verify in the field" caveat as field craft, and why
 * these cases test identity separately from note content.
 */
describe("parseAnnotation — similar species", () => {
  const CANDIDATES = ["haiwoo", "labwoo"];
  const ok = (similar: string) =>
    parseAnnotation(
      `{"tags": [], "field_craft": "Check trunks.", "similar": ${similar}}`,
      { candidates: CANDIDATES, focalCode: "dowwoo" },
    );

  it("keeps entries whose code is in the candidate set", () => {
    const out = ok('[{"code": "haiwoo", "note": "Larger, with a longer bill."}]');
    expect(out.similar).toEqual([
      { code: "haiwoo", note: "Larger, with a longer bill." },
    ]);
    expect(out.droppedSimilar).toEqual([]);
  });

  it("DROPS a code outside the candidate set and reports it", () => {
    const out = ok(
      '[{"code": "haiwoo", "note": "Larger."}, {"code": "invented1", "note": "Nope."}]',
    );
    expect(out.similar.map((s) => s.code)).toEqual(["haiwoo"]);
    expect(out.droppedSimilar).toEqual(["invented1"]);
  });

  it("drops a self-reference even if it is somehow in the candidate list", () => {
    const out = parseAnnotation(
      '{"tags": [], "field_craft": "x", "similar": [{"code": "dowwoo", "note": "Me."}]}',
      { candidates: ["dowwoo", "haiwoo"], focalCode: "dowwoo" },
    );
    expect(out.similar).toEqual([]);
    expect(out.droppedSimilar).toEqual(["dowwoo"]);
  });

  it("dedupes repeated codes, keeping the first", () => {
    const out = ok(
      '[{"code": "haiwoo", "note": "First."}, {"code": "haiwoo", "note": "Second."}]',
    );
    expect(out.similar).toEqual([{ code: "haiwoo", note: "First." }]);
  });

  it("matches codes case-insensitively but stores the canonical casing", () => {
    const out = ok('[{"code": "HAIWOO", "note": "Larger."}]');
    expect(out.similar).toEqual([{ code: "haiwoo", note: "Larger." }]);
  });

  it("caps note length", () => {
    const out = ok(`[{"code": "haiwoo", "note": "${"x".repeat(400)}"}]`);
    expect(out.similar[0].note).toHaveLength(SIMILAR_NOTE_MAX_CHARS);
  });

  it("caps the number of entries at MAX_SIMILAR", () => {
    const many = Array.from({ length: 12 }, (_, i) => `c${i}`);
    const body = many.map((c) => `{"code": "${c}", "note": "n"}`).join(",");
    const out = parseAnnotation(
      `{"tags": [], "field_craft": "x", "similar": [${body}]}`,
      { candidates: many, focalCode: "dowwoo" },
    );
    expect(out.similar).toHaveLength(MAX_SIMILAR);
  });

  it("skips an entry with an empty note — the basis line already says why the link exists", () => {
    const out = ok('[{"code": "haiwoo", "note": "   "}]');
    expect(out.similar).toEqual([]);
  });

  it("accepts NO candidates at all: nothing is allowed through", () => {
    const out = parseAnnotation(
      '{"tags": [], "field_craft": "x", "similar": [{"code": "haiwoo", "note": "Larger."}]}',
    );
    expect(out.similar).toEqual([]);
    expect(out.droppedSimilar).toEqual(["haiwoo"]);
  });

  it("a MISSING similar field yields [] and does NOT throw", () => {
    const out = parseAnnotation(
      '{"tags": ["habitat:mudflat"], "field_craft": "Scan the flats."}',
      { candidates: CANDIDATES, focalCode: "dowwoo" },
    );
    expect(out.similar).toEqual([]);
    expect(out.fieldCraft).toBe("Scan the flats.");
  });

  it("a MALFORMED similar field yields [] and preserves tags + field craft", () => {
    // The whole point of `similar` being optional: one bad list must not cost
    // this species its field craft for the next 7 days.
    for (const bad of ['"not an array"', "42", "null", '[1, 2, "x"]', "[{}]"]) {
      const out = parseAnnotation(
        `{"tags": ["habitat:mudflat"], "field_craft": "Scan the flats.", "similar": ${bad}}`,
        { candidates: CANDIDATES, focalCode: "dowwoo" },
      );
      expect(out.similar).toEqual([]);
      expect(out.fieldCraft).toBe("Scan the flats.");
      expect(out.tags).toEqual(["habitat:mudflat"]);
    }
  });
});

describe("buildUserPrompt — candidate block", () => {
  const base = {
    comName: "Downy Woodpecker",
    sciName: "Dryobates pubescens",
    family: "Woodpeckers",
    extract: "A small woodpecker.",
    sections: [],
  };

  it("omits the similar-species instruction entirely when there are no candidates", () => {
    const p = buildUserPrompt(base);
    expect(p).not.toContain('"similar"');
    expect(p).toContain('{"tags": ["..."], "field_craft": "..."}');
  });

  it("lists candidate codes and asks for notes about the CANDIDATE", () => {
    const p = buildUserPrompt({
      ...base,
      candidates: [
        {
          code: "haiwoo",
          comName: "Hairy Woodpecker",
          sciName: "Dryobates villosus",
        },
      ],
    });
    expect(p).toContain("haiwoo = Hairy Woodpecker (Dryobates villosus)");
    expect(p).toContain("never invent a species");
    expect(p).toContain("Write about the candidate, not about Downy Woodpecker.");
  });
});

import { describe, expect, it } from "vitest";

process.env.ANTHROPIC_API_KEY ??= "test-key";
const { parseAnnotation, buildUserPrompt, EnrichmentAiError, FIELD_CRAFT_MAX_CHARS } =
  await import("./ai-enrichment");

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

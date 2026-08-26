import { describe, expect, it } from "vitest";

process.env.ANTHROPIC_API_KEY ??= "test-key";
const {
  parseAnnotation,
  buildUserPrompt,
  EnrichmentAiError,
  FIELD_CRAFT_MAX_CHARS,
  SIMILAR_NOTE_MAX_CHARS,
  MAX_SIMILAR,
  clampNote,
  buildOutputSchema,
  SIMILAR_NOTE_MIN_CHARS,
  isMalformedNote,
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

  it("accepts the KEYED-OBJECT form that structured outputs returns", () => {
    const out = parseAnnotation(
      '{"tags": [], "field_craft": "x", "similar": {"haiwoo": "Larger overall, with a bill roughly as long as the head is wide."}}',
      { candidates: CANDIDATES, focalCode: "dowwoo" },
    );
    expect(out.similar).toEqual([{ code: "haiwoo", note: "Larger overall, with a bill roughly as long as the head is wide." }]);
  });

  it("still drops an out-of-set key in the object form", () => {
    const out = parseAnnotation(
      '{"tags": [], "field_craft": "x", "similar": {"brnpel1": "Barred black-and-white back rather than a clean white stripe.", "haiwoo": "Larger overall, with a bill roughly as long as the head is wide."}}',
      { candidates: CANDIDATES, focalCode: "dowwoo" },
    );
    expect(out.similar.map((s) => s.code)).toEqual(["haiwoo"]);
    expect(out.droppedSimilar).toEqual(["brnpel1"]);
  });

  it("keeps entries whose code is in the candidate set", () => {
    const out = ok('[{"code": "haiwoo", "note": "Larger overall, with a bill roughly as long as the head is wide."}]');
    expect(out.similar).toEqual([
      { code: "haiwoo", note: "Larger overall, with a bill roughly as long as the head is wide." },
    ]);
    expect(out.droppedSimilar).toEqual([]);
  });

  it("DROPS a code outside the candidate set and reports it", () => {
    const out = ok(
      '[{"code": "haiwoo", "note": "Larger overall, with a bill roughly as long as the head is wide."}, {"code": "invented1", "note": "Barred black-and-white back rather than a clean white stripe."}]',
    );
    expect(out.similar.map((s) => s.code)).toEqual(["haiwoo"]);
    expect(out.droppedSimilar).toEqual(["invented1"]);
  });

  it("drops a self-reference even if it is somehow in the candidate list", () => {
    const out = parseAnnotation(
      '{"tags": [], "field_craft": "x", "similar": [{"code": "dowwoo", "note": "Larger overall, with a bill roughly as long as the head is wide."}]}',
      { candidates: ["dowwoo", "haiwoo"], focalCode: "dowwoo" },
    );
    expect(out.similar).toEqual([]);
    expect(out.droppedSimilar).toEqual(["dowwoo"]);
  });

  it("dedupes repeated codes, keeping the first", () => {
    const out = ok(
      '[{"code": "haiwoo", "note": "First: larger overall, with a notably longer, heavier bill."}, {"code": "haiwoo", "note": "Second: larger overall, with a notably longer, heavier bill."}]',
    );
    expect(out.similar).toEqual([{ code: "haiwoo", note: "First: larger overall, with a notably longer, heavier bill." }]);
  });

  it("matches codes case-insensitively but stores the canonical casing", () => {
    const out = ok('[{"code": "HAIWOO", "note": "Larger overall, with a bill roughly as long as the head is wide."}]');
    expect(out.similar).toEqual([{ code: "haiwoo", note: "Larger overall, with a bill roughly as long as the head is wide." }]);
  });

  it("caps note length", () => {
    // Input is sized RELATIVE to the cap: a hardcoded length silently stops
    // testing anything the moment SIMILAR_NOTE_MAX_CHARS moves.
    // Must be long AND non-repetitive: a repeated filler is itself flagged as
    // a decoding loop, which is the correct behaviour but not what this tests.
    const parts = [
      "Larger overall with a noticeably heavier bill",
      "the nape shows a dark spur visible head-on",
      "outer tail feathers are clean white without bars",
      "flanks wash buff rather than grey in autumn",
      "voice is a sharper peek than the focal bird",
      "wingbars average bolder and better defined",
      "legs run pinkish instead of dull olive",
      "crown pattern lacks any rufous tinge at rest",
      "primary projection is longer on perched birds",
      "eye-ring is thin and broken behind the eye",
      "undertail coverts are plain rather than spotted",
      "bill base shows pale pink in most individuals",
    ];
    const long = parts.join("; ");
    expect(long.length).toBeGreaterThan(SIMILAR_NOTE_MAX_CHARS);
    const out = ok(`[{"code": "haiwoo", "note": "${long}"}]`);
    expect(out.similar[0].note.length).toBeLessThanOrEqual(SIMILAR_NOTE_MAX_CHARS);
  });

  it("caps the number of entries at MAX_SIMILAR", () => {
    const many = Array.from({ length: 12 }, (_, i) => `c${i}`);
    const body = many.map((c) => `{"code": "${c}", "note": "Larger overall, with a bill roughly as long as the head is wide."}`).join(",");
    const out = parseAnnotation(
      `{"tags": [], "field_craft": "x", "similar": [${body}]}`,
      { candidates: many, focalCode: "dowwoo" },
    );
    expect(out.similar).toHaveLength(MAX_SIMILAR);
  });

  it("RECORDS an empty note rather than skipping it silently", () => {
    // A required-but-empty value satisfies json_schema and used to look
    // identical to "the model had nothing to say".
    const out = ok('[{"code": "haiwoo", "note": "   "}]');
    expect(out.similar).toEqual([]);
    expect(out.droppedSimilar).toEqual(["haiwoo:empty"]);
  });

  it("rejects a stub note that games the required-field schema", () => {
    // Observed live: a required `similar` key satisfied with a 1-char value.
    const out = ok('[{"code": "haiwoo", "note": "."}]');
    expect(out.similar).toEqual([]);
    expect(out.droppedSimilar).toEqual(["haiwoo:too-short"]);
  });

  it("accepts a note at exactly the minimum length", () => {
    const note = "x".repeat(SIMILAR_NOTE_MIN_CHARS);
    const out = ok(`[{"code": "haiwoo", "note": "${note}"}]`);
    expect(out.similar).toEqual([{ code: "haiwoo", note }]);
  });

  it("accepts NO candidates at all: nothing is allowed through", () => {
    const out = parseAnnotation(
      '{"tags": [], "field_craft": "x", "similar": [{"code": "haiwoo", "note": "Larger overall, with a bill roughly as long as the head is wide."}]}',
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

  it("tells the model to copy codes verbatim (guards the brnpel1 miss)", () => {
    const p = buildUserPrompt({
      ...base,
      candidates: [
        { code: "brnpel", comName: "Brown Pelican", sciName: "Pelecanus occidentalis", basis: "ebird_slash" as const },
      ],
    });
    expect(p).toContain("Copy each code EXACTLY as written above");
    expect(p).toContain("trailing digit");
  });

  it("lists candidate codes and asks for notes about the CANDIDATE", () => {
    const p = buildUserPrompt({
      ...base,
      candidates: [
        {
          code: "haiwoo",
          comName: "Hairy Woodpecker",
          sciName: "Dryobates villosus", basis: "ebird_slash" as const,
        },
      ],
    });
    expect(p).toContain("haiwoo = Hairy Woodpecker (Dryobates villosus)");
    // The "don't invent a code" rule now lives in the candidate block, next to
    // the codes themselves, rather than in instruction 3.
    expect(p).toContain("do not construct a code for any species");
    expect(p).toContain("Write about the candidate, not about Downy Woodpecker.");
  });
});

describe("clampNote — graceful length capping (Opus 5 writes long)", () => {
  const CAP = SIMILAR_NOTE_MAX_CHARS;

  it("leaves a note within the cap untouched", () => {
    const short = "Larger overall, with a bill about as long as the head is wide.";
    expect(clampNote(short)).toBe(short);
  });

  it("normalises internal whitespace", () => {
    expect(clampNote("  Larger   overall.  ")).toBe("Larger overall.");
  });

  it("NEVER cuts a word in half", () => {
    // The real failure this guards: a blunt slice produced
    // "...roughly equal to hea" on live Opus 5 output.
    const long = `${"marbled ".repeat(Math.ceil(CAP / 4))}headlength`;
    const out = clampNote(long);
    expect(out.length).toBeLessThanOrEqual(CAP + 1);
    expect(out.endsWith("…")).toBe(true);
    // Every surviving word must be a whole word from the original.
    for (const w of out.replace(/…$/, "").trim().split(" ")) {
      expect(long).toContain(w);
    }
    expect(out).not.toMatch(/\bmarble…$/);
  });

  it("prefers a late sentence boundary over a word cut", () => {
    const first = "a".repeat(CAP - 50);
    const out = clampNote(`${first}. ${"b".repeat(CAP)}`);
    expect(out).toBe(`${first}.`);
    expect(out).not.toContain("…");
  });

  it("ignores an early sentence boundary that would gut the note", () => {
    // A period at char ~7 must not reduce the note to a two-word fragment.
    const out = clampNote(`Approx. ${"c".repeat(CAP * 2)}`);
    expect(out.length).toBeGreaterThan(CAP * 0.5);
    expect(out.endsWith("…")).toBe(true);
  });

  it("does not leave dangling punctuation before the ellipsis", () => {
    const out = clampNote(`${"word ".repeat(Math.ceil(CAP / 5))}however, ${"x".repeat(80)}`);
    expect(out).not.toMatch(/[,;:—-]…$/);
  });

  it("clamps a single unbroken token without crashing", () => {
    const out = clampNote("z".repeat(CAP * 2));
    expect(out.length).toBeLessThanOrEqual(CAP);
    expect(out.endsWith("…")).toBe(true);
  });

  it("holds these guarantees at any cap value", () => {
    // Belt-and-braces: the properties above must not depend on CAP's value.
    for (const sample of [
      "short note.",
      `${"alpha ".repeat(200)}omega`,
      `Approx. ${"q".repeat(900)}`,
      "y".repeat(1200),
    ]) {
      const out = clampNote(sample);
      expect(out.length).toBeLessThanOrEqual(CAP + 1);
      expect(out).not.toMatch(/\s$/);
    }
  });
});

describe("buildOutputSchema — shape is the guarantee", () => {
  const slash = {
    code: "lessca",
    comName: "Lesser Scaup",
    sciName: "Aythya affinis",
    basis: "ebird_slash" as const,
  };
  const genus = {
    code: "dalpel1",
    comName: "Dalmatian Pelican",
    sciName: "Pelecanus crispus",
    basis: "genus" as const,
  };

  it("omits `similar` entirely when there are no candidates", () => {
    const s = buildOutputSchema([]) as never as { properties: Record<string, unknown>; required: string[] };
    expect(s.properties.similar).toBeUndefined();
    expect(s.required).not.toContain("similar");
  });

  it("REQUIRES a note for every eBird-slash candidate", () => {
    // This is the whole point: an eBird reporting group is the assertion that
    // birders confuse the pair, so silence is the one answer that can't be right.
    const s = buildOutputSchema([slash, genus]) as never as {
      properties: { similar: { required: string[]; properties: Record<string, unknown> } };
    };
    expect(s.properties.similar.required).toEqual(["lessca"]);
    expect(Object.keys(s.properties.similar.properties).sort()).toEqual(["dalpel1", "lessca"]);
  });

  it("REQUIRES a note for a reciprocal genus candidate (the kingfisher case)", () => {
    // Belted Kingfisher's page explains how to separate Ringed. Ringed's page
    // must therefore explain Belted: confusability is mutual even though the
    // note is directional. Without this the genus tier decided independently in
    // each direction and one page showed a bare "Same genus" row.
    const s2 = buildOutputSchema([{ ...genus, reciprocal: true }]) as never as {
      properties: { similar: { required: string[] } };
    };
    expect(s2.properties.similar.required).toEqual([genus.code]);
  });

  it("tells the model WHY a reciprocal candidate is owed a note", () => {
    const p = buildUserPrompt({
      comName: "Ringed Kingfisher",
      sciName: "Megaceryle torquata",
      family: "Kingfishers",
      extract: "A large kingfisher.",
      sections: [],
      candidates: [
        {
          code: "belkin1",
          comName: "Belted Kingfisher",
          sciName: "Megaceryle alcyon",
          basis: "genus" as const,
          reciprocal: true,
        },
      ],
    });
    expect(p).toContain("a note is owed here too");
  });

  it("leaves same-genus candidates optional", () => {
    const s = buildOutputSchema([genus]) as never as {
      properties: { similar: { required: string[] } };
    };
    expect(s.properties.similar.required).toEqual([]);
  });

  it("makes an invented code unrepresentable", () => {
    const s = buildOutputSchema([slash]) as never as {
      properties: { similar: { additionalProperties: boolean; properties: Record<string, unknown> } };
    };
    expect(s.properties.similar.additionalProperties).toBe(false);
    expect(s.properties.similar.properties).not.toHaveProperty("lessca1");
  });
});

describe("isMalformedNote — structural damage, not meaning", () => {
  it("catches the exact corruption that reached production", () => {
    const real =
      "Body and breast are warm brown rather than blackish, so the contrast with the pink flanks looks softer. Distant or worn birds in poor light can be genuinely tricky, and mixed flocks demand care on each individual., bircapped birds aside, focus on body tone.the bircolour is the cleanest mark.";
    expect(isMalformedNote(real)).toBe(true);
  });

  it("catches sentence-end punctuation followed by a comma or semicolon", () => {
    expect(isMalformedNote("Larger overall., and paler.")).toBe(true);
    expect(isMalformedNote("Larger overall.; paler below.")).toBe(true);
  });

  it("catches a period glued to the next word", () => {
    expect(isMalformedNote("Focus on body tone.the colour is cleanest.")).toBe(true);
  });

  it("catches doubled sentence-enders but not an ellipsis", () => {
    expect(isMalformedNote("Really?? Larger overall.")).toBe(true);
    expect(isMalformedNote("Larger overall.. Paler below.")).toBe(true);
    expect(isMalformedNote("Larger overall… paler below.")).toBe(false);
  });

  it("catches the signatures the first version missed (AGY, live in prod)", () => {
    const cases = [
      // Glued period before an UPPERCASE word — the old rule saw only lowercase.
      "versus the white-crowns coo-cura-coo.Pigeon.Pigeon.Pigeon.",
      "favors thorny desert washes rather than open bunchgrass.Broken song is a chip-chip-trill.",
      "stay dark-bodied with a duller, deeper bill.Pulin bill is deeper and more orange.",
      "a guttural gawking series.Cuckoo tail pattern is similar, so check face first.",
      // Quotes sitting between the sentence end and the comma.
      'white on Kittlitzs, dark on Marbled."",',
      'Best mark is tail length and rufous extent.",',
      // Guillemets — only ever seen inside termination loops.
      "usually settles it.», Grebe size alone usually settles it.»,",
      "is optional.», ends here.», is complete.» in short, check throat.",
      // Doubled period.
      "compact..a far more compact bird overall..a much smaller bird.",
      // Stray serialisation debris.
      'Males show more extensive white in the outer tail.""}',
    ];
    for (const bad of cases) expect(isMalformedNote(bad)).toBe(true);
  });

  it("catches a single-token stutter with clean punctuation", () => {
    // From prod: "...black cap.is is is is is is grey mantle contrast." In the
    // live note the glued period also gave it away; spaced out like this only
    // the stutter rule sees it, which is why both rules exist.
    const loop =
      "Sooty, so check for the grey mantle against the black cap. is is is is is is grey mantle contrast.";
    expect(isMalformedNote(loop)).toBe(true);
  });

  it("does not treat ordinary emphasis as a stutter", () => {
    expect(isMalformedNote("A very very slightly paler crown, best seen head-on.")).toBe(false);
  });

  it("does NOT reject common abbreviations", () => {
    // The whole risk of this check is false positives on correct notes.
    for (const ok of [
      "Larger, e.g. noticeably bulkier through the chest and neck.",
      "Paler overall, i.e. washed out rather than saturated brown.",
      "Compare ssp. alticola, which shows a broader grey crown band.",
      "Around 2.5 times heavier, with a proportionately deeper bill.",
      "Told from the nominate by the paler nape; cf. the Hepburn's form.",
      "Note the buffy flanks — e.g. on worn autumn birds — and dark legs.",
      "A long, drawn-out moan followed by three loud coos… then silence.",
      "See cf. the Hepburn's form for the full grey face.",
      "Bill is ~1.5x the head length; the nape shows a dark spur.",
      "Voice only; plumage identical.",
      "Larger overall, with a bill roughly as long as the head is wide.",
    ]) {
      expect(isMalformedNote(ok)).toBe(false);
    }
  });

  it("does not reject a decimal or an abbreviation followed by lowercase", () => {
    expect(isMalformedNote("Around 1.5x larger, with a heavier bill.")).toBe(false);
  });
});

describe("parseAnnotation — malformed and over-cap handling", () => {
  // Must exceed MAX_SIMILAR so the over-cap path is actually reached; sized
  // from the constant rather than hardcoded so raising the cap cannot silently
  // stop testing it.
  const CANDS = Array.from({ length: MAX_SIMILAR + 1 }, (_, i) => `cand${i}`);
  const p = (similar: string) =>
    parseAnnotation(`{"tags": [], "field_craft": "x", "similar": ${similar}}`, {
      candidates: CANDS,
      focalCode: "dowwoo",
    });

  it("drops a malformed note and records why", () => {
    const out = p('{"cand0": "Larger overall., bircapped birds aside, focus on body tone."}');
    expect(out.similar).toEqual([]);
    expect(out.droppedSimilar).toEqual(["cand0:malformed"]);
  });

  it("keeps a good note alongside a malformed sibling", () => {
    const good = "Barred black-and-white back rather than a clean white stripe.";
    const out = p(`{"cand0": "Bad., glued.the word", "cand1": "${good}"}`);
    expect(out.similar).toEqual([{ code: "cand1", note: good }]);
    expect(out.droppedSimilar).toEqual(["cand0:malformed"]);
  });

  it("records over-cap candidates instead of silently truncating", () => {
    const note = "Larger overall, with a bill roughly as long as the head is wide.";
    const body = CANDS.map((c) => `"${c}": "${note}"`).join(",");
    const out = p(`{${body}}`);
    expect(out.similar).toHaveLength(MAX_SIMILAR);
    expect(out.droppedSimilar).toEqual([`${CANDS[MAX_SIMILAR]}:over-cap`]);
  });

  it("accepts a terse voice-only answer that the old 40-char floor rejected", () => {
    const out = p('{"cand0": "Voice only; plumage identical."}');
    expect(out.similar).toEqual([{ code: "cand0", note: "Voice only; plumage identical." }]);
  });
});

const { generateSpeciesAnnotation } = await import("./ai-enrichment");
const { SELECTABLE_MODELS } = await import("./ai-models");
// The process.env line at the top cannot rescue a key BLANKED to "" (the
// ~/.claude/settings.json override does exactly that in every Claude Code
// subprocess): $env/dynamic/private bakes its snapshot before ??= can help.
// House pattern (xeno-canto.test.ts): write onto the snapshot POJO directly.
const { env: dynamicEnv } = await import("$env/dynamic/private");
if (!dynamicEnv.ANTHROPIC_API_KEY) dynamicEnv.ANTHROPIC_API_KEY = "test-key";

describe("generateSpeciesAnnotation (fetcher seam — first tests, plan step 5)", () => {
  const OPUS = SELECTABLE_MODELS.find((m) => m.id === "claude-opus-5")!;

  const INPUT = {
    comName: "Downy Woodpecker",
    sciName: "Dryobates pubescens",
    family: "Picidae",
    extract: "Small woodpecker of open woods.",
    sections: [],
    candidates: [
      {
        code: "haiwoo",
        comName: "Hairy Woodpecker",
        sciName: "Leuconotopicus villosus",
        basis: "ebird_slash" as const,
      },
    ],
    speciesCode: "dowwoo",
  };
  const GOOD_TEXT = JSON.stringify({
    tags: ["habitat:mudflat"],
    field_craft: "Scan trunks low; listen for the soft pik call.",
    similar: [{ code: "haiwoo", note: "Hairy shows a much longer bill relative to its head." }],
  });
  const okBody = (over: Record<string, unknown> = {}) => ({
    model: "claude-opus-5",
    stop_reason: "end_turn",
    usage: {
      input_tokens: 1200,
      output_tokens: 400,
      output_tokens_details: { thinking_tokens: 60 },
    },
    content: [{ type: "text", text: GOOD_TEXT }],
    ...over,
  });
  const resp = (
    body: unknown,
    init: { status?: number; headers?: Record<string, string> } = {},
  ) =>
    new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { "request-id": "req_test_1", ...init.headers },
    });
  const fetcherReturning = (r: Response) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return r;
    }) as typeof fetch;
    return { fetcher, calls };
  };

  it("success: returns annotation + envelope, request built by the registry, auth merged at fetch time", async () => {
    const { fetcher, calls } = fetcherReturning(resp(okBody()));
    const out = await generateSpeciesAnnotation(INPUT, OPUS, { fetcher });
    expect(out.annotation.fieldCraft).toContain("Scan trunks");
    expect(out.annotation.similar).toHaveLength(1);
    expect(out.envelope.requestId).toBe("req_test_1");
    expect(out.envelope.httpStatus).toBe(200);
    expect(out.envelope.attempts).toHaveLength(1);
    expect(out.envelope.attempts[0]).toMatchObject({
      billed: true,
      inputTokens: 1200,
      outputTokens: 400,
      thinkingTokens: 60,
    });
    // The registry's shape, not an inline body: Opus 5 pins.
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.max_tokens).toBe(8000); // 2000 answer + 6000 headroom
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.fallbacks).toBe("default");
    const headers = calls[0].init.headers as Record<string, string>;
    // Compare against whatever key the env actually holds — a real key from
    // the user's shell must pass this too, not just the test fallback.
    expect(headers["x-api-key"]).toBe(dynamicEnv.ANTHROPIC_API_KEY);
    expect(headers["x-api-key"]).toBeTruthy();
    expect(headers["anthropic-beta"]).toBe("server-side-fallback-2026-07-01");
  });

  it("PINNED (the kitmur test): a max_tokens truncation throws WITH the envelope — usage and stop_reason were in hand and must not be discarded", async () => {
    const { fetcher } = fetcherReturning(
      resp(
        okBody({
          stop_reason: "max_tokens",
          content: [{ type: "text", text: '{"tags": ["habitat:mud' }],
        }),
      ),
    );
    const err = await generateSpeciesAnnotation(INPUT, OPUS, { fetcher }).catch((e) => e);
    expect(err).toBeInstanceOf(EnrichmentAiError);
    expect(err.envelope).toBeDefined();
    expect(err.envelope.attempts[0].stopReason).toBe("max_tokens");
    expect(err.envelope.attempts[0].inputTokens).toBe(1200); // real spend on the failure
    expect(err.envelope.requestId).toBe("req_test_1");
  });

  it("a refusal (200, output 0) throws with an UNBILLED event envelope", async () => {
    const { fetcher } = fetcherReturning(
      resp(
        okBody({
          stop_reason: "refusal",
          content: [],
          usage: { input_tokens: 900, output_tokens: 0 },
        }),
      ),
    );
    const err = await generateSpeciesAnnotation(INPUT, OPUS, { fetcher }).catch((e) => e);
    expect(err).toBeInstanceOf(EnrichmentAiError);
    expect(err.message).toMatch(/declined/);
    expect(err.envelope.attempts[0].billed).toBe(false);
  });

  it("a non-2xx throws with envelope carrying http_status, provider error.type, and the request-id support asks for", async () => {
    const { fetcher } = fetcherReturning(
      resp(
        { error: { type: "rate_limit_error", message: "slow down" } },
        { status: 429, headers: { "retry-after": "30" } },
      ),
    );
    const err = await generateSpeciesAnnotation(INPUT, OPUS, { fetcher }).catch((e) => e);
    expect(err).toBeInstanceOf(EnrichmentAiError);
    expect(err.rateLimited).toBe(true);
    expect(err.retryAfterMs).toBe(30_000);
    expect(err.envelope.httpStatus).toBe(429);
    expect(err.envelope.providerErrorType).toBe("rate_limit_error");
    expect(err.envelope.requestId).toBe("req_test_1");
  });

  it("PINNED: 529 overloaded_error is rate-limited (same drain-pause as 429)", async () => {
    const { fetcher } = fetcherReturning(
      resp({ error: { type: "overloaded_error", message: "busy" } }, { status: 529 }),
    );
    const err = await generateSpeciesAnnotation(INPUT, OPUS, { fetcher }).catch((e) => e);
    expect(err).toBeInstanceOf(EnrichmentAiError);
    expect(err.rateLimited).toBe(true);
    expect(err.status).toBe(529);
    expect(err.envelope.providerErrorType).toBe("overloaded_error");
  });

  it("served model ≠ requested model propagates through the envelope (fallback provenance)", async () => {
    const { fetcher } = fetcherReturning(resp(okBody({ model: "claude-opus-4-8" })));
    const out = await generateSpeciesAnnotation(INPUT, OPUS, { fetcher });
    expect(out.envelope.attempts.find((a) => a.isFinal)?.servedModel).toBe("claude-opus-4-8");
  });
});

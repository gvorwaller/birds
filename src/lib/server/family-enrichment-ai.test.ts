import { it, expect, vi, beforeEach } from "vitest";
const metered = vi.hoisted(() => vi.fn());
vi.mock("./ai-call", () => ({ meteredAiCall: metered }));
import {
  familyPassages,
  validateFamilyDescription,
  generateFamilyDescription,
  verifyFamilyDescription,
  type FamilySource,
} from "./family-enrichment-ai";
import { CONFIG_KEYS } from "./app-config";

const source: FamilySource = {
  title: "Fixture",
  url: "https://example.org",
  revision: 1,
  qid: "Q1",
  fetchedAt: "2026-09-11",
  text: "They eat seeds.\n\nSome species nest in trees.\nOther species nest on the ground.",
};
const draft = {
  paragraphs: [
    {
      topic: "Food",
      text: "These birds eat seeds as part of their diet.",
      evidence: ["P1"],
    },
  ],
};
beforeEach(() => metered.mockReset());
it("accepts a short source passage without requiring a long copied quotation", () => {
  expect(familyPassages(source)).toHaveLength(3);
  expect(validateFamilyDescription(draft, source)).toEqual(draft);
  for (const evidence of [["P99"], ["They eat seeds."], [7]]) {
    expect(() =>
      validateFamilyDescription(
        { paragraphs: [{ ...draft.paragraphs[0], evidence }] },
        source,
      ),
    ).toThrow(
      "Draft paragraph 1: evidence must reference existing source passage IDs",
    );
  }
});
it("uses the independent Sonnet 5 default for both calls", async () => {
  await generateFamilyDescription(1, "Fixtureidae", source);
  await verifyFamilyDescription(1, "Fixtureidae", source, draft);
  for (const [opts] of metered.mock.calls) {
    expect(opts.configKey).toBe(CONFIG_KEYS.familyEnrichmentModel);
    expect(opts.defaultModelId).toBe("claude-sonnet-5");
    expect(opts.purpose).toBe("enrichment");
  }
});

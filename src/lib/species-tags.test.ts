import { describe, expect, it } from "vitest";
import {
  ALL_TAGS,
  groupTags,
  MAX_TAGS,
  TAG_VOCABULARY,
  tagLabel,
  validateTags,
} from "./species-tags";

describe("species tag vocabulary (plan Phase 2, GROK v1)", () => {
  it("control is enforced in code: unknown tags dropped and reported, known kept, capped, deduped", () => {
    const { tags, dropped } = validateTags([
      "habitat:mudflat",
      "HABITAT:MUDFLAT", // case-normalized dup
      "tide:falling",
      "habitat:parking-lot", // not in vocabulary
      "movement:pelagic", // GROK: pelagic is NOT a movement value
      42,
      "",
    ]);
    expect(tags).toEqual(["habitat:mudflat", "tide:falling"]);
    expect(dropped).toEqual(["habitat:parking-lot", "movement:pelagic"]);
  });

  it("caps at MAX_TAGS", () => {
    const many = [...ALL_TAGS].slice(0, MAX_TAGS + 5);
    expect(validateTags(many).tags).toHaveLength(MAX_TAGS);
  });

  it("non-array input yields empty", () => {
    expect(validateTags("habitat:mudflat")).toEqual({ tags: [], dropped: [] });
    expect(validateTags(null)).toEqual({ tags: [], dropped: [] });
  });

  it("groupTags orders by dimension and strips prefixes", () => {
    const groups = groupTags(["tide:falling", "habitat:mudflat", "habitat:beach"]);
    expect(groups).toEqual([
      { dimension: "habitat", values: ["mudflat", "beach"] },
      { dimension: "tide", values: ["falling"] },
    ]);
  });

  it("tide labels carry the literal word Tide (color+text rule)", () => {
    expect(tagLabel("tide", "falling")).toBe("Tide: falling");
    expect(tagLabel("tide", "tide-independent")).toBe("tide independent");
    expect(tagLabel("habitat", "woodland-edge")).toBe("woodland edge");
  });

  it("vocabulary sanity: pelagic under habitat only; GROK additions present", () => {
    expect(TAG_VOCABULARY.habitat).toContain("open-ocean");
    expect(TAG_VOCABULARY.movement).not.toContain("pelagic");
    for (const added of ["mangrove", "riparian", "conifer", "jetty-pier"])
      expect(TAG_VOCABULARY.habitat).toContain(added);
    expect(TAG_VOCABULARY.forage).toContain("stalking-wader");
    expect(TAG_VOCABULARY.forage).toContain("sallying-flycatcher");
    expect(TAG_VOCABULARY.tide).toContain("mid-tide");
    expect(TAG_VOCABULARY.time).toContain("dusk-peak");
    expect(TAG_VOCABULARY.movement).toContain("altitudinal");
    expect(TAG_VOCABULARY.find).toContain("canopy");
    expect(TAG_VOCABULARY.find).toContain("overhead-flight");
  });
});

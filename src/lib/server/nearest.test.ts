import { describe, expect, it } from "vitest";
import { AUTO_RUN_CAP, pickAutoRunTargets } from "./nearest";
import { isHotspotLocId } from "$lib/loc-id";
import { validEbirdSpeciesCode } from "./ebird";

const sp = (code: string, areaFreq: number, lowSample = false) => ({
  code,
  comName: code,
  areaFreq,
  lowSample,
});

describe("pickAutoRunTargets (GROK pins: cap 6, likely-only, no padding)", () => {
  it("N = min(6, likely): caps at 6 and reports the true likely count", () => {
    const many = Array.from({ length: 9 }, (_, i) => sp(`s${i}`, 0.5 - i * 0.02));
    const { picks, likelyCount } = pickAutoRunTargets(many);
    expect(picks).toHaveLength(AUTO_RUN_CAP);
    expect(likelyCount).toBe(9);
    expect(picks.map((p) => p.code)).toEqual(["s0", "s1", "s2", "s3", "s4", "s5"]);
  });

  it("fewer than 6 likely → exactly those, NEVER padded with lower bands", () => {
    const { picks, likelyCount } = pickAutoRunTargets([
      sp("a", 0.4),
      sp("b", 0.25),
      sp("c", 0.15), // possible band — must not fill the empty slots
      sp("d", 0.03), // longshot
    ]);
    expect(picks.map((p) => p.code)).toEqual(["a", "b"]);
    expect(likelyCount).toBe(2);
  });

  it("lowSample rows are skipped even in the likely band", () => {
    const { picks } = pickAutoRunTargets([
      sp("good", 0.3),
      sp("thin", 0.6, true),
    ]);
    expect(picks.map((p) => p.code)).toEqual(["good"]);
  });

  it("zero likely → empty picks (the page must NOT auto-run)", () => {
    const { picks, likelyCount } = pickAutoRunTargets([sp("c", 0.1)]);
    expect(picks).toHaveLength(0);
    expect(likelyCount).toBe(0);
  });
});

describe("isHotspotLocId (GROK pin 4: link by id shape, not the radius set)", () => {
  it("links L-ids, never personal or junk ids", () => {
    expect(isHotspotLocId("L127286")).toBe(true);
    expect(isHotspotLocId("L1")).toBe(true);
    expect(isHotspotLocId("P12345")).toBe(false);
    expect(isHotspotLocId("L12X")).toBe(false);
    expect(isHotspotLocId("")).toBe(false);
    expect(isHotspotLocId(null)).toBe(false);
    expect(isHotspotLocId(undefined)).toBe(false);
  });
});

describe("validEbirdSpeciesCode (URL-path guard for the nearest endpoint)", () => {
  it("accepts eBird shapes, rejects traversal/injection shapes", () => {
    expect(validEbirdSpeciesCode("roster")).toBe(true);
    expect(validEbirdSpeciesCode("gubter2")).toBe(true);
    expect(validEbirdSpeciesCode("x03col")).toBe(true);
    expect(validEbirdSpeciesCode("../etc")).toBe(false);
    expect(validEbirdSpeciesCode("UPPER")).toBe(false);
    expect(validEbirdSpeciesCode("a b")).toBe(false);
    expect(validEbirdSpeciesCode("")).toBe(false);
  });
});

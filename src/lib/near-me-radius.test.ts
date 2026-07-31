import { describe, expect, it } from "vitest";
import {
  DEFAULT_NEAR_ME_RADIUS_KM,
  NEAR_ME_RADIUS_OPTIONS_KM,
  normalizeNearMeRadiusKm,
  radiusSelectOptionsKm,
  selectEffectiveRadiusKm,
  validateNearMeRadiusKm,
} from "./near-me-radius";

describe("Near Me radius", () => {
  it("keeps the legacy 25-mile default as 40 km", () => {
    expect(DEFAULT_NEAR_ME_RADIUS_KM).toBe(40);
    expect(normalizeNearMeRadiusKm(null)).toBe(40);
    expect(normalizeNearMeRadiusKm("not-a-radius")).toBe(40);
  });

  it("accepts whole kilometer values inside the eBird geo radius cap", () => {
    expect(validateNearMeRadiusKm("1")).toEqual({ ok: true, value: 1 });
    expect(validateNearMeRadiusKm("50")).toEqual({ ok: true, value: 50 });
    expect(validateNearMeRadiusKm(24)).toEqual({ ok: true, value: 24 });
  });

  it("rejects non-integer or out-of-range values instead of silently clamping", () => {
    expect(validateNearMeRadiusKm("")).toMatchObject({ ok: false });
    expect(validateNearMeRadiusKm("12.5")).toMatchObject({ ok: false });
    expect(validateNearMeRadiusKm("0")).toMatchObject({ ok: false });
    expect(validateNearMeRadiusKm("51")).toMatchObject({ ok: false });
  });
});

describe("effective radius selection", () => {
  it("uses the saved radius when dist is absent or empty", () => {
    expect(selectEffectiveRadiusKm(null, 24)).toBe(24);
    expect(selectEffectiveRadiusKm(undefined, 24)).toBe(24);
    expect(selectEffectiveRadiusKm("", 24)).toBe(24);
    expect(selectEffectiveRadiusKm("   ", 24)).toBe(24);
  });

  it("honors a valid explicit dist for the current view only", () => {
    expect(selectEffectiveRadiusKm("25", 40)).toBe(25);
    expect(selectEffectiveRadiusKm("1", 40)).toBe(1);
    expect(selectEffectiveRadiusKm("50", 8)).toBe(50);
  });

  it("falls back to the saved radius for an invalid dist, never to 50", () => {
    expect(selectEffectiveRadiusKm("0", 24)).toBe(24);
    expect(selectEffectiveRadiusKm("51", 24)).toBe(24);
    expect(selectEffectiveRadiusKm("12.5", 24)).toBe(24);
    expect(selectEffectiveRadiusKm("abc", 24)).toBe(24);
    expect(selectEffectiveRadiusKm("-10", 24)).toBe(24);
  });

  it("falls back to the app default when nothing is saved", () => {
    expect(selectEffectiveRadiusKm(null, null)).toBe(DEFAULT_NEAR_ME_RADIUS_KM);
    expect(selectEffectiveRadiusKm("nope", null)).toBe(
      DEFAULT_NEAR_ME_RADIUS_KM,
    );
  });
});

describe("radius select options", () => {
  it("always contains the effective radius", () => {
    for (const km of [1, 8, 16, 24, 25, 40, 50]) {
      expect(radiusSelectOptionsKm(km)).toContain(km);
    }
  });

  it("keeps the standard options and stays sorted", () => {
    const opts = radiusSelectOptionsKm(25);
    for (const km of NEAR_ME_RADIUS_OPTIONS_KM) expect(opts).toContain(km);
    expect(opts).toEqual([...opts].sort((a, b) => a - b));
    expect(new Set(opts).size).toBe(opts.length);
  });

  it("does not grow when the effective radius is already an option", () => {
    expect(radiusSelectOptionsKm(40)).toEqual([...NEAR_ME_RADIUS_OPTIONS_KM]);
  });

  it("every option it offers is a legal effective radius", () => {
    for (const km of radiusSelectOptionsKm(25)) {
      expect(validateNearMeRadiusKm(km)).toEqual({ ok: true, value: km });
      expect(selectEffectiveRadiusKm(String(km), 40)).toBe(km);
    }
  });
});

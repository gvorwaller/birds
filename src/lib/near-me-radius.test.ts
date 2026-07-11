import { describe, expect, it } from "vitest";
import {
  DEFAULT_NEAR_ME_RADIUS_KM,
  normalizeNearMeRadiusKm,
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

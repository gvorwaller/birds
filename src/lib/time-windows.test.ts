import { describe, expect, it } from "vitest";
import {
  backOptionLabel,
  DEFAULT_BACK_DAYS,
  parseBackDays,
  SPECIES_DEFAULT_BACK_DAYS,
  windowPhrase,
} from "./time-windows";

describe("time windows", () => {
  it("accepts the supported one-day window", () => {
    expect(parseBackDays("1")).toBe(1);
  });

  it("rejects unsupported arbitrary windows", () => {
    expect(parseBackDays("2")).toBe(DEFAULT_BACK_DAYS);
    expect(parseBackDays("2", SPECIES_DEFAULT_BACK_DAYS)).toBe(
      SPECIES_DEFAULT_BACK_DAYS,
    );
  });

  it("labels one day as 24 hours", () => {
    expect(backOptionLabel(1)).toBe("Last 24 hours");
    expect(windowPhrase(1)).toBe("last 24 hours");
    expect(backOptionLabel(14)).toBe("Last 14 days");
    expect(windowPhrase(14)).toBe("last 14 days");
  });
});

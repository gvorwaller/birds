import { describe, expect, it } from "vitest";
import { calendarMonth, formatMonthWindow } from "./forecast-calendar";

describe("calendarMonth", () => {
  it("uses the owner's timezone, not the server's (UTC droplet)", () => {
    // 2026-08-01 01:00 UTC is still 2026-07-31 in America/New_York.
    expect(calendarMonth(new Date("2026-08-01T01:00:00Z"))).toBe(7);
    expect(calendarMonth(new Date("2026-08-01T12:00:00Z"))).toBe(8);
  });
});

describe("formatMonthWindow", () => {
  it("formats a consecutive run as a range", () => {
    expect(formatMonthWindow([1, 2, 3])).toBe("Jan–Mar");
  });

  it("joins a year-boundary wrap into one range (the caracara case)", () => {
    expect(formatMonthWindow([12, 1, 2, 3])).toBe("Dec–Mar");
    expect(formatMonthWindow([11, 12, 1])).toBe("Nov–Jan");
  });

  it("comma-joins non-consecutive groups", () => {
    // A migrant with spring + fall windows.
    expect(formatMonthWindow([4, 5, 9, 10])).toBe("Apr–May, Sep–Oct");
    expect(formatMonthWindow([12, 1, 6])).toBe("Jun, Dec–Jan");
  });

  it("handles singletons, duplicates, and junk", () => {
    expect(formatMonthWindow([5])).toBe("May");
    expect(formatMonthWindow([5, 5, 4])).toBe("Apr–May");
    expect(formatMonthWindow([0, 13, 5])).toBe("May");
    expect(formatMonthWindow([])).toBe("");
  });

  it("calls all twelve months year-round", () => {
    expect(formatMonthWindow([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])).toBe(
      "year-round",
    );
  });
});

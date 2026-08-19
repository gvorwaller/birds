import { describe, expect, it } from "vitest";
import { fmtNextScan } from "./next-scan";

describe("fmtNextScan (td-b7d021 hub line)", () => {
  it("today / tomorrow / weekday in America/New_York", () => {
    const now = new Date("2026-08-19T18:00:00Z"); // Aug 19, 2:00 PM EDT
    expect(fmtNextScan("2026-08-19T21:11:00Z", now)).toBe("today 5:11 PM ET");
    expect(fmtNextScan("2026-08-20T17:11:00Z", now)).toBe("tomorrow 1:11 PM ET");
    expect(fmtNextScan("2026-08-22T17:11:00Z", now)).toBe("Saturday 1:11 PM ET");
  });

  it("late-evening UTC scan still labels by the NY calendar date", () => {
    const now = new Date("2026-08-19T18:00:00Z");
    // 03:30Z Aug 20 = 11:30 PM EDT Aug 19 → today, not tomorrow.
    expect(fmtNextScan("2026-08-20T03:30:00Z", now)).toBe("today 11:30 PM ET");
  });

  it("spring-forward: tomorrow is the next CALENDAR date, not now+24h (CODEX1)", () => {
    // 11:30 PM EST on Mar 7, 2026 — the night before the 23-hour DST day.
    // now+24h would land at 12:30 AM EDT on Mar 9 and mislabel a true
    // Mar 8 scan as a weekday.
    const now = new Date("2026-03-08T04:30:00Z");
    expect(fmtNextScan("2026-03-09T03:30:00Z", now)).toBe("tomorrow 11:30 PM ET");
  });

  it("fall-back boundary keeps the same contract", () => {
    // 11:30 PM EDT on Oct 31, 2026 — the night before the 25-hour day.
    const now = new Date("2026-11-01T03:30:00Z");
    expect(fmtNextScan("2026-11-02T04:30:00Z", now)).toBe("tomorrow 11:30 PM ET");
  });
});

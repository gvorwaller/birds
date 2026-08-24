import { describe, expect, it } from "vitest";
import {
  dayPrefix,
  formatFeet,
  formatTideDate,
  formatTideTime,
  tidePhrase,
  tideWord,
} from "./tide-format";

describe("formatTideTime", () => {
  // 2026-08-24 18:41Z is EDT (summer); 2026-01-24 18:41Z is EST (winter).
  it("America/New_York across both DST seasons", () => {
    expect(formatTideTime("2026-08-24T18:41:00Z", "America/New_York")).toBe(
      "2:41 PM EDT",
    );
    expect(formatTideTime("2026-01-24T18:41:00Z", "America/New_York")).toBe(
      "1:41 PM EST",
    );
  });

  it("Pacific/Honolulu never observes DST", () => {
    expect(formatTideTime("2026-08-24T18:41:00Z", "Pacific/Honolulu")).toBe(
      "8:41 AM HST",
    );
    expect(formatTideTime("2026-01-24T18:41:00Z", "Pacific/Honolulu")).toBe(
      "8:41 AM HST",
    );
  });

  it("America/Adak: HADT in summer, HAST in winter", () => {
    expect(formatTideTime("2026-08-24T18:41:00Z", "America/Adak")).toBe(
      "9:41 AM HADT",
    );
    expect(formatTideTime("2026-01-24T18:41:00Z", "America/Adak")).toBe(
      "8:41 AM HAST",
    );
  });
});

describe("formatFeet", () => {
  it("rounds to one decimal", () => {
    expect(formatFeet(2.123)).toBe("2.1 ft");
    expect(formatFeet(2.05)).toBe("2.1 ft");
    expect(formatFeet(0)).toBe("0.0 ft");
  });

  it("uses U+2212 minus sign for negative values, not a hyphen", () => {
    const result = formatFeet(-0.1);
    expect(result).toBe("−0.1 ft");
    expect(result).not.toContain("-"); // ASCII hyphen must not appear
  });

  it("a small negative that rounds to zero shows no minus sign", () => {
    // -0.048 rounds to -0 in JS; must display as "0.0 ft", not "−0.0 ft".
    expect(formatFeet(-0.048)).toBe("0.0 ft");
  });
});

describe("dayPrefix", () => {
  const tz = "America/New_York";
  it("dayOffset 0 → empty string", () => {
    expect(
      dayPrefix(
        { type: "H", at: "2026-08-24T18:41:00Z", feetMllw: 2, dayOffset: 0 },
        tz,
      ),
    ).toBe("");
  });

  it('dayOffset 1 → "tomorrow "', () => {
    expect(
      dayPrefix(
        { type: "H", at: "2026-08-25T18:41:00Z", feetMllw: 2, dayOffset: 1 },
        tz,
      ),
    ).toBe("tomorrow ");
  });

  it("dayOffset > 1 → weekday short name + trailing space", () => {
    // 2026-08-26 is a Wednesday.
    expect(
      dayPrefix(
        { type: "H", at: "2026-08-26T18:41:00Z", feetMllw: 2, dayOffset: 2 },
        tz,
      ),
    ).toBe("Wed ");
  });
});

describe("tideWord", () => {
  it("maps H/L to High/Low", () => {
    expect(tideWord("H")).toBe("High");
    expect(tideWord("L")).toBe("Low");
  });
});

describe("tidePhrase", () => {
  const tz = "America/New_York";
  it("dayOffset 0: no day prefix", () => {
    expect(
      tidePhrase(
        { type: "L", at: "2026-08-24T18:41:00Z", feetMllw: 0.6, dayOffset: 0 },
        tz,
      ),
    ).toBe("Low 2:41 PM EDT\u00A0(0.6 ft)");
  });

  it('dayOffset 1: "tomorrow" prefix and negative feet', () => {
    expect(
      tidePhrase(
        { type: "L", at: "2026-08-25T10:12:00Z", feetMllw: -0.1, dayOffset: 1 },
        tz,
      ),
    ).toBe("Low tomorrow 6:12 AM EDT\u00A0(−0.1 ft)");
  });

  it("joins the height with a non-breaking space (no plain space before the paren)", () => {
    const phrase = tidePhrase(
      { type: "H", at: "2026-08-24T18:01:00Z", feetMllw: 2.1, dayOffset: 0 },
      tz,
    );
    expect(phrase).toContain("\u00A0(");
    expect(phrase).not.toContain(" (");
  });
});

describe("formatTideDate", () => {
  it("humanizes a station-local YYYY-MM-DD with the correct weekday", () => {
    expect(formatTideDate("2026-09-15")).toBe("Tue, Sep 15");
    expect(formatTideDate("2026-08-24")).toBe("Mon, Aug 24");
  });

  it("passes through non-conforming input unchanged", () => {
    expect(formatTideDate("garbage")).toBe("garbage");
  });
});

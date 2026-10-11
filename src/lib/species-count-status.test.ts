import { describe, expect, it } from "vitest";
import {
  fmtAgo,
  fmtCountsTime,
  speciesCountStatus,
} from "./species-count-status";

const readAt = "2026-10-10T19:00:00Z"; // Oct 10, 3:00 PM EDT
const base = {
  hasCounts: true,
  builtAt: "2026-10-10T18:48:00Z",
  failing: false,
  sourceChanged: false,
  refreshActive: true,
  readAt,
};

describe("species-count status (td-de2150)", () => {
  it("no snapshot: counts being prepared, never a zero", () => {
    const s = speciesCountStatus({ ...base, hasCounts: false, builtAt: null });
    expect(s.state).toBe("preparing");
    expect(`${s.lead} ${s.detail}`).toContain("Counts being prepared");
    expect(s.rowText).toBe("Counts being prepared");
    expect(`${s.lead} ${s.detail} ${s.rowText}`).not.toMatch(/\b0 species/);
  });

  it("no snapshot and the first build failed: unavailable, retried automatically", () => {
    const s = speciesCountStatus({
      ...base,
      hasCounts: false,
      builtAt: null,
      failing: true,
    });
    expect(s.state).toBe("unavailable");
    expect(s.rowText).toBe("Counts unavailable");
    expect(s.detail).toContain("retried automatically");
  });

  it("current snapshot: updated, relative and absolute time", () => {
    const s = speciesCountStatus(base);
    expect(s).toMatchObject({
      state: "current",
      lead: "Updated 12 min ago (today 2:48 PM ET)",
      detail: "",
    });
    // A place missing from the published counts is not a counted zero.
    expect(s.rowText).toBe("Not yet counted");
  });

  it("newer data with the refresh queued: updating, still showing the last counts", () => {
    const s = speciesCountStatus({ ...base, sourceChanged: true });
    expect(s.state).toBe("updating");
    expect(s.lead).toBe("Updating…");
    expect(s.detail).toContain(
      "Showing counts from 12 min ago (today 2:48 PM ET)",
    );
  });

  it("newer data but no refresh job: says the newer data isn't counted yet", () => {
    const s = speciesCountStatus({
      ...base,
      sourceChanged: true,
      refreshActive: false,
    });
    expect(s.state).toBe("pending");
    expect(`${s.lead} ${s.detail}`).toContain(
      "newer loaded data isn't counted yet",
    );
  });

  it("last refresh failed: keeps showing the last good counts with their time", () => {
    const s = speciesCountStatus({
      ...base,
      failing: true,
      sourceChanged: true,
    });
    expect(s.state).toBe("failed");
    expect(s.lead).toBe("Last refresh failed");
    expect(s.detail).toContain(
      "showing counts from 12 min ago (today 2:48 PM ET)",
    );
  });

  it("formats times in the app zone: today, yesterday, a date, another year", () => {
    const now = new Date(readAt);
    expect(fmtCountsTime("2026-10-10T04:30:00Z", now)).toBe(
      "today 12:30 AM ET",
    );
    expect(fmtCountsTime("2026-10-10T03:30:00Z", now)).toBe(
      "yesterday 11:30 PM ET",
    );
    expect(fmtCountsTime("2026-10-08T13:05:00Z", now)).toBe(
      "Oct 8, 9:05 AM ET",
    );
    expect(fmtCountsTime("2025-12-31T17:00:00Z", now)).toBe(
      "Dec 31, 2025, 12:00 PM ET",
    );
  });

  it("relative wording", () => {
    const now = new Date(readAt);
    expect(fmtAgo("2026-10-10T18:59:30Z", now)).toBe("just now");
    expect(fmtAgo("2026-10-10T18:01:00Z", now)).toBe("59 min ago");
    expect(fmtAgo("2026-10-10T16:00:00Z", now)).toBe("3 h ago");
    expect(fmtAgo("2026-10-07T19:00:00Z", now)).toBe("3 days ago");
  });
});

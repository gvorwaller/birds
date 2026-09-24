import { describe, expect, it } from "vitest";
import {
  alertLinesCloserThan,
  alertLinesNearHome,
  omittedAlertReports,
  relativeAge,
  storedAlertReports,
  type StoredAlertReport,
} from "./alert-evidence";

const now = new Date(2026, 8, 21, 7, 30); // Mon Sep 21, 2026, local

describe("relativeAge", () => {
  it("gives two sends on the same local day the same day count", () => {
    const hawk = new Date(2026, 8, 19, 6, 57).toISOString();
    const flycatcher = new Date(2026, 8, 19, 8, 1).toISOString();
    expect(relativeAge(hawk, now)).toBe("2 days ago");
    expect(relativeAge(flycatcher, now)).toBe(relativeAge(hawk, now));
  });

  it("does not round a 36-hour-old send up to two days while its sibling stays at one", () => {
    const viewed = new Date(2026, 8, 20, 19, 30);
    const earlier = new Date(2026, 8, 19, 7, 0).toISOString();
    const later = new Date(2026, 8, 19, 8, 30).toISOString();
    expect(relativeAge(earlier, viewed)).toBe("1 day ago");
    expect(relativeAge(later, viewed)).toBe("1 day ago");
  });

  it("stays in minutes across midnight instead of jumping to a day", () => {
    const sent = new Date(2026, 8, 20, 23, 58).toISOString();
    const viewed = new Date(2026, 8, 21, 0, 1);
    expect(relativeAge(sent, viewed)).toBe("3 min ago");
  });

  it("stays in hours until a full day has passed", () => {
    const sent = new Date(2026, 8, 20, 9, 0).toISOString();
    expect(relativeAge(sent, new Date(2026, 8, 21, 8, 50))).toBe("23 hr ago");
    expect(relativeAge(sent, new Date(2026, 8, 21, 9, 10))).toBe("1 day ago");
  });

  it("keeps minute precision inside the sent calendar day", () => {
    const sent = new Date(2026, 8, 21, 7, 0).toISOString();
    expect(relativeAge(sent, now)).toBe("30 min ago");
  });
});

describe("stored alert lines", () => {
  const sentAt = "2026-09-20T12:00:00.000Z";
  const hawk = {
    subId: "S1",
    locName: "Omni Amelia Island Plantation Resort",
    obsDt: "2026-09-19 06:57",
    distanceMi: 23,
  };

  it("keeps a checklist the live feeds omitted and drops one they returned", () => {
    const stored = storedAlertReports(
      [
        {
          sentAt,
          reports: [
            hawk,
            { ...hawk, subId: "S2", locName: "Far pond", distanceMi: 123 },
          ],
        },
      ],
      14,
      now,
    );
    const shown = omittedAlertReports(stored, [
      { subId: "S2", locName: "Far pond", obsDt: "2026-09-19 06:57" },
    ]);
    expect(shown.map((row) => row.subId)).toEqual(["S1"]);
  });

  it("dedupes the same checklist to the newest send and drops a date outside the window", () => {
    const rows = storedAlertReports(
      [
        { sentAt: "2026-09-20T18:00:00.000Z", reports: [hawk] },
        {
          sentAt: "2026-09-19T18:00:00.000Z",
          reports: [{ ...hawk, distanceMi: 99 }],
        },
        {
          sentAt,
          reports: [{ ...hawk, subId: "SOLD", obsDt: "2026-08-01 06:57" }],
        },
      ],
      14,
      now,
    );
    expect(rows).toEqual<StoredAlertReport[]>([
      { ...hawk, sentAt: "2026-09-20T18:00:00.000Z" },
    ]);
  });

  it("matches a checklist-less row by place and sighting time", () => {
    const anon = { ...hawk, subId: null };
    const stored = storedAlertReports([{ sentAt, reports: [anon] }], 14, now);
    expect(
      omittedAlertReports(stored, [
        { subId: null, locName: anon.locName, obsDt: anon.obsDt },
      ]),
    ).toEqual([]);
    expect(omittedAlertReports(stored, [])).toHaveLength(1);
  });
});

describe("alertLinesNearHome", () => {
  const line = (distanceMi: number): StoredAlertReport => ({
    subId: `S${distanceMi}`,
    locName: "Pond",
    obsDt: "2026-09-19 06:57",
    distanceMi,
    sentAt: "2026-09-20T12:00:00.000Z",
  });

  it("hides every line when the card is centered on a searched place", () => {
    expect(alertLinesNearHome([line(5)], false, 50)).toEqual([]);
  });

  it("keeps only lines inside the card's radius", () => {
    // 31 mi is ~49.9 km, inside the default 50 km; 32 mi is ~51.5 km.
    const shown = alertLinesNearHome([line(23), line(31), line(32)], true, 50);
    expect(shown.map((row) => row.distanceMi)).toEqual([23, 31]);
  });

  it("has no distance limit for an any-distance card", () => {
    expect(
      alertLinesNearHome([line(900)], true, Number.POSITIVE_INFINITY),
    ).toHaveLength(1);
  });

  it("keeps a stored line that is strictly closer than the live nearest row", () => {
    const stored = line(10); // 16.0934 km
    expect(alertLinesCloserThan([stored], 16.2)).toEqual([stored]);
    expect(alertLinesCloserThan([stored], 16)).toEqual([]);
  });
});

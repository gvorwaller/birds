import { describe, expect, it } from "vitest";
import {
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

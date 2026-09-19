import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { filterNearbyEvidence, mergeNearbyEvidence, parseNearestControls } from "./nearest-evidence";
import type { EbirdObs } from "./ebird";

const row = (p: Partial<EbirdObs>): EbirdObs => ({
  speciesCode: "naswar", comName: "Nashville Warbler", sciName: "Leiothlypis ruficapilla",
  locId: "L1", locName: "Park", obsDt: "2026-09-18 13:16", lat: 30, lng: -81,
  obsValid: true, obsReviewed: false, locationPrivate: false, ...p,
});

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] });vi.setSystemTime(new Date("2026-09-19T12:00:00Z")); });
afterEach(() => vi.useRealTimers());

describe("nearest evidence", () => {
  it("filters species, finite radius, malformed dates and invalid coordinates before closest five", () => {
    const valid = Array.from({length: 7}, (_, n) => row({subId: `S${n}`, lat: 30 + n * 0.01}));
    const rows = filterNearbyEvidence([
      row({subId: "wrong", speciesCode: "other"}), row({subId: "invalid", lat: NaN}),
      row({subId: "old", obsDt: "2026-08-01"}), row({subId: "future", obsDt: "2026-09-21"}),
      row({subId: "bad-date", obsDt: "2026-99-99"}), row({subId: "far", lat: 31}),
      ...valid.slice().reverse(), valid[0],
    ], new Set(["naswar"]), {lat: 30, lon: -81}, 1, 25);
    expect(rows.map(r => r.subId)).toEqual(["S0", "S1", "S2", "S3", "S4"]);
  });
  it("keeps the unknown-timezone margin without accepting clearly stale reports", () => {
    const rows = filterNearbyEvidence([row({subId:"yesterday",obsDt:"2026-09-18 23:59"}),row({subId:"local-tomorrow",obsDt:"2026-09-20"}),row({subId:"too-old",obsDt:"2026-09-16"})], new Set(["naswar"]), {lat:30,lon:-81},1,"any");
    expect(rows.map(r=>r.subId).sort()).toEqual(["local-tomorrow","yesterday"]);
  });
  it("rejects invalid supplied controls", () => {
    expect(parseNearestControls("2", null).ok).toBe(false);
    expect(parseNearestControls(null, "12").ok).toBe(false);
    expect(parseNearestControls(null, "50")).toMatchObject({ ok: true });
  });
  it("dedupes exact copies but keeps distinct checklists and takes closest five", () => {
    const rows = filterNearbyEvidence([
      row({ subId: "S1", lat: 30, lng: -81 }),
      row({ subId: "S1", lat: 30, lng: -81, source: "notable" }),
      row({ subId: "S2", lat: 30.01, lng: -81 }),
    ], new Set(["naswar"]), { lat: 30, lon: -81 }, 14, "any", new Date("2026-09-19T12:00:00Z"));
    expect(rows).toHaveLength(2);
    expect(rows.map((x) => x.subId)).toEqual(["S1", "S2"]);
  });
  it("retains one-sided evidence and marks it incomplete", () => {
    const merged = mergeNearbyEvidence(
      { rows: [row({ subId: "S1" })], stale: false, partial: false },
      null,
      new Set(["naswar"]), { lat: 30, lon: -81 }, 14, "any",
    );
    expect(merged.rows).toHaveLength(1);
    expect(merged.partial).toBe(true);
    expect(merged.notableFailed).toBe(true);
  });
});

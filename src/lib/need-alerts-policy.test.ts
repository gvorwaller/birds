import { describe, expect, it } from "vitest";
import {
  alertCandidates,
  PER_SCAN_CAP,
  type AlertObs,
} from "./need-alerts-policy";

const HOME = { lat: 27.77, lng: -82.64 }; // St. Petersburg
const NOW = new Date("2026-08-16T15:00:00");

function obs(over: Partial<AlertObs> & { speciesCode: string }): AlertObs {
  return {
    comName: "Snail Kite",
    locId: "L1",
    locName: "Sweetwater Wetlands",
    obsDt: "2026-08-16 14:40",
    lat: HOME.lat + 0.1,
    lng: HOME.lng,
    obsValid: true,
    obsReviewed: true,
    locationPrivate: false,
    ...over,
  };
}

function run(notable: AlertObs[], over: Partial<Parameters<typeof alertCandidates>[0]> = {}) {
  return alertCandidates({
    notable,
    seen: new Set(),
    sentAt: new Map(),
    now: NOW,
    realertDays: 7,
    home: HOME,
    ...over,
  });
}

describe("alertCandidates", () => {
  it("alerts only species NOT on the life list", () => {
    const out = run(
      [obs({ speciesCode: "snakit" }), obs({ speciesCode: "grbher3", comName: "Great Blue Heron" })],
      { seen: new Set(["grbher3"]) },
    );
    expect(out.map((c) => c.speciesCode)).toEqual(["snakit"]);
  });

  it("respects the rolling re-alert window, and re-alerts after it", () => {
    const day = 24 * 60 * 60 * 1000;
    const recent = new Map([["snakit", NOW.getTime() - 3 * day]]);
    expect(run([obs({ speciesCode: "snakit" })], { sentAt: recent })).toEqual([]);
    const old = new Map([["snakit", NOW.getTime() - 8 * day]]);
    expect(run([obs({ speciesCode: "snakit" })], { sentAt: old })).toHaveLength(1);
  });

  it("one candidate per species: CLOSEST wins, others counted in the body", () => {
    const out = run([
      obs({ speciesCode: "snakit", locId: "Lfar", locName: "Far Marsh", lat: HOME.lat + 0.5 }),
      obs({ speciesCode: "snakit", locId: "Lnear", locName: "Near Pond", lat: HOME.lat + 0.05 }),
      obs({ speciesCode: "snakit", locId: "Lmid", locName: "Mid Flats", lat: HOME.lat + 0.2 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].obs.locId).toBe("Lnear");
    expect(out[0].body).toContain("Near Pond");
    expect(out[0].body).toContain("and 2 more locations");
  });

  it("unconfirmed marker lives in the TITLE (lock screens truncate — GROK §2)", () => {
    const confirmed = run([obs({ speciesCode: "a1" })])[0];
    expect(confirmed.title).toBe("Lifer nearby: Snail Kite");
    const provisional = run([obs({ speciesCode: "a2", obsReviewed: false })])[0];
    expect(provisional.title).toBe("Lifer nearby: Snail Kite (unconfirmed)");
    const invalid = run([obs({ speciesCode: "a3", obsValid: false })])[0];
    expect(invalid.title).toContain("(unconfirmed)");
  });

  it("body is self-contained: place · N mi FROM HOME · when · count", () => {
    const c = run([obs({ speciesCode: "snakit", howMany: 3 })])[0];
    expect(c.body).toMatch(/Sweetwater Wetlands · \d+ mi from home · today 14:40 · 3 seen/);
  });

  it("private locations get FULL detail like any other report (Gaylon ruling 2026-08-18 — the old redaction was never his call)", () => {
    const c = run([
      obs({ speciesCode: "snakit", locationPrivate: true, locName: "Secret Roost", howMany: 4 }),
    ])[0];
    expect(c.body).toContain("Secret Roost");
    expect(c.body).toMatch(/\d+ mi from home/);
    expect(c.body).toContain("4 seen");
  });

  it("per-scan cap bounds a first-enable burst, nearest species first", () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      obs({
        speciesCode: `sp${i}`,
        comName: `Bird ${i}`,
        locId: `L${i}`,
        lat: HOME.lat + 0.05 * (i + 1), // sp0 nearest
      }),
    );
    const out = run(many);
    expect(out).toHaveLength(PER_SCAN_CAP);
    expect(out[0].speciesCode).toBe("sp0");
    expect(out.map((c) => c.speciesCode)).toEqual(["sp0", "sp1", "sp2", "sp3", "sp4"]);
  });

  it("weekday shown for non-today observations", () => {
    const c = run([obs({ speciesCode: "snakit", obsDt: "2026-08-14 09:15" })])[0];
    expect(c.body).toContain("Fri 09:15");
  });
});

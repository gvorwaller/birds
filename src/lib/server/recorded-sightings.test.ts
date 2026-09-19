import { describe, expect, it } from "vitest";
import { recordedSightingsForHome } from "./recorded-sightings";

const rows = [
  { speciesCode: "shthaw", comName: "Short-tailed Hawk", firstSeen: "2026-09-02", locationName: "Home", locId: "L1", subId: "S1", obsCount: 2, lat: 30, lng: -81 },
  { speciesCode: "naswar", comName: "Nashville Warbler", firstSeen: null, locationName: null, locId: null, subId: null, obsCount: null, lat: null, lng: null },
  { speciesCode: "bad", comName: "Bad", firstSeen: "2026-09-22", locationName: "Future", locId: "L2", subId: null, obsCount: 1, lat: 30, lng: -81 },
];

describe("recorded sightings", () => {
  it("rejects invalid and impossible dates without throwing", () => {
    const view = recordedSightingsForHome(["2026-99-99", "2026-02-30"].map(firstSeen => ({...rows[0], firstSeen})), {lat:30,lng:-81},50,30,new Date("2026-09-19T12:00:00Z"));
    expect(view.every(row => !row.inWindow && row.undated)).toBe(true);
  });
  it("uses inclusive UTC calendar boundaries and rejects future rows", () => {
    const view = recordedSightingsForHome(rows, { lat: 30, lng: -81 }, 14, 30, new Date("2026-09-19T12:00:00Z"));
    expect(view[0].inWindow).toBe(true);
    expect(view[1].undated).toBe(true);
    expect(view[2].inWindow).toBe(false);
  });
  it("keeps unresolved locations labeled and out of radius results", () => {
    const view = recordedSightingsForHome(rows, { lat: 30, lng: -81 }, 1, 14, new Date("2026-09-19T12:00:00Z"));
    expect(view[1].locationUnavailable).toBe(true);
    expect(view[1].inRadius).toBe(false);
  });
});

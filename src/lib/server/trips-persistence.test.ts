import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  calls: [] as { text: string; params?: unknown[] }[],
  failStop: false,
  connect: vi.fn(),
  release: vi.fn(),
}));

const client = {
  query: async (text: string, params?: unknown[]) => {
    state.calls.push({ text, params });
    if (state.failStop && text.includes("INSERT INTO trip_stops")) throw new Error("stop insert failed");
    return text.includes("INSERT INTO trips") ? { rows: [{ id: 77 }] } : { rows: [] };
  },
  release: state.release,
};
state.connect.mockResolvedValue(client);

vi.mock("pg", () => ({
  default: { Pool: class Pool {
    connect = state.connect;
  } },
}));
vi.mock("$env/dynamic/private", () => ({ env: {} }));

import { savePlannedTrip } from "./trips";

const context = {
  version: 1 as const,
  source: "area-recent-preview" as const,
  seenStatus: "needs" as const,
  daysBack: 30,
  anchorLat: 30.41,
  anchorLng: -81.42,
  radiusKm: 40,
  anchorLabel: "Huguenot",
  locationId: "L1",
  locationLat: 30.41,
  locationLng: -81.419,
  count: 4,
  fetchedAt: "2026-09-18T12:00:00.000Z",
  plannedAt: "2026-09-18T12:01:00.000Z",
  stale: false,
};

const stop = {
  hotspot_id: "L1",
  name: "Huguenot",
  lat: 30.41,
  lon: -81.419,
  google_place_id: null,
  notes: "scope lagoon",
  target_count_at_save: 4,
  planned_count_context: context,
};

describe("savePlannedTrip persistence contract", () => {
  beforeEach(() => {
    state.calls.length = 0;
    state.failStop = false;
    state.connect.mockClear();
    state.release.mockClear();
  });

  it("binds JSONB context in the real transaction helper", async () => {
    await expect(savePlannedTrip(7, { name: "Huguenot", startDate: null, endDate: null, notes: null }, [stop])).resolves.toBe(77);
    const insert = state.calls.find((c) => c.text.includes("INSERT INTO trip_stops"));
    expect(insert?.text).toContain("planned_count_context");
    expect(insert?.params?.at(-1)).toBe(JSON.stringify(context));
    expect(state.calls.map((c) => c.text)).toEqual(expect.arrayContaining(["BEGIN", "COMMIT"]));
    expect(state.release).toHaveBeenCalledTimes(1);
  });

  it("rolls back through the real transaction helper when a stop insert fails", async () => {
    state.failStop = true;
    await expect(savePlannedTrip(7, { name: "Huguenot", startDate: null, endDate: null, notes: null }, [stop])).rejects.toThrow("stop insert failed");
    const names = state.calls.map((c) => c.text);
    expect(names).toEqual(["BEGIN", expect.stringContaining("INSERT INTO trips"), expect.stringContaining("INSERT INTO trip_stops"), "ROLLBACK"]);
    expect(names).not.toContain("COMMIT");
    expect(state.release).toHaveBeenCalledTimes(1);
  });
});

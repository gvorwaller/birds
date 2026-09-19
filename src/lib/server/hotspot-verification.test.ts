import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  ebirdFetchOrNull: vi.fn(),
  EbirdError: class EbirdError extends Error {
    status?: number;
    constructor(message: string, status?: number) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock("$lib/db", () => ({ query: mocks.query }));
vi.mock("$server/ebird", () => ({
  ebirdFetchOrNull: mocks.ebirdFetchOrNull,
  EbirdError: mocks.EbirdError,
}));

import {
  officialHotspotCacheEntry,
  parseOfficialHotspotInfo,
  resolveOfficialHotspot,
} from "./hotspot-page";

const valid = {
  locId: "L234146",
  locID: "L234146",
  name: "The Celery Fields",
  latitude: 27.3253186,
  longitude: -82.4336821,
  countyCode: "US-FL-115",
  stateCode: "US-FL",
  isHotspot: true,
};

beforeEach(() => {
  mocks.query.mockReset();
  mocks.ebirdFetchOrNull.mockReset();
});

describe("official hotspot verification boundary", () => {
  it("normalizes the verified official shape and aliases", () => {
    expect(parseOfficialHotspotInfo(valid, "L234146")).toMatchObject({
      locId: "L234146",
      locName: "The Celery Fields",
      lat: 27.3253186,
      lng: -82.4336821,
      countyCode: "US-FL-115",
      stateCode: "US-FL",
      isHotspot: true,
    });
  });

  it("rejects empty, personal, wrong-ID, mismatched-ID, and malformed responses", () => {
    expect(parseOfficialHotspotInfo(null, "L234146")).toBeNull();
    expect(parseOfficialHotspotInfo({ ...valid, isHotspot: false }, "L234146")).toBeNull();
    expect(parseOfficialHotspotInfo({ ...valid, locId: "L999", locID: "L999" }, "L234146")).toBeNull();
    expect(parseOfficialHotspotInfo({ ...valid, locID: "L999" }, "L234146")).toBeNull();
    expect(parseOfficialHotspotInfo({ ...valid, latitude: 91 }, "L234146")).toBeNull();
    expect(parseOfficialHotspotInfo({ ...valid, longitude: Number.NaN }, "L234146")).toBeNull();
    expect(parseOfficialHotspotInfo({ ...valid, name: "" }, "L234146")).toBeNull();
  });

  it("reports cache freshness instead of treating stale positive metadata as fresh", async () => {
    mocks.query.mockResolvedValue({ rows: [{ payload: valid, fetched_at: "2026-08-01T00:00:00.000Z" }] });
    const stale = await officialHotspotCacheEntry("L234146");
    expect(stale.meta?.isHotspot).toBe(true);
    expect(stale.fresh).toBe(false);

    mocks.query.mockResolvedValue({ rows: [{ payload: valid, fetched_at: new Date().toISOString() }] });
    const fresh = await officialHotspotCacheEntry("L234146");
    expect(fresh.fresh).toBe(true);
  });

  it("uses a fresh positive cache without calling eBird", async () => {
    mocks.query.mockResolvedValue({ rows: [{ payload: valid, fetched_at: new Date().toISOString() }] });
    const result = await resolveOfficialHotspot("L234146", "test-key");
    expect(result).toMatchObject({ stale: false, meta: { locId: "L234146" } });
    expect(mocks.ebirdFetchOrNull).not.toHaveBeenCalled();
  });

  it("ignores a cached wrong ID and never writes empty or 404 results", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ payload: { ...valid, locId: "L999", locID: "L999" }, fetched_at: new Date().toISOString() }] })
      .mockResolvedValueOnce({ rows: [] });
    mocks.ebirdFetchOrNull.mockResolvedValueOnce(null);
    const result = await resolveOfficialHotspot("L234146", "test-key");
    expect(result.meta).toBeNull();
    expect(mocks.ebirdFetchOrNull).toHaveBeenCalledTimes(1);
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 429, 500])("does not poison the cache on eBird failure %s", async (status) => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    mocks.ebirdFetchOrNull.mockRejectedValueOnce(new mocks.EbirdError("upstream", status));
    await expect(resolveOfficialHotspot("L234146", "test-key")).rejects.toThrow("upstream");
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it("returns stale positive identity only after a failed refresh and marks it stale", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ payload: valid, fetched_at: "2026-08-01T00:00:00.000Z" }] });
    mocks.ebirdFetchOrNull.mockRejectedValueOnce(new mocks.EbirdError("rate limited", 429));
    const result = await resolveOfficialHotspot("L234146", "test-key");
    expect(result).toMatchObject({ stale: true, refreshErrorStatus: 429, meta: { locId: "L234146" } });
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it("coalesces a refresh and writes only valid positive metadata", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    mocks.ebirdFetchOrNull.mockResolvedValue(valid);
    const [a, b] = await Promise.all([
      resolveOfficialHotspot("L234146", "test-key"),
      resolveOfficialHotspot("L234146", "test-key"),
    ]);
    expect(a.meta?.locId).toBe("L234146");
    expect(b.meta?.locId).toBe("L234146");
    expect(mocks.ebirdFetchOrNull).toHaveBeenCalledTimes(1);
  });
});

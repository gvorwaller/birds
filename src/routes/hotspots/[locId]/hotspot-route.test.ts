import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getEbirdApiKey: vi.fn(),
  recentHotspotObs: vi.fn(),
  frequencyMeta: vi.fn(),
  lastCompleteYear: vi.fn(),
  seenSet: vi.fn(),
  enqueueJob: vi.fn(),
  hotspotFromCache: vi.fn(),
  officialHotspotCacheEntry: vi.fn(),
  resolveOfficialHotspot: vi.fn(),
  hotspotPlace: vi.fn(),
  regionNames: vi.fn(),
  hotspotMonthly: vi.fn(),
  sweepAreaHotspots: vi.fn(),
}));

vi.mock("$server/ebird", () => ({
  EbirdError: class EbirdError extends Error {
    status?: number;
    constructor(message: string, status?: number) {
      super(message);
      this.status = status;
    }
  },
  getEbirdApiKey: mocks.getEbirdApiKey,
  recentHotspotObs: mocks.recentHotspotObs,
}));
vi.mock("$server/barchart", () => ({
  frequencyMeta: mocks.frequencyMeta,
  lastCompleteYear: mocks.lastCompleteYear,
}));
vi.mock("$server/needs", () => ({ seenSet: mocks.seenSet }));
vi.mock("$server/jobs", () => ({ enqueueJob: mocks.enqueueJob }));
vi.mock("$server/job-policy", () => ({
  dedupKeys: { loadHotspots: (codes: string[]) => `load:${codes.join(",")}` },
}));
vi.mock("$server/hotspot-sweep", () => ({ sweepAreaHotspots: mocks.sweepAreaHotspots }));
vi.mock("$server/hotspot-page", () => ({
  hotspotFromCache: mocks.hotspotFromCache,
  officialHotspotCacheEntry: mocks.officialHotspotCacheEntry,
  resolveOfficialHotspot: mocks.resolveOfficialHotspot,
  hotspotPlace: mocks.hotspotPlace,
  regionNames: mocks.regionNames,
  hotspotMonthly: mocks.hotspotMonthly,
  groupRecent: vi.fn(() => []),
  validLocId: (id: string) => /^L\d+$/.test(id),
}));
vi.mock("$lib/db", () => ({
  query: vi.fn(async () => ({ rows: [{ home_lat: null, home_lon: null }] })),
}));

import { actions, load } from "./+page.server";

const owner = { scopeId: 7, user: { id: 7, role: "user" } };
const viewer = { scopeId: 8, user: { id: 8, role: "viewer" } };
const viewerEvent = () =>
  ({
    locals: viewer,
    params: { locId: "L234146" },
    request: new Request("https://birds.test/hotspots/L234146", { method: "POST", body: new URLSearchParams() }),
  }) as never;
const event = (locId = "L234146", body = new URLSearchParams()) =>
  ({
    locals: owner,
    params: { locId },
    request: new Request("https://birds.test/hotspots/" + locId, { method: "POST", body }),
  }) as never;

beforeEach(() => {
  mocks.getEbirdApiKey.mockReset().mockResolvedValue("test-key");
  mocks.hotspotFromCache.mockReset().mockResolvedValue(null);
  mocks.officialHotspotCacheEntry.mockReset().mockResolvedValue({ meta: null, fetchedAt: null, fresh: false });
  mocks.resolveOfficialHotspot.mockReset().mockResolvedValue({
    meta: {
      locId: "L234146",
      locName: "The Celery Fields",
      lat: 27.3253186,
      lng: -82.4336821,
      countyCode: "US-FL-115",
      stateCode: "US-FL",
      numSpeciesAllTime: null,
      latestObsDt: null,
      isHotspot: true,
    },
    stale: false,
  });
  mocks.frequencyMeta.mockReset().mockResolvedValue(new Map());
  mocks.lastCompleteYear.mockReset().mockReturnValue(2025);
  mocks.seenSet.mockReset().mockResolvedValue(new Set());
  mocks.hotspotPlace.mockReset().mockResolvedValue({ googlePlaceId: null, googlePlaceName: null, venueTypes: [], locName: null });
  mocks.regionNames.mockReset().mockResolvedValue(new Map());
  mocks.hotspotMonthly.mockReset().mockResolvedValue({ year: [], species: [] });
  mocks.enqueueJob.mockReset().mockResolvedValue({ jobId: 91, deduped: false });
});

describe("hotspot load action recovery", () => {
  it("rejects viewers before reading credentials or verification cache", async () => {
    const result = await actions.load_hotspot(viewerEvent());
    expect(result).toMatchObject({ status: 403 });
    expect(mocks.getEbirdApiKey).not.toHaveBeenCalled();
    expect(mocks.resolveOfficialHotspot).not.toHaveBeenCalled();
    expect(mocks.enqueueJob).not.toHaveBeenCalled();
  });

  it("verifies missing cache metadata before enqueueing the exact hotspot", async () => {
    const result = await actions.load_hotspot(event());
    expect(mocks.resolveOfficialHotspot).toHaveBeenCalledWith("L234146", "test-key");
    expect(mocks.enqueueJob).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "load_hotspots",
        dedupKey: "load:L234146",
        payload: {
          locs: [
            expect.objectContaining({
              code: "L234146",
              kind: "hotspot",
              name: "The Celery Fields",
              regionCode: "US-FL-115",
            }),
          ],
          force: false,
        },
      }),
    );
    expect(result).toMatchObject({ queued: { jobId: 91, label: "The Celery Fields" } });
  });

  it("does not enqueue when official verification is unresolved", async () => {
    mocks.resolveOfficialHotspot.mockResolvedValue({ meta: null, stale: false });
    const result = await actions.load_hotspot(event("L991735"));
    expect(mocks.enqueueJob).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 422,
      data: { verificationRequired: true },
    });
  });

  it("passes force through and preserves a deduped enqueue result", async () => {
    mocks.enqueueJob.mockResolvedValue({ jobId: 91, deduped: true });
    const result = await actions.load_hotspot(event("L234146", new URLSearchParams({ force: "1" })));
    expect(mocks.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ force: true }) }));
    expect(result).toMatchObject({ queued: { jobId: 91, deduped: true } });
  });

  it("keeps monthly GET on stored data without calling the recent eBird provider", async () => {
    mocks.hotspotFromCache.mockResolvedValue({
      locId: "L234146", locName: "The Celery Fields", lat: 27, lng: -82,
      countyCode: "US-FL-115", stateCode: "US-FL", numSpeciesAllTime: 1,
      latestObsDt: null, isHotspot: true,
    });
    mocks.frequencyMeta.mockResolvedValue(new Map([["L234146", {
      locName: "The Celery Fields", beginYear: 2016, endYear: 2025, nSpecies: 1,
      sampleSizes: Array.from({ length: 48 }, () => 1),
    }]]));
    await load({
      locals: owner,
      params: { locId: "L234146" },
      url: new URL("https://birds.test/hotspots/L234146?tab=monthly&month=6"),
    } as never);
    expect(mocks.recentHotspotObs).not.toHaveBeenCalled();
    expect(mocks.hotspotMonthly).toHaveBeenCalled();
  });

  it("checks credentials and ID before any verification work", async () => {
    mocks.getEbirdApiKey.mockResolvedValue(null);
    await actions.load_hotspot(event("Lnot-an-id"));
    expect(mocks.resolveOfficialHotspot).not.toHaveBeenCalled();
    expect(mocks.enqueueJob).not.toHaveBeenCalled();
    await actions.load_hotspot(event());
    expect(mocks.resolveOfficialHotspot).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const { recentHotspotObs, notableObs, hotspotsNear, seenSet } = vi.hoisted(
  () => ({
    recentHotspotObs: vi.fn(),
    notableObs: vi.fn(),
    hotspotsNear: vi.fn(),
    seenSet: vi.fn(),
  }),
);

vi.mock("$server/ebird", () => ({
  EbirdError: class EbirdError extends Error {
    status?: number;
    constructor(message: string, status?: number) {
      super(message);
      this.status = status;
    }
  },
  recentHotspotObs,
  notableObs,
  hotspotsNear,
}));
vi.mock("$server/needs", () => ({ seenSet }));
vi.mock("$server/location-placeids", () => ({
  googlePlaceIdsForLocIds: vi.fn(async () => new Map([["L1", "g1"]])),
}));
vi.mock("$server/trip-count-token", () => ({
  issueTripCountToken: vi.fn(() => "signed-v2"),
}));

import {
  ComparisonError,
  compareHotspotBatch,
  resolveComparison,
} from "./hotspot-comparison";
import {
  __resetEbirdRateForTests,
  comparisonPacer,
  ebirdRateState,
  noteEbirdResponse,
} from "./ebird-rate";

const filters = {
  lat: 30.41,
  lng: -81.42,
  radiusKm: 40,
  daysBack: 30,
  seenStatus: "needs" as const,
  rareOnly: false,
  anchorLabel: "Huguenot",
};
const refs = {
  data: [
    { locId: "L1", locName: "One", lat: 30.41, lng: -81.42 },
    { locId: "L2", locName: "Two", lat: 30.42, lng: -81.43 },
  ],
  fetchedAt: new Date("2026-09-19T12:00:00Z"),
  stale: false,
};
const observation = (speciesCode: string, locId = "L1") => ({
  speciesCode,
  comName: speciesCode,
  sciName: `${speciesCode} scientific`,
  locId,
  locName: "One",
  obsDt: "2026-09-19 12:00",
  lat: 30.41,
  lng: -81.42,
  obsValid: false,
  obsReviewed: false,
  locationPrivate: false,
});

beforeEach(() => {
  vi.clearAllMocks();
  __resetEbirdRateForTests();
  hotspotsNear.mockResolvedValue(refs);
  seenSet.mockResolvedValue(new Set(["seen-bird"]));
  recentHotspotObs.mockResolvedValue({
    data: [
      observation("need-bird"),
      observation("need-bird"),
      observation("seen-bird"),
    ],
    fetchedAt: new Date("2026-09-19T12:00:00Z"),
    stale: false,
  });
  notableObs.mockResolvedValue({
    data: [observation("rare-bird")],
    fetchedAt: new Date("2026-09-19T12:00:00Z"),
    stale: false,
  });
});

describe("hotspot comparison service", () => {
  it("uses each location's own feed, dedupes species, and signs a v2 row", async () => {
    const account = { accountId: 7, scopeOwnerId: 42 };
    const init = await resolveComparison("key", filters, account);
    const result = await compareHotspotBatch(
      "key",
      filters,
      account,
      ["L1"],
      init.value,
    );
    expect(result.rows[0]).toMatchObject({
      locId: "L1",
      count: 1,
      state: "fresh",
      token: "signed-v2",
    });
    expect(result.rows[0].species.map((s) => s.code)).toEqual(["need-bird"]);
    expect(recentHotspotObs).toHaveBeenCalledWith(
      "key",
      "L1",
      30,
      expect.objectContaining({
        pace: expect.any(Function),
        paceSignal: expect.any(AbortSignal),
      }),
    );
  });

  it("uses the separate notable feed and rejects unknown ids before observation fetch", async () => {
    const account = { accountId: 7, scopeOwnerId: 42 };
    const rareFilters = {
      ...filters,
      seenStatus: "all" as const,
      rareOnly: true,
    };
    const init = await resolveComparison("key", rareFilters, account);
    const result = await compareHotspotBatch(
      "key",
      rareFilters,
      account,
      ["L1"],
      init.value,
    );
    expect(result.rows[0].count).toBe(1);
    expect(notableObs).toHaveBeenCalledWith(
      "key",
      "L1",
      30,
      expect.objectContaining({
        pace: expect.any(Function),
        paceSignal: expect.any(AbortSignal),
      }),
    );
    const normalInit = await resolveComparison("key", filters, account);
    await expect(
      compareHotspotBatch("key", filters, account, ["L999"], normalInit.value),
    ).rejects.toBeInstanceOf(ComparisonError);
    expect(recentHotspotObs).not.toHaveBeenCalled();
  });

  it("keeps a stale row visible and stops after a rate-limit refresh failure", async () => {
    recentHotspotObs.mockResolvedValue({
      data: [],
      fetchedAt: new Date("2026-09-18T12:00:00Z"),
      stale: true,
      refreshErrorStatus: 429,
    });
    const account = { accountId: 7, scopeOwnerId: 42 };
    const init = await resolveComparison("key", filters, account);
    const result = await compareHotspotBatch(
      "key",
      filters,
      account,
      ["L1"],
      init.value,
    );
    expect(result.rows[0]).toMatchObject({
      state: "stale",
      count: 0,
      stale: true,
    });
    expect(result.stopScheduling).toBe(true);
    expect(result.stopReason).toBe("rate");
    // Short waits are retried in the request before giving up (td-5003e2).
    expect(recentHotspotObs).toHaveBeenCalledTimes(4);
  });

  it("revalidates reference identity before fetching and reports reference failure", async () => {
    const account = { accountId: 7, scopeOwnerId: 42 };
    const init = await resolveComparison("key", filters, account);
    hotspotsNear.mockResolvedValueOnce({
      ...refs,
      data: [{ ...refs.data[0], locName: "Changed" }],
    });
    await expect(
      compareHotspotBatch("key", filters, account, ["L1"], init.value),
    ).rejects.toMatchObject({ status: 409 });
    expect(recentHotspotObs).not.toHaveBeenCalled();
    hotspotsNear.mockRejectedValueOnce(new Error("reference unavailable"));
    await expect(resolveComparison("key", filters, account)).rejects.toThrow(
      "reference unavailable",
    );
  });

  it("rejects malformed reference and observation evidence", async () => {
    const account = { accountId: 7, scopeOwnerId: 42 };
    hotspotsNear.mockResolvedValueOnce({
      ...refs,
      data: [{ ...refs.data[0], locId: "bad-id" }],
    });
    await expect(
      resolveComparison("key", filters, account),
    ).rejects.toMatchObject({ status: 503 });
    hotspotsNear.mockResolvedValue(refs);
    const init = await resolveComparison("key", filters, account);
    recentHotspotObs.mockResolvedValueOnce({
      data: [{ ...observation("bad"), lat: 190, obsDt: "not-a-date" }],
      fetchedAt: new Date("2026-09-19T12:00:00Z"),
      stale: false,
    });
    const result = await compareHotspotBatch(
      "key",
      filters,
      account,
      ["L1"],
      init.value,
    );
    expect(result.rows[0]).toMatchObject({ state: "failed", count: null });
  });

  it("keeps process-wide observation concurrency at four and honors cancellation", async () => {
    const account = { accountId: 7, scopeOwnerId: 42 };
    const six = Array.from({ length: 6 }, (_, i) => ({
      locId: `L${i + 1}`,
      locName: `P${i + 1}`,
      lat: 30.41 + i / 100,
      lng: -81.42,
    }));
    hotspotsNear.mockResolvedValue({
      data: six,
      fetchedAt: new Date("2026-09-19T12:00:00Z"),
      stale: false,
    });
    let active = 0;
    let peak = 0;
    recentHotspotObs.mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return {
        data: [observation("need-bird")],
        fetchedAt: new Date("2026-09-19T12:00:00Z"),
        stale: false,
      };
    });
    const first = await resolveComparison("key", filters, account);
    const second = await resolveComparison("key", filters, account);
    await Promise.all([
      compareHotspotBatch(
        "key",
        filters,
        account,
        ["L1", "L2", "L3", "L4"],
        first.value,
      ),
      compareHotspotBatch(
        "key",
        filters,
        account,
        ["L3", "L4", "L5", "L6"],
        second.value,
      ),
    ]);
    expect(peak).toBeLessThanOrEqual(4);
    const controller = new AbortController();
    controller.abort();
    await compareHotspotBatch(
      "key",
      filters,
      account,
      ["L1"],
      first.value,
      controller.signal,
    );
    expect(recentHotspotObs).toHaveBeenCalledTimes(8);
  });
});

describe("queued comparison cancellation", () => {
  const account = { accountId: 7, scopeOwnerId: 42 };
  function referenceSet() {
    hotspotsNear.mockResolvedValue({
      ...refs,
      data: Array.from({ length: 6 }, (_, i) => ({
        locId: `L${i + 1}`,
        locName: `Place ${i + 1}`,
        lat: 30.41,
        lng: -81.42,
      })),
    });
  }
  const responseFor = (locId: string) => ({
    data: [observation("need-bird", locId)],
    fetchedAt: new Date("2026-09-19T12:00:00Z"),
    stale: false,
  });

  it("skips a batch aborted while waiting for occupied slots and releases capacity", async () => {
    referenceSet();
    const releases: Array<() => void> = [];
    recentHotspotObs.mockImplementation(async (_key: string, locId: string) => {
      if (releases.length < 4)
        await new Promise<void>((resolve) => releases.push(resolve));
      return responseFor(locId);
    });
    const init = await resolveComparison("key", filters, account);
    const occupying = compareHotspotBatch(
      "key",
      filters,
      account,
      ["L1", "L2", "L3", "L4"],
      init.value,
    );
    await vi.waitFor(() => expect(releases).toHaveLength(4));
    const cancel = new AbortController();
    const queued = compareHotspotBatch(
      "key",
      filters,
      account,
      ["L5", "L6"],
      init.value,
      cancel.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(recentHotspotObs).toHaveBeenCalledTimes(4);
    cancel.abort();
    releases.forEach((release) => release());
    await occupying;
    expect((await queued).rows).toEqual([]);
    expect(recentHotspotObs).toHaveBeenCalledTimes(4);
    expect(
      (await compareHotspotBatch("key", filters, account, ["L5"], init.value))
        .rows,
    ).toHaveLength(1);
    expect(recentHotspotObs).toHaveBeenCalledTimes(5);
  });

  it.each([401, 403])(
    "does not start queued siblings after provider status %s",
    async (status) => {
      referenceSet();
      const { EbirdError } = await import("./ebird");
      const releases: Array<() => void> = [];
      let fail!: () => void;
      recentHotspotObs.mockImplementation(
        async (_key: string, locId: string) => {
          if (["L1", "L2", "L3"].includes(locId))
            await new Promise<void>((resolve) => releases.push(resolve));
          if (locId === "L4")
            await new Promise<void>((_resolve, reject) => {
              fail = () => reject(new EbirdError("Provider stopped", status));
            });
          return responseFor(locId);
        },
      );
      const init = await resolveComparison("key", filters, account);
      const occupying = compareHotspotBatch(
        "key",
        filters,
        account,
        ["L1", "L2", "L3"],
        init.value,
      );
      await vi.waitFor(() => expect(releases).toHaveLength(3));
      const batch = compareHotspotBatch(
        "key",
        filters,
        account,
        ["L4", "L5", "L6"],
        init.value,
      );
      await vi.waitFor(() => expect(fail).toBeTypeOf("function"));
      fail();
      const result = await batch;
      expect(result.stopScheduling).toBe(true);
      expect(result.stopReason).toBe("auth");
      expect(result.rows.map((row) => row.locId)).toEqual(["L4"]);
      expect(result.rows[0].error).toMatch(/Settings/);
      expect(result.rows[0].count).toBeNull();
      expect(recentHotspotObs).toHaveBeenCalledTimes(4);
      releases.forEach((release) => release());
      await occupying;
    },
  );
});

describe("eBird rate limits (td-5003e2)", () => {
  const account = { accountId: 7, scopeOwnerId: 42 };
  const ok = (locId: string) => ({
    data: [observation("need-bird", locId)],
    fetchedAt: new Date("2026-09-19T12:00:00Z"),
    stale: false,
  });
  // What ebirdFetch does on a real 429: record Retry-After for the key.
  function eBird429(retryAfterSec: number, now = Date.now()) {
    noteEbirdResponse(
      "key",
      new Headers({ "retry-after": String(retryAfterSec) }),
      429,
      now,
    );
  }

  it("waits out a short Retry-After and retries the same hotspot instead of stopping", async () => {
    const { EbirdError } = await import("./ebird");
    let calls = 0;
    recentHotspotObs.mockImplementation(
      async (_k: string, locId: string, _b: number, opts: { pace: () => Promise<void> }) => {
        await opts.pace(); // a cache miss: takes a pacing slot
        if (++calls === 1) {
          // Retry-After 1 s, recorded 800 ms ago: ~200 ms left to wait.
          eBird429(1, Date.now() - 800);
          throw new EbirdError("eBird API rate limit hit.", 429, 1000);
        }
        return ok(locId);
      },
    );
    const init = await resolveComparison("key", filters, account);
    const started = Date.now();
    const result = await compareHotspotBatch("key", filters, account, ["L1"], init.value);
    expect(result.stopScheduling).toBe(false);
    expect(result.stopReason).toBeNull();
    expect(result.rows[0]).toMatchObject({ locId: "L1", state: "fresh", count: 1 });
    expect(calls).toBe(2);
    // The pacer held the retry until the key's block expired.
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  });

  it("returns the real remaining wait after the final bounded 429 retry", async () => {
    const { EbirdError } = await import("./ebird");
    recentHotspotObs.mockImplementation(async () => {
      eBird429(10);
      throw new EbirdError("eBird API rate limit hit.", 429, 10_000);
    });
    const init = await resolveComparison("key", filters, account);
    const result = await compareHotspotBatch("key", filters, account, ["L1"], init.value);
    expect(recentHotspotObs).toHaveBeenCalledTimes(4);
    expect(result).toMatchObject({ stopScheduling: true, stopReason: "rate" });
    expect(result.resumeAfterMs).toBeGreaterThan(9_000);
  });

  it("stops with a resume time when eBird asks for a long wait, leaving the hotspot unqueried", async () => {
    const { EbirdError } = await import("./ebird");
    let first = true;
    recentHotspotObs.mockImplementation(
      async (_k: string, _l: string, _b: number, opts: { pace: () => Promise<void> }) => {
        if (first) {
          first = false;
          await opts.pace();
          eBird429(90);
          throw new EbirdError("eBird API rate limit hit.", 429, 90_000);
        }
        // A sibling cache miss: now blocked for 90 s behind the key's block.
        await opts.pace();
        throw new Error("sibling must not get a request out");
      },
    );
    const init = await resolveComparison("key", filters, account);
    const started = Date.now();
    const result = await compareHotspotBatch("key", filters, account, ["L1", "L2"], init.value);
    expect(result.stopReason).toBe("rate");
    expect(result.resumeAfterMs).toBeGreaterThan(80_000);
    // Neither hotspot got an answer, so neither is reported as failed.
    expect(result.rows).toEqual([]);
    // The request returned promptly instead of sitting out the 90 s.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("treats a pacer deferral as a rate stop, not a failed hotspot", async () => {
    const { PaceDeferred } = await import("./ebird-rate");
    recentHotspotObs.mockRejectedValue(new PaceDeferred("rate", 90_000));
    const init = await resolveComparison("key", filters, account);
    const result = await compareHotspotBatch("key", filters, account, ["L1"], init.value);
    expect(result).toMatchObject({
      rows: [],
      stopScheduling: true,
      stopReason: "rate",
      resumeAfterMs: 90_000,
    });
  });

  it("stops before spending the hourly reserve, and reports eBird's remaining count", async () => {
    noteEbirdResponse("key", new Headers({ ratelimit: '"policy";r=40,"burst";r=20' }), 200);
    const init = await resolveComparison("key", filters, account);
    const result = await compareHotspotBatch("key", filters, account, ["L1"], init.value);
    expect(result).toMatchObject({ stopScheduling: true, stopReason: "quota", quotaRemaining: 40 });
    expect(result.rows).toEqual([]);
    expect(recentHotspotObs).not.toHaveBeenCalled();
  });

  it("cache hits never take a pacing slot", async () => {
    const acquire = vi.spyOn(comparisonPacer, "acquire");
    // The default mock is a cache hit: it never calls opts.pace.
    const init = await resolveComparison("key", filters, account);
    await compareHotspotBatch("key", filters, account, ["L1", "L2"], init.value);
    expect(recentHotspotObs).toHaveBeenCalledTimes(2);
    expect(acquire).not.toHaveBeenCalled();
    acquire.mockRestore();
    expect(ebirdRateState("key").blockedUntil).toBe(0);
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetEbirdRateForTests,
  belowHourlyReserve,
  EbirdPacer,
  ebirdRateState,
  noteEbirdResponse,
  PaceAborted,
  PaceDeferred,
  parseRateLimit,
  parseRetryAfter,
} from "./ebird-rate";

// A fake clock: sleep advances it instantly, so pacing is measured, not waited.
function fakeClock(start = 1_000_000) {
  const clock = { t: start, slept: [] as number[] };
  const now = () => clock.t;
  const sleep = async (ms: number, signal?: AbortSignal) => {
    if (signal?.aborted) throw new PaceAborted();
    clock.slept.push(ms);
    clock.t += ms;
  };
  return { clock, now, sleep };
}

beforeEach(() => __resetEbirdRateForTests());

describe("header parsing (formats observed from eBird 2026-09-26)", () => {
  it("reads remaining counts from the ratelimit header", () => {
    expect(parseRateLimit('"policy";r=474,"burst";r=0')).toEqual({ policy: 474, burst: 0 });
    expect(parseRateLimit(null)).toEqual({ policy: null, burst: null });
  });
  it("reads Retry-After as seconds or an HTTP date", () => {
    expect(parseRetryAfter("1")).toBe(1000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6_000);
    expect(parseRetryAfter("soon")).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });
});

describe("per-key state", () => {
  it("a 429 blocks the key for Retry-After, or the measured 5 s burst window when absent", () => {
    noteEbirdResponse("k", new Headers({ "retry-after": "3" }), 429, 50_000);
    expect(ebirdRateState("k").blockedUntil).toBe(53_000);
    noteEbirdResponse("k2", new Headers(), 429, 50_000);
    expect(ebirdRateState("k2").blockedUntil).toBe(55_000);
    // Other keys are unaffected.
    expect(ebirdRateState("k3").blockedUntil).toBe(0);
  });
  it("trusts a low hourly count only while it is recent", () => {
    noteEbirdResponse("k", new Headers({ ratelimit: '"policy";r=40,"burst";r=9' }), 200, 1_000);
    expect(belowHourlyReserve("k", 30_000)).toBe(40);
    expect(belowHourlyReserve("k", 1_000 + 61_000)).toBeNull();
    noteEbirdResponse("k", new Headers({ ratelimit: '"policy";r=300,"burst";r=9' }), 200, 70_000);
    expect(belowHourlyReserve("k", 70_000)).toBeNull();
  });
  it("stops at the reserve boundary before another request spends it", () => {
    noteEbirdResponse("k", new Headers({ ratelimit: '"policy";r=100,"burst";r=9' }), 200, 1_000);
    expect(belowHourlyReserve("k", 1_000)).toBe(100);
  });
});

describe("EbirdPacer", () => {
  it("allows the burst back to back, then spaces requests at the rate", async () => {
    const { clock, now, sleep } = fakeClock();
    const pacer = new EbirdPacer({ ratePerSec: 3, burst: 6, now, sleep });
    const start = clock.t;
    const times: number[] = [];
    for (let i = 0; i < 12; i++) {
      await pacer.acquire("k");
      times.push(clock.t - start);
    }
    expect(times.slice(0, 6)).toEqual([0, 0, 0, 0, 0, 0]);
    // Then one every ~333 ms.
    expect(times[11]).toBeGreaterThanOrEqual(1990);
    expect(times[11]).toBeLessThanOrEqual(2010);
    // Never more than eBird's 25 in any 5 s window.
    for (let i = 0; i < times.length; i++)
      expect(times.filter((t) => t >= times[i] && t < times[i] + 5000).length).toBeLessThanOrEqual(25);
  });

  it("is shared: two concurrent runs on one key draw from one bucket", async () => {
    const { clock, now, sleep } = fakeClock();
    const pacer = new EbirdPacer({ ratePerSec: 3, burst: 6, now, sleep });
    const start = clock.t;
    const run = async () => {
      for (let i = 0; i < 6; i++) await pacer.acquire("k");
    };
    await Promise.all([run(), run()]);
    // 12 requests: 6 burst + 6 paced, the same as one run of 12, not two bursts.
    expect(clock.t - start).toBeGreaterThanOrEqual(1990);
  });

  it("keys are paced independently", async () => {
    const { clock, now, sleep } = fakeClock();
    const pacer = new EbirdPacer({ ratePerSec: 3, burst: 2, now, sleep });
    await pacer.acquire("a");
    await pacer.acquire("a");
    await pacer.acquire("b");
    await pacer.acquire("b");
    expect(clock.slept).toEqual([]);
  });

  it("waits out a Retry-After block before the next request", async () => {
    const { clock, now, sleep } = fakeClock(100_000);
    const pacer = new EbirdPacer({ ratePerSec: 3, burst: 6, now, sleep });
    noteEbirdResponse("k", new Headers({ "retry-after": "2" }), 429, 100_000);
    await pacer.acquire("k");
    expect(clock.t).toBe(102_000);
  });

  it("defers a Retry-After longer than the caller's request budget without sleeping", async () => {
    const { clock, now, sleep } = fakeClock(100_000);
    const pacer = new EbirdPacer({ ratePerSec: 3, burst: 6, now, sleep });
    noteEbirdResponse("k", new Headers({ "retry-after": "90" }), 429, clock.t);
    await expect(
      pacer.acquire("k", undefined, { maxBlockMs: 15_000 }),
    ).rejects.toMatchObject({
      reason: "rate",
      retryAfterMs: 90_000,
    } satisfies Partial<PaceDeferred>);
    expect(clock.slept).toEqual([]);
  });

  it("defers before spending the trusted hourly reserve", async () => {
    const { clock, now, sleep } = fakeClock(100_000);
    const pacer = new EbirdPacer({ ratePerSec: 3, burst: 6, now, sleep });
    noteEbirdResponse(
      "k",
      new Headers({ ratelimit: '"policy";r=100,"burst";r=9' }),
      200,
      clock.t,
    );
    await expect(
      pacer.acquire("k", undefined, { preserveHourlyReserve: true }),
    ).rejects.toMatchObject({
      reason: "quota",
      quotaRemaining: 100,
    } satisfies Partial<PaceDeferred>);
  });

  it("a cancelled waiter rejects and does not stall the queue behind it", async () => {
    const { now, sleep } = fakeClock();
    const pacer = new EbirdPacer({ ratePerSec: 3, burst: 1, now, sleep });
    await pacer.acquire("k");
    const c = new AbortController();
    c.abort();
    await expect(pacer.acquire("k", c.signal)).rejects.toBeInstanceOf(PaceAborted);
    await expect(pacer.acquire("k")).resolves.toBeUndefined();
  });
});

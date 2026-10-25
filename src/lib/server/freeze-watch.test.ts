import { afterEach, describe, expect, it } from "vitest";
import { describeFreeze } from "$lib/freeze-text";
import {
  FREEZE_MIN_MS,
  FreezeWatch,
  IN_FLIGHT_MAX_AGE_MS,
  MAX_FREEZES_PER_HOUR,
  MAX_LISTED,
  SWEEP_EVERY_MS,
  TICK_MS,
  addGcPause,
  freezeWatchTestState,
  gcBetween,
  requestStarted,
  trackBusy,
  type FreezeRecord,
} from "$server/freeze-watch";

/** A wall clock and a monotonic clock that move together, except on a correction. */
function clock(start = 1_800_000_000_000) {
  let wall = start;
  let mono = 1_000_000;
  return {
    now: () => wall,
    mono: () => mono,
    advance: (ms: number) => {
      wall += ms;
      mono += ms;
    },
    jump: (ms: number) => void (wall += ms),
  };
}

function setup() {
  const c = clock();
  const state = freezeWatchTestState(c.mono);
  const records: FreezeRecord[] = [];
  const w = new FreezeWatch({
    now: c.now,
    mono: c.mono,
    memory: () => ({ rss: 400 * 1_048_576, heapUsed: 160 * 1_048_576 }),
    record: (f) => records.push(f),
    version: "testver",
  });
  /** On-time ticks for `ms`. */
  const run = (ms: number) => {
    for (let left = ms; left > 0; left -= TICK_MS) {
      c.advance(TICK_MS);
      w.tick();
    }
  };
  return { c, w, records, run, state };
}

describe("freeze watch (td-b07462)", () => {
  afterEach(() => freezeWatchTestState());

  it("records nothing while the timer fires on time, or late by less than FREEZE_MIN_MS", () => {
    const { c, w, records, run } = setup();
    run(5_000);
    c.advance(TICK_MS + FREEZE_MIN_MS - 1);
    w.tick();
    run(500);
    expect(records).toEqual([]);
  });

  it("ignores a wall-clock correction (lateness is on the monotonic clock)", () => {
    const { c, w, records, run } = setup();
    c.jump(60_000);
    run(200);
    c.jump(-30_000);
    run(200);
    expect(records).toEqual([]);
    void w;
  });

  it("writes a freeze one tick after noticing it, with what ran: operations and requests that ended the moment it ended still count", async () => {
    const { c, w, records, run } = setup();
    run(1_000);
    const t0 = c.mono();
    const endOld = requestStarted("/api/hub-search", "GET");
    c.advance(50);
    // The blocking loop: a named rebuild whose synchronous work holds the thread, then ends,
    // and its request completes, all before the overdue timer gets to run.
    let finishRebuild!: () => void;
    const rebuild = trackBusy("hotspot search index rebuild", () => new Promise<void>((r) => (finishRebuild = r)));
    c.advance(12_000);
    finishRebuild();
    await rebuild;
    endOld();
    requestStarted("/forecast/data", "GET"); // accepted right after, before the timer
    c.advance(TICK_MS);
    w.tick();
    expect(records).toEqual([]); // noticed, not yet written
    c.advance(TICK_MS);
    w.tick();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      durationMs: 12_050,
      runningBefore: 1,
      runningList: [{ route: "/api/hub-search", method: "GET", ranBeforeMs: TICK_MS }], // started at the last on-time tick
      arrivedDuring: 1,
      busy: ["hotspot search index rebuild"],
      rssMb: 400,
      heapMb: 160,
      version: "testver",
    });
    expect(records[0].startedAt).toBe(c.now() - TICK_MS - 12_050);
    void t0;
  });

  it("counts every request already running, lists the oldest MAX_LISTED, and says how many more", () => {
    const { c, w, records, run } = setup();
    for (let i = 0; i < MAX_LISTED + 5; i++) {
      requestStarted(`/r${i}`, "GET");
      c.advance(10);
    }
    run(100);
    c.advance(TICK_MS + 2_000);
    w.tick();
    c.advance(TICK_MS);
    w.tick();
    const f = records[0];
    expect(f).toMatchObject({ runningBefore: MAX_LISTED + 5, arrivedDuring: 0 });
    expect(f.runningList.map((r) => r.route)).toEqual(Array.from({ length: MAX_LISTED }, (_, i) => `/r${i}`));
    expect(describeFreeze(f)).toBe(
      `15 requests were already running when it began: ${f.runningList.map((r) => r.route).join(", ")} and 5 more.`,
    );
  });

  it("sweeps abandoned requests on ordinary ticks (a body replaced by a 304 is never read)", () => {
    const { run, state } = setup();
    for (let i = 0; i < 100; i++) requestStarted("/species/[code]", "GET");
    expect(state.activeCount()).toBe(100);
    run(IN_FLIGHT_MAX_AGE_MS + SWEEP_EVERY_MS);
    expect(state.activeCount()).toBe(0);
  });

  it("keeps every GC pause inside a long freeze (no fixed-size buffer)", () => {
    const { c, w, records, run } = setup();
    run(200);
    const from = c.mono() + TICK_MS;
    for (let i = 0; i < 600; i++) addGcPause(from + i * 2, 1.9); // 600 pauses, 1,140 ms in all
    addGcPause(from - 500, 300); // before it
    c.advance(TICK_MS + 1_250);
    w.tick();
    c.advance(TICK_MS);
    w.tick();
    expect(records[0].gcMs).toBe(1_140);
    expect(gcBetween(from - 500, from - 200)).toBeCloseTo(300, 5);
  });

  it("records at most MAX_FREEZES_PER_HOUR an hour", () => {
    const { c, w, records } = setup();
    for (let i = 0; i < MAX_FREEZES_PER_HOUR + 5; i++) {
      c.advance(TICK_MS + FREEZE_MIN_MS);
      w.tick();
    }
    c.advance(TICK_MS);
    w.tick();
    expect(records.length).toBeLessThanOrEqual(MAX_FREEZES_PER_HOUR);
    expect(records.length).toBeGreaterThan(MAX_FREEZES_PER_HOUR - 30);
  });

  it("ends a busy mark when its work throws", async () => {
    const { state } = setup();
    await expect(trackBusy("x", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(state.activeCount()).toBe(0);
  });
});

describe("describeFreeze", () => {
  it("names operations, says who was running and who arrived, and never assigns a cause", () => {
    expect(
      describeFreeze({
        busy: ["hotspot search index rebuild"],
        runningList: [
          { route: "/api/hub-search", method: "GET" },
          { route: "/api/hub-search", method: "GET" },
          { route: "/admin", method: "POST" },
        ],
        runningBefore: 3,
        arrivedDuring: 2,
      }),
    ).toBe(
      "Running: hotspot search index rebuild. 3 requests were already running when it began: /api/hub-search, POST /admin. 2 more started while it lasted.",
    );
    expect(describeFreeze({ busy: [], runningList: [], runningBefore: 0, arrivedDuring: 0 })).toBe("No request was running when it began.");
  });
});

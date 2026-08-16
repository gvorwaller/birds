/**
 * Handler dispatch + termination-path tests. ensureFrequencies and the queue
 * primitives are mocked; what's pinned here is the CONTRACT between them:
 * one termination path per cause (GROK #6), jobOutcome wiring, payload
 * validation, and the compact no-secrets result summary.
 * Unit-level fetch behavior lives in barchart.test.ts; outcome policy in
 * job-policy.test.ts; real SQL in jobs-db.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  return {
    ensureFrequencies: vi.fn<(userId: number, locs: any[], opts: any) => Promise<any>>(),
    recordEvent: vi.fn<(jobId: number, action: string, details?: unknown) => Promise<void>>(
      async () => {},
    ),
    updateProgress: vi.fn<(jobId: number, progress: any) => Promise<{ cancelRequested: boolean }>>(
      async () => ({ cancelRequested: false }),
    ),
    completeJob: vi.fn<(jobId: number, attempts: number, result?: unknown) => Promise<boolean>>(
      async () => true,
    ),
    failJob: vi.fn<
      (jobId: number, attempts: number, error: string, result?: unknown) => Promise<boolean>
    >(async () => true),
    cancelRunningJob: vi.fn<
      (jobId: number, attempts: number, result?: unknown) => Promise<boolean>
    >(async () => true),
    scheduleRetry: vi.fn<
      (
        jobId: number,
        attempts: number,
        delayMs: number,
        reason: string,
        result?: unknown,
      ) => Promise<boolean>
    >(async () => true),
    requeueInterrupted: vi.fn<(jobId: number, attempts: number) => Promise<boolean>>(
      async () => true,
    ),
    frequencyMeta: vi.fn<(codes: string[]) => Promise<Map<string, { endYear: number }>>>(
      async () => new Map(),
    ),
    attemptMeta: vi.fn<(codes: string[]) => Promise<Map<string, unknown>>>(async () => new Map()),
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
});

vi.mock("$server/barchart", () => ({
  ensureFrequencies: mocks.ensureFrequencies,
  frequencyMeta: mocks.frequencyMeta,
  attemptMeta: mocks.attemptMeta,
  lastCompleteYear: () => 2025,
  HOTSPOT_FAILURE_COOLDOWN_MS: 15 * 60_000,
}));

vi.mock("$server/jobs", () => ({
  recordEvent: mocks.recordEvent,
  updateProgress: mocks.updateProgress,
  completeJob: mocks.completeJob,
  failJob: mocks.failJob,
  cancelRunningJob: mocks.cancelRunningJob,
  scheduleRetry: mocks.scheduleRetry,
  requeueInterrupted: mocks.requeueInterrupted,
}));

vi.mock("$lib/db", () => ({
  query: vi.fn(async () => ({ rows: [] })),
  withTransaction: vi.fn(),
}));

const { runJob } = await import("./job-handlers");
const { RATE_LIMIT_RETRY_DELAY_MS, TRANSIENT_RETRY_DELAYS_MS } = await import(
  "./job-policy"
);

type Loc = { code: string; kind: "region" | "hotspot"; name: string; regionCode: string | null };

const LOCS: Loc[] = [
  { code: "L1", kind: "hotspot", name: "Marsh One", regionCode: "US-FL-057" },
  { code: "L2", kind: "hotspot", name: "Marsh Two", regionCode: "US-FL-057" },
  { code: "L3", kind: "hotspot", name: "Marsh Three", regionCode: "US-FL-057" },
];

function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    type: "load_hotspots",
    status: "running",
    payload: { locs: LOCS },
    label: "3 hotspots",
    attempts: 1,
    max_attempts: 4,
    next_retry_at: null,
    cancel_requested: false,
    progress: {},
    result: null,
    error: null,
    requested_by: 7,
    enqueued_at: new Date(),
    started_at: new Date(),
    finished_at: null,
    heartbeat_at: null,
    ...overrides,
  } as Parameters<typeof runJob>[0];
}

function ensureResult(overrides: Record<string, unknown> = {}) {
  return {
    ready: [],
    refreshed: [],
    failed: [],
    notAttempted: [],
    credentialProblem: null,
    rateLimited: false,
    ...overrides,
  };
}

const ctx = { isDraining: () => false };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updateProgress.mockResolvedValue({ cancelRequested: false });
});

describe("runJob — frequency jobs", () => {
  it("happy path: per-unit events + progress, then completeJob with a compact summary", async () => {
    mocks.ensureFrequencies.mockImplementation(async (_u, locs, opts) => {
      for (const loc of locs) await opts.onUnit(loc, { status: "ok" });
      return ensureResult({ refreshed: locs.map((l: Loc) => l.code) });
    });
    await runJob(jobRow(), ctx);

    // ensure invoked with the payload locs, unclamped, force=false.
    const [userId, locs, opts] = mocks.ensureFrequencies.mock.calls[0];
    expect(userId).toBe(7);
    expect(locs).toEqual(LOCS);
    expect(opts.maxFetches).toBe(Infinity);
    expect(opts.timeBudgetMs).toBe(Infinity);
    expect(opts.force).toBe(false);

    const actions = mocks.recordEvent.mock.calls.map((c) => c[1]);
    expect(actions).toEqual(["claimed", "unit_ok", "unit_ok", "unit_ok"]);
    expect(mocks.completeJob).toHaveBeenCalledTimes(1);
    const [jobId, attempts, summary] = mocks.completeJob.mock.calls[0];
    expect(jobId).toBe(42);
    expect(attempts).toBe(1);
    // Compact counts, not row dumps — and nothing credential-shaped.
    expect(summary).toEqual({
      ready: 0,
      refreshed: 3,
      failed: [],
      notAttempted: 0,
      credentialProblem: null,
      rateLimited: false,
    });
    expect(mocks.failJob).not.toHaveBeenCalled();
    expect(mocks.scheduleRetry).not.toHaveBeenCalled();
  });

  it("credential problem → terminal failJob, never a retry", async () => {
    mocks.ensureFrequencies.mockResolvedValue(
      ensureResult({
        credentialProblem: "eBird rejected the stored sign-in.",
        notAttempted: ["L2", "L3"],
      }),
    );
    await runJob(jobRow(), ctx);
    expect(mocks.failJob).toHaveBeenCalledTimes(1);
    expect(mocks.failJob.mock.calls[0][2]).toMatch(/rejected/);
    expect(mocks.scheduleRetry).not.toHaveBeenCalled();
  });

  it("429 rate limit → scheduleRetry with the flat 30-minute delay", async () => {
    mocks.ensureFrequencies.mockResolvedValue(
      ensureResult({ rateLimited: true, notAttempted: ["L2", "L3"] }),
    );
    await runJob(jobRow(), ctx);
    expect(mocks.scheduleRetry).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleRetry.mock.calls[0][2]).toBe(RATE_LIMIT_RETRY_DELAY_MS);
  });

  it("transient remainder → scheduleRetry per the transient schedule", async () => {
    mocks.ensureFrequencies.mockResolvedValue(
      ensureResult({
        refreshed: ["L1"],
        failed: [{ code: "L2", error: "HTTP 500", kind: "transient" }],
      }),
    );
    await runJob(jobRow({ attempts: 2 }), ctx);
    expect(mocks.scheduleRetry).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleRetry.mock.calls[0][2]).toBe(TRANSIENT_RETRY_DELAYS_MS[1]);
  });

  it("cancellation mid-job → cancelRunningJob ONLY (no complete/retry/fail)", async () => {
    mocks.updateProgress.mockResolvedValue({ cancelRequested: true });
    mocks.ensureFrequencies.mockImplementation(async (_u, locs, opts) => {
      await opts.onUnit(locs[0], { status: "ok" });
      const stop = await opts.shouldStop();
      expect(stop).toBe("cancel");
      return ensureResult({
        refreshed: ["L1"],
        notAttempted: ["L2", "L3"],
      });
    });
    await runJob(jobRow(), ctx);
    expect(mocks.cancelRunningJob).toHaveBeenCalledTimes(1);
    expect(mocks.completeJob).not.toHaveBeenCalled();
    expect(mocks.scheduleRetry).not.toHaveBeenCalled();
    expect(mocks.failJob).not.toHaveBeenCalled();
  });

  it("cancel observed by the LAST unit (no later shouldStop) still cancels, never completes", async () => {
    // The final onUnit's progress write reports cancel_requested, but the
    // loop ends without another shouldStop call — the post-ensure re-check
    // must resolve it (CODEX1 re-review #2).
    mocks.updateProgress.mockResolvedValue({ cancelRequested: true });
    mocks.ensureFrequencies.mockImplementation(async (_u, locs, opts) => {
      for (const loc of locs) await opts.onUnit(loc, { status: "ok" });
      return ensureResult({ refreshed: locs.map((l: Loc) => l.code) });
    });
    await runJob(jobRow(), ctx);
    expect(mocks.cancelRunningJob).toHaveBeenCalledTimes(1);
    expect(mocks.completeJob).not.toHaveBeenCalled();
    expect(mocks.scheduleRetry).not.toHaveBeenCalled();
    expect(mocks.failJob).not.toHaveBeenCalled();
  });

  it("transient failures at the FINAL attempt → terminal failJob, not success", async () => {
    mocks.ensureFrequencies.mockResolvedValue(
      ensureResult({
        refreshed: ["L1"],
        failed: [{ code: "L2", error: "HTTP 500", kind: "transient" }],
      }),
    );
    await runJob(jobRow({ attempts: 4 }), ctx);
    expect(mocks.failJob).toHaveBeenCalledTimes(1);
    expect(mocks.failJob.mock.calls[0][2]).toMatch(/after 4 attempts/);
    expect(mocks.completeJob).not.toHaveBeenCalled();
    expect(mocks.scheduleRetry).not.toHaveBeenCalled();
  });

  it("drain (SIGTERM) mid-job → requeueInterrupted ONLY", async () => {
    const draining = { isDraining: () => true };
    mocks.ensureFrequencies.mockImplementation(async (_u, locs, opts) => {
      const stop = await opts.shouldStop();
      expect(stop).toBe("drain");
      return ensureResult({ notAttempted: locs.map((l: Loc) => l.code) });
    });
    await runJob(jobRow(), draining);
    expect(mocks.requeueInterrupted).toHaveBeenCalledWith(42, 1);
    expect(mocks.completeJob).not.toHaveBeenCalled();
    expect(mocks.scheduleRetry).not.toHaveBeenCalled();
    expect(mocks.failJob).not.toHaveBeenCalled();
  });

  it("unit failures are recorded as events AND in progress counters", async () => {
    mocks.ensureFrequencies.mockImplementation(async (_u, locs, opts) => {
      await opts.onUnit(locs[0], { status: "ok" });
      await opts.onUnit(locs[1], {
        status: "failed",
        kind: "unit",
        error: "export returned garbage",
      });
      await opts.onUnit(locs[2], { status: "skipped", kind: "cooldown" });
      return ensureResult({ refreshed: ["L1"] });
    });
    await runJob(jobRow(), ctx);
    const actions = mocks.recordEvent.mock.calls.map((c) => c[1]);
    expect(actions).toEqual(["claimed", "unit_ok", "unit_failed", "unit_skipped"]);
    const lastProgress =
      mocks.updateProgress.mock.calls[mocks.updateProgress.mock.calls.length - 1][1];
    expect(lastProgress).toMatchObject({
      unitsDone: 1,
      unitsFailed: 1,
      unitsSkipped: 1,
      unitsTotal: 3,
    });
  });

  it("progress-write failures never sink the job (CODEX1 #6)", async () => {
    mocks.updateProgress
      .mockResolvedValueOnce({ cancelRequested: false }) // initial write
      .mockRejectedValueOnce(new Error("db blip"))
      .mockResolvedValue({ cancelRequested: false });
    mocks.ensureFrequencies.mockImplementation(async (_u, locs, opts) => {
      for (const loc of locs) await opts.onUnit(loc, { status: "ok" });
      return ensureResult({ refreshed: locs.map((l: Loc) => l.code) });
    });
    await runJob(jobRow(), ctx);
    expect(mocks.completeJob).toHaveBeenCalledTimes(1);
  });

  it("malformed payload → failJob with the validation message", async () => {
    await runJob(jobRow({ payload: { locs: [] } }), ctx);
    expect(mocks.failJob).toHaveBeenCalledTimes(1);
    expect(mocks.failJob.mock.calls[0][2]).toMatch(/no locs/);
    expect(mocks.ensureFrequencies).not.toHaveBeenCalled();
  });
});

describe("runJob — analyze_counties", () => {
  const COUNTIES = [
    { code: "US-ME-001", name: "Androscoggin" },
    { code: "US-ME-003", name: "Aroostook" },
  ];

  it("all counties already current → completes immediately without fetching", async () => {
    mocks.frequencyMeta.mockResolvedValue(
      new Map(COUNTIES.map((c) => [c.code, { endYear: 2025 }])),
    );
    await runJob(
      jobRow({
        type: "analyze_counties",
        payload: { regionCode: "US-ME", regionName: "Maine", counties: COUNTIES },
      }),
      ctx,
    );
    expect(mocks.completeJob).toHaveBeenCalledTimes(1);
    expect(mocks.ensureFrequencies).not.toHaveBeenCalled();
  });

  it("non-current counties become the ensure target set from the SNAPSHOT (CODEX1 #1)", async () => {
    mocks.frequencyMeta.mockResolvedValue(
      new Map([["US-ME-001", { endYear: 2025 }]]),
    );
    mocks.ensureFrequencies.mockResolvedValue(
      ensureResult({ refreshed: ["US-ME-003"] }),
    );
    await runJob(
      jobRow({
        type: "analyze_counties",
        payload: { regionCode: "US-ME", regionName: "Maine", counties: COUNTIES },
      }),
      ctx,
    );
    const [, locs] = mocks.ensureFrequencies.mock.calls[0];
    expect(locs).toEqual([
      { code: "US-ME-003", kind: "region", name: "Aroostook", regionCode: "US-ME" },
    ]);
  });

  it("payload without resolved counties → failJob (worker never re-derives targets)", async () => {
    await runJob(
      jobRow({
        type: "analyze_counties",
        payload: { regionCode: "US-ME", regionName: "Maine" },
      }),
      ctx,
    );
    expect(mocks.failJob).toHaveBeenCalledTimes(1);
    expect(mocks.failJob.mock.calls[0][2]).toMatch(/resolved counties/);
  });
});

describe("runJob — dispatch", () => {
  it("Phase-3 types fail cleanly until their handlers land", async () => {
    await runJob(jobRow({ type: "sync_lifelist" }), ctx);
    expect(mocks.failJob).toHaveBeenCalledTimes(1);
    expect(mocks.failJob.mock.calls[0][2]).toMatch(/no handler/);
  });
});

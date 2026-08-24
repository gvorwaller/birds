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
    yieldRemainder: vi.fn<
      (
        jobId: number,
        attempts: number,
        newPayload: unknown | null,
        chunkSummary: unknown,
      ) => Promise<boolean>
    >(async () => true),
    enqueueJob: vi.fn<(...a: unknown[]) => Promise<{ jobId: number; deduped: boolean }>>(
      async () => ({ jobId: 999, deduped: false }),
    ),
    hasActiveJob: vi.fn<(k: string) => Promise<boolean>>(async () => false),
    terminalizeAndReschedule: vi.fn<
      (
        ...a: unknown[]
      ) => Promise<{ won: boolean; finalStatus: string | null; successorId: number | null }>
    >(async () => ({ won: true, finalStatus: "succeeded", successorId: 1000 })),
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
  BATCH_TIME_BUDGET_MS: 240_000,
}));

vi.mock("$server/jobs", () => ({
  recordEvent: mocks.recordEvent,
  updateProgress: mocks.updateProgress,
  completeJob: mocks.completeJob,
  failJob: mocks.failJob,
  cancelRunningJob: mocks.cancelRunningJob,
  scheduleRetry: mocks.scheduleRetry,
  requeueInterrupted: mocks.requeueInterrupted,
  yieldRemainder: mocks.yieldRemainder,
  enqueueJob: mocks.enqueueJob,
  hasActiveJob: mocks.hasActiveJob,
  terminalizeAndReschedule: mocks.terminalizeAndReschedule,
}));

const db = vi.hoisted(() => {
  const state = {
    handler: null as null | ((text: string, params?: unknown[]) => { rows: unknown[] } | undefined),
    calls: [] as { text: string; params: unknown[] }[],
    /** When true, queryTimed stalls to its timeout then rejects — the
     * pool-stall shape, honoring the real contract. */
    stallTimedWrites: false,
    timedTimeouts: [] as number[],
  };
  return state;
});

vi.mock("$lib/db", () => ({
  query: vi.fn(async (text: string, params?: unknown[]) => {
    db.calls.push({ text, params: params ?? [] });
    return db.handler?.(text, params) ?? { rows: [] };
  }),
  queryTimed: vi.fn((text: string, params: unknown[] | undefined, timeoutMs: number) => {
    db.calls.push({ text, params: params ?? [] });
    db.timedTimeouts.push(timeoutMs);
    if (db.stallTimedWrites) {
      return new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`queryTimed: timeout after ${timeoutMs}ms`)), timeoutMs);
      });
    }
    return Promise.resolve(db.handler?.(text, params) ?? { rows: [] });
  }),
  withTransaction: vi.fn(),
}));

const syncMocks = vi.hoisted(() => {
  // Real classes with the real shapes — the handler's instanceof/status
  // classification must be exercised with typed errors, not generic Error
  // (CODEX1 Phase-3).
  class FakeEbirdLoginError extends Error {}
  class FakeEbirdUpstreamError extends Error {
    constructor(
      message: string,
      public status: number,
    ) {
      super(message);
    }
  }
  class FakeEbirdError extends Error {
    constructor(
      message: string,
      public status?: number,
    ) {
      super(message);
    }
  }
  return {
    FakeEbirdLoginError,
    FakeEbirdUpstreamError,
    FakeEbirdError,
    syncLifeListFromEbird: vi.fn<(userId: number) => Promise<{ total: number; matched: number; unmatched: string[] }>>(),
    getEbirdApiKey: vi.fn<(userId: number) => Promise<string | null>>(async () => "key"),
    syncTaxonomy: vi.fn<(apiKey: string) => Promise<number>>(async () => 42),
    rematchPhotoLinks: vi.fn<() => Promise<{ matched: number; unmatched: number }>>(
      async () => ({ matched: 5, unmatched: 1 }),
    ),
    notableNearbyObs: vi.fn<
      (...a: unknown[]) => Promise<{ data: unknown[]; fetchedAt: Date; stale: boolean }>
    >(async () => ({ data: [], fetchedAt: new Date(), stale: false })),
    seenSet: vi.fn<(userId: number) => Promise<Set<string>>>(async () => new Set()),
    sendWebPush: vi.fn<(...a: unknown[]) => Promise<void>>(async () => {}),
  };
});

vi.mock("$server/ebird-account", () => ({
  EbirdLoginError: syncMocks.FakeEbirdLoginError,
  EbirdUpstreamError: syncMocks.FakeEbirdUpstreamError,
  syncLifeListFromEbird: syncMocks.syncLifeListFromEbird,
}));
vi.mock("$server/ebird", () => ({
  EbirdError: syncMocks.FakeEbirdError,
  getEbirdApiKey: syncMocks.getEbirdApiKey,
  syncTaxonomy: syncMocks.syncTaxonomy,
  notableNearbyObs: syncMocks.notableNearbyObs,
}));
vi.mock("$server/gallery", () => ({
  rematchPhotoLinks: syncMocks.rematchPhotoLinks,
}));
vi.mock("$server/needs", () => ({
  seenSet: syncMocks.seenSet,
}));
const pushMocks = vi.hoisted(() => {
  class FakePushError extends Error {
    constructor(
      message: string,
      public status: number,
      public gone: boolean,
    ) {
      super(message);
    }
  }
  return { FakePushError };
});
vi.mock("$server/push", () => ({
  sendWebPush: syncMocks.sendWebPush,
  PushError: pushMocks.FakePushError,
  vapidPublicKey: () => "test-vapid-pub",
}));
const enrichMocks = vi.hoisted(() => ({
  fetchWikidataBatch: vi.fn<(codes: readonly string[]) => Promise<Map<string, unknown>>>(),
  fetchWikidataBySciName: vi.fn<
    (pairs: readonly { code: string; sciName: string }[]) => Promise<Map<string, unknown>>
  >(async () => new Map()),
  fetchArticlePlaintext: vi.fn<(title: string) => Promise<unknown>>(),
  generateSpeciesAnnotation: vi.fn<(input: unknown) => Promise<unknown>>(),
  fetchWikidataMedia: vi.fn<(qids: readonly string[]) => Promise<Map<string, unknown>>>(),
  fetchCommonsFileInfo: vi.fn<(filenames: readonly string[]) => Promise<Map<string, unknown>>>(),
  fetchXenoCantoRecordings: vi.fn<
    (sciName: string) => Promise<{
      song: unknown;
      call: unknown;
      downloadsRestricted: boolean;
    }>
  >(),
}));

vi.mock("$server/wikidata", async (importOriginal) => {
  const real = await importOriginal<typeof import("./wikidata")>();
  return {
    ...real,
    fetchWikidataBatch: enrichMocks.fetchWikidataBatch,
    fetchWikidataBySciName: enrichMocks.fetchWikidataBySciName,
    fetchWikidataMedia: enrichMocks.fetchWikidataMedia,
  };
});
vi.mock("$server/wikipedia", async (importOriginal) => {
  const real = await importOriginal<typeof import("./wikipedia")>();
  return { ...real, fetchArticlePlaintext: enrichMocks.fetchArticlePlaintext };
});
vi.mock("$server/ai-enrichment", async (importOriginal) => {
  const real = await importOriginal<typeof import("./ai-enrichment")>();
  return { ...real, generateSpeciesAnnotation: enrichMocks.generateSpeciesAnnotation };
});
vi.mock("$server/wikimedia-commons", async (importOriginal) => {
  const real = await importOriginal<typeof import("./wikimedia-commons")>();
  return { ...real, fetchCommonsFileInfo: enrichMocks.fetchCommonsFileInfo };
});
vi.mock("$server/xeno-canto", async (importOriginal) => {
  const real = await importOriginal<typeof import("./xeno-canto")>();
  return { ...real, fetchXenoCantoRecordings: enrichMocks.fetchXenoCantoRecordings };
});

vi.mock("$server/crypto", () => ({
  decryptSecret: (v: string) => v.replace(/^enc-/, ""),
  encryptSecret: (v: string) => `enc-${v}`,
}));

const {
  runJob,
  ensureNeedAlertScan,
  nudgeEnrichmentScan,
  ENRICH_SCAN_DRAIN_MS,
  ENRICH_SCAN_IDLE_MS,
} = await import("./job-handlers");
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
  db.handler = null;
  db.calls.length = 0;
  db.stallTimedWrites = false;
  db.timedTimeouts.length = 0;
  // clearAllMocks resets CALLS, not implementations — persistent
  // mockRejectedValue/mockResolvedValue set by one test must not leak into
  // the next (bit the budget suite: a prior test's rejecting sendWebPush
  // failed an unrelated user).
  syncMocks.sendWebPush.mockReset();
  syncMocks.sendWebPush.mockImplementation(async () => {});
  syncMocks.notableNearbyObs.mockReset();
  syncMocks.notableNearbyObs.mockImplementation(async () => ({
    data: [],
    fetchedAt: new Date(),
    stale: false,
  }));
  syncMocks.seenSet.mockReset();
  syncMocks.seenSet.mockImplementation(async () => new Set());
  syncMocks.getEbirdApiKey.mockReset();
  syncMocks.getEbirdApiKey.mockImplementation(async () => "key");
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

describe("runJob — budget yield (CODEX1 P1 on 2171eb7: queue fairness)", () => {
  // The mocked BATCH_TIME_BUDGET_MS is 240_000; each test drives Date.now
  // past it mid-ensure with fake timers, exactly how a long chunk trips the
  // boundary between units in production.
  it("load_hotspots past budget → yieldRemainder with narrowed payload + cumulative base; no completion/retry", async () => {
    vi.useFakeTimers();
    try {
      const t0 = Date.now();
      mocks.ensureFrequencies.mockImplementation(async (_u, locs, opts) => {
        // First unit lands, then the clock passes the chunk boundary.
        await opts.onUnit(locs[0], { status: "ok" });
        vi.setSystemTime(t0 + 240_000 + 1_000);
        expect(await opts.shouldStop()).toBe("budget");
        return ensureResult({
          refreshed: ["L1"],
          notAttempted: ["L2", "L3"],
        });
      });
      await runJob(jobRow(), ctx);

      expect(mocks.yieldRemainder).toHaveBeenCalledTimes(1);
      const [jobId, attempts, newPayload, summary] =
        mocks.yieldRemainder.mock.calls[0];
      expect(jobId).toBe(42);
      expect(attempts).toBe(1);
      // Payload narrows to the unfinished locs; base banks the whole-batch
      // narration (total stays 3, one unit done).
      expect(newPayload).toEqual({
        locs: [LOCS[1], LOCS[2]],
        force: false,
        base: { total: 3, done: 1 },
        // First yield pins the ORIGINAL coverage for jobLocCodes (GROK P1).
        allCodes: ["L1", "L2", "L3"],
      });
      expect(summary).toMatchObject({ remaining: 2, refreshed: 1 });
      expect(mocks.completeJob).not.toHaveBeenCalled();
      expect(mocks.scheduleRetry).not.toHaveBeenCalled();
      expect(mocks.failJob).not.toHaveBeenCalled();
      expect(mocks.requeueInterrupted).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumed chunk seeds progress from payload.base and keeps counting the ORIGINAL batch", async () => {
    // The handler mutates ONE progress object — snapshot per call, or the
    // stored references all show the final state.
    const snapshots: { unitsTotal?: number; unitsDone?: number }[] = [];
    mocks.updateProgress.mockImplementation(async (_id, p) => {
      snapshots.push({ ...p });
      return { cancelRequested: false };
    });
    try {
      mocks.ensureFrequencies.mockImplementation(async (_u, locs, opts) => {
        await opts.onUnit(locs[0], { status: "ok" });
        return ensureResult({ refreshed: locs.map((l: Loc) => l.code) });
      });
      await runJob(
        jobRow({
          payload: {
            locs: [LOCS[2]],
            force: false,
            base: { total: 3, done: 2 },
          },
        }),
        ctx,
      );
      expect(snapshots[0]).toMatchObject({ unitsTotal: 3, unitsDone: 2 });
      // After the last unit the bar reads 3 of 3 — the batch, not the chunk.
      expect(snapshots[snapshots.length - 1]).toMatchObject({
        unitsTotal: 3,
        unitsDone: 3,
      });
      expect(mocks.completeJob).toHaveBeenCalledTimes(1);
    } finally {
      mocks.updateProgress.mockImplementation(async () => ({
        cancelRequested: false,
      }));
    }
  });

  it("budget hit at the LAST unit (nothing remaining) → normal completion, no yield", async () => {
    vi.useFakeTimers();
    try {
      const t0 = Date.now();
      mocks.ensureFrequencies.mockImplementation(async (_u, locs, opts) => {
        for (const loc of locs) await opts.onUnit(loc, { status: "ok" });
        vi.setSystemTime(t0 + 240_000 + 1_000);
        expect(await opts.shouldStop()).toBe("budget");
        return ensureResult({ refreshed: locs.map((l: Loc) => l.code) });
      });
      await runJob(jobRow(), ctx);
      expect(mocks.yieldRemainder).not.toHaveBeenCalled();
      expect(mocks.completeJob).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancel outranks budget: both signals present → cancelRunningJob, not yield", async () => {
    vi.useFakeTimers();
    try {
      const t0 = Date.now();
      mocks.updateProgress.mockResolvedValue({ cancelRequested: true });
      mocks.ensureFrequencies.mockImplementation(async (_u, locs, opts) => {
        await opts.onUnit(locs[0], { status: "ok" });
        vi.setSystemTime(t0 + 240_000 + 1_000);
        expect(await opts.shouldStop()).toBe("cancel");
        return ensureResult({ refreshed: ["L1"], notAttempted: ["L2", "L3"] });
      });
      await runJob(jobRow(), ctx);
      expect(mocks.cancelRunningJob).toHaveBeenCalledTimes(1);
      expect(mocks.yieldRemainder).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      mocks.updateProgress.mockResolvedValue({ cancelRequested: false });
    }
  });

  it("resumed chunk + nonempty ready + NORMAL completion folds ready into the bar (CODEX1 #1)", async () => {
    // base 1/4 done; interleaved jobs loaded L2 meanwhile (ready, no onUnit);
    // this chunk refreshes L1+L3 and completes. Bar must end 4 of 4.
    const snapshots: { unitsTotal?: number; unitsDone?: number }[] = [];
    mocks.updateProgress.mockImplementation(async (_id, p) => {
      snapshots.push({ ...p });
      return { cancelRequested: false };
    });
    try {
      mocks.ensureFrequencies.mockImplementation(async (_u, locs, opts) => {
        await opts.onUnit(locs[0], { status: "ok" });
        await opts.onUnit(locs[2], { status: "ok" });
        return ensureResult({
          ready: [locs[1].code],
          refreshed: [locs[0].code, locs[2].code],
        });
      });
      await runJob(
        jobRow({
          payload: {
            locs: LOCS,
            force: false,
            base: { total: 4, done: 1 },
          },
        }),
        ctx,
      );
      expect(mocks.completeJob).toHaveBeenCalledTimes(1);
      expect(snapshots[snapshots.length - 1]).toMatchObject({
        unitsTotal: 4,
        unitsDone: 4, // 1 banked + 2 fetched + 1 ready — no false partial
      });
      expect(mocks.yieldRemainder).not.toHaveBeenCalled();
    } finally {
      mocks.updateProgress.mockImplementation(async () => ({
        cancelRequested: false,
      }));
    }
  });

  it("failed/skipped are chunk-local, never banked: a recovered loc does not stay failed (CODEX1 #2)", async () => {
    vi.useFakeTimers();
    const snapshots: { unitsDone?: number; unitsFailed?: number }[] = [];
    mocks.updateProgress.mockImplementation(async (_id, p) => {
      snapshots.push({ ...p });
      return { cancelRequested: false };
    });
    try {
      // Chunk 1: L1 ok, L2 FAILS, then budget → yield. The failed unit stays
      // in the payload; base banks done only.
      const t0 = Date.now();
      mocks.ensureFrequencies.mockImplementation(async (_u, locs, opts) => {
        await opts.onUnit(locs[0], { status: "ok" });
        await opts.onUnit(locs[1], { status: "failed", error: "eBird 500" });
        vi.setSystemTime(t0 + 240_000 + 1_000);
        await opts.shouldStop();
        return ensureResult({
          refreshed: [locs[0].code],
          failed: [{ code: locs[1].code, error: "eBird 500" }],
          notAttempted: [locs[2].code],
        });
      });
      await runJob(jobRow(), ctx);
      const [, , newPayload] = mocks.yieldRemainder.mock.calls[0];
      // Failed L2 rides the payload; base has NO failed field to go stale.
      expect(newPayload).toEqual({
        locs: [LOCS[1], LOCS[2]],
        force: false,
        base: { total: 3, done: 1 },
        allCodes: ["L1", "L2", "L3"],
      });
      expect(snapshots[snapshots.length - 1]).toMatchObject({ unitsFailed: 1 });

      // Chunk 2 (resumed): L2 now SUCCEEDS. Terminal progress must show it
      // done and NOT failed — the old banked counter would have said 1 failed.
      snapshots.length = 0;
      vi.useRealTimers();
      mocks.ensureFrequencies.mockImplementation(async (_u, locs, opts) => {
        for (const loc of locs) await opts.onUnit(loc, { status: "ok" });
        return ensureResult({ refreshed: locs.map((l: Loc) => l.code) });
      });
      await runJob(
        jobRow({
          payload: { locs: [LOCS[1], LOCS[2]], force: false, base: { total: 3, done: 1 } },
        }),
        ctx,
      );
      expect(mocks.completeJob).toHaveBeenCalledTimes(1);
      expect(snapshots[snapshots.length - 1]).toMatchObject({
        unitsDone: 3,
        unitsFailed: 0, // recovered — truthful terminal bar
      });
    } finally {
      vi.useRealTimers();
      mocks.updateProgress.mockImplementation(async () => ({
        cancelRequested: false,
      }));
    }
  });

  it("analyze_counties narrates N of ORIGINAL TOTAL across yields — never 0 of remaining (CODEX1 #3)", async () => {
    // Original snapshot: 3 counties; claim finds 1 already covered → derived
    // locs are 2, and the bar must open at 1 of 3, not 0 of 2.
    const snapshots: { unitsTotal?: number; unitsDone?: number }[] = [];
    mocks.updateProgress.mockImplementation(async (_id, p) => {
      snapshots.push({ ...p });
      return { cancelRequested: false };
    });
    try {
      mocks.frequencyMeta.mockResolvedValue(
        new Map([["US-FL-057", { endYear: 2025 }]]),
      );
      mocks.ensureFrequencies.mockImplementation(async (_u, locs, opts) => {
        for (const loc of locs) await opts.onUnit(loc, { status: "ok" });
        return ensureResult({ refreshed: locs.map((l: Loc) => l.code) });
      });
      await runJob(
        jobRow({
          type: "analyze_counties",
          payload: {
            regionCode: "US-FL",
            regionName: "Florida",
            counties: [
              { code: "US-FL-057", name: "Hillsborough" },
              { code: "US-FL-103", name: "Pinellas" },
              { code: "US-FL-081", name: "Manatee" },
            ],
          },
        }),
        ctx,
      );
      expect(snapshots[0]).toMatchObject({ unitsTotal: 3, unitsDone: 1 });
      expect(snapshots[snapshots.length - 1]).toMatchObject({
        unitsTotal: 3,
        unitsDone: 3,
      });
    } finally {
      mocks.frequencyMeta.mockResolvedValue(new Map());
      mocks.updateProgress.mockImplementation(async () => ({
        cancelRequested: false,
      }));
    }
  });

  it("a SECOND yield carries the original allCodes forward, not the narrowed set", async () => {
    vi.useFakeTimers();
    try {
      const t0 = Date.now();
      mocks.ensureFrequencies.mockImplementation(async (_u, locs, opts) => {
        await opts.onUnit(locs[0], { status: "ok" });
        vi.setSystemTime(t0 + 240_000 + 1_000);
        await opts.shouldStop();
        return ensureResult({
          refreshed: [locs[0].code],
          notAttempted: [locs[1].code],
        });
      });
      await runJob(
        jobRow({
          payload: {
            locs: [LOCS[1], LOCS[2]],
            force: false,
            base: { total: 3, done: 1 },
            allCodes: ["L1", "L2", "L3"],
          },
        }),
        ctx,
      );
      const [, , newPayload] = mocks.yieldRemainder.mock.calls[0];
      expect(newPayload).toEqual({
        locs: [LOCS[2]],
        force: false,
        base: { total: 3, done: 2 },
        allCodes: ["L1", "L2", "L3"], // original, not [L2, L3]
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("analyze_counties yields with payload UNTOUCHED (remainder re-derived at claim time)", async () => {
    vi.useFakeTimers();
    try {
      const t0 = Date.now();
      mocks.ensureFrequencies.mockImplementation(async (_u, locs, opts) => {
        await opts.onUnit(locs[0], { status: "ok" });
        vi.setSystemTime(t0 + 240_000 + 1_000);
        await opts.shouldStop();
        return ensureResult({
          refreshed: [locs[0].code],
          notAttempted: locs.slice(1).map((l: Loc) => l.code),
        });
      });
      await runJob(
        jobRow({
          type: "analyze_counties",
          payload: {
            regionCode: "US-FL",
            regionName: "Florida",
            counties: [
              { code: "US-FL-057", name: "Hillsborough" },
              { code: "US-FL-103", name: "Pinellas" },
            ],
          },
        }),
        ctx,
      );
      expect(mocks.yieldRemainder).toHaveBeenCalledTimes(1);
      // null payload = keep verbatim; analyzeCountiesLocs recomputes.
      expect(mocks.yieldRemainder.mock.calls[0][2]).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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

describe("red-team: hostile upstream text is REDACTED before storage (GROK #15 / CODEX1 Phase-2 #1)", () => {
  // Injects genuinely credential-bearing text through every free-text inlet
  // (unit errors, the ensure result's failed[].error, credentialProblem, and
  // a thrown handler error) and asserts the SECRET VALUES never reach the
  // storage calls — only [redacted] markers do. This exercises the
  // handler-layer sanitize; jobs-db.test.ts proves the jobs.ts boundary.
  const SECRETS = ["hunter2", "gaylon@vorwaller.net", "abc.def.ghi", "sk-live-XYZ"];
  const HOSTILE =
    "proxy echo: username=gaylon@vorwaller.net password=hunter2 " +
    "Authorization: Bearer abc.def.ghi api_key=sk-live-XYZ";

  function collectStoredJson(): string[] {
    return [
      ...mocks.recordEvent.mock.calls.map((c) => JSON.stringify(c[2] ?? {})),
      ...mocks.updateProgress.mock.calls.map((c) => JSON.stringify(c[1])),
      ...mocks.completeJob.mock.calls.map((c) => JSON.stringify(c[2] ?? null)),
      ...mocks.failJob.mock.calls.map((c) => JSON.stringify([c[2], c[3] ?? null])),
      ...mocks.scheduleRetry.mock.calls.map((c) => JSON.stringify(c[4] ?? null)),
      ...mocks.cancelRunningJob.mock.calls.map((c) => JSON.stringify(c[2] ?? null)),
    ];
  }

  function expectNoSecrets() {
    const stored = collectStoredJson();
    expect(stored.length).toBeGreaterThan(0);
    for (const json of stored) {
      for (const secret of SECRETS) expect(json).not.toContain(secret);
    }
    // Prove the redaction actually fired (not a vacuous pass).
    expect(stored.some((j) => j.includes("[redacted]"))).toBe(true);
  }

  it("hostile unit errors are redacted in progress, events, and the summary", async () => {
    mocks.ensureFrequencies.mockImplementation(async (_u, locs, opts) => {
      await opts.onUnit(locs[0], { status: "ok" });
      await opts.onUnit(locs[1], { status: "failed", kind: "unit", error: HOSTILE });
      return ensureResult({
        refreshed: ["L1"],
        failed: [{ code: "L2", error: HOSTILE, kind: "unit" }],
      });
    });
    await runJob(jobRow(), ctx);
    expectNoSecrets();
  });

  it("hostile credentialProblem is redacted in the failJob error and result", async () => {
    mocks.ensureFrequencies.mockResolvedValue(
      ensureResult({ credentialProblem: `sign-in rejected: ${HOSTILE}`, notAttempted: ["L2"] }),
    );
    await runJob(jobRow(), ctx);
    expect(mocks.failJob).toHaveBeenCalled();
    expectNoSecrets();
  });

  it("a hostile thrown error is redacted before failJob", async () => {
    mocks.ensureFrequencies.mockRejectedValue(new Error(`upstream blew up: ${HOSTILE}`));
    await runJob(jobRow(), ctx);
    expect(mocks.failJob).toHaveBeenCalledTimes(1);
    expectNoSecrets();
  });
});

describe("runJob — sync jobs (Phase 3)", () => {
  it("sync_lifelist success → completeJob with a compact counts result", async () => {
    syncMocks.syncLifeListFromEbird.mockResolvedValue({
      total: 412,
      matched: 400,
      unmatched: Array.from({ length: 12 }, (_, i) => `Mystery bird ${i}`),
    });
    await runJob(jobRow({ type: "sync_lifelist" }), ctx);
    expect(syncMocks.syncLifeListFromEbird).toHaveBeenCalledWith(7, expect.objectContaining({ heartbeat: expect.any(Function) }));
    expect(mocks.completeJob).toHaveBeenCalledTimes(1);
    const result = mocks.completeJob.mock.calls[0][2] as {
      total: number;
      matched: number;
      unmatchedCount: number;
      unmatched: string[];
    };
    expect(result).toMatchObject({ total: 412, matched: 400, unmatchedCount: 12 });
    expect(result.unmatched).toHaveLength(10); // first 10 only — compact
  });

  it("sync_lifelist credential failure → terminal failJob, never a retry", async () => {
    syncMocks.syncLifeListFromEbird.mockRejectedValue(
      new syncMocks.FakeEbirdLoginError("eBird rejected the sign-in."),
    );
    await runJob(jobRow({ type: "sync_lifelist" }), ctx);
    expect(mocks.failJob).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleRetry).not.toHaveBeenCalled();
  });

  it("sync_lifelist transient failure retries, then fails when the budget is spent", async () => {
    syncMocks.syncLifeListFromEbird.mockRejectedValue(new Error("HTTP 502 from eBird"));
    await runJob(jobRow({ type: "sync_lifelist" }), ctx);
    expect(mocks.scheduleRetry).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleRetry.mock.calls[0][2]).toBe(TRANSIENT_RETRY_DELAYS_MS[0]);
    vi.clearAllMocks();
    mocks.updateProgress.mockResolvedValue({ cancelRequested: false });
    syncMocks.syncLifeListFromEbird.mockRejectedValue(new Error("HTTP 502 from eBird"));
    await runJob(jobRow({ type: "sync_lifelist", attempts: 4 }), ctx);
    expect(mocks.failJob).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleRetry).not.toHaveBeenCalled();
  });

  it("CAS reachability/5xx (EbirdUpstreamError) retries on the transient schedule, NOT terminal", async () => {
    // The pre-fix bug: casLogin threw EbirdLoginError for "could not reach
    // the sign-in page", failing the job on attempt 1 during an outage.
    syncMocks.syncLifeListFromEbird.mockRejectedValue(
      new syncMocks.FakeEbirdUpstreamError("Could not reach the eBird sign-in page", 0),
    );
    await runJob(jobRow({ type: "sync_lifelist" }), ctx);
    expect(mocks.scheduleRetry).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleRetry.mock.calls[0][2]).toBe(TRANSIENT_RETRY_DELAYS_MS[0]);
    expect(mocks.failJob).not.toHaveBeenCalled();
  });

  it("a 429 (either typed class) honors the flat rate-limit backoff", async () => {
    syncMocks.syncLifeListFromEbird.mockRejectedValue(
      new syncMocks.FakeEbirdUpstreamError("eBird throttled", 429),
    );
    await runJob(jobRow({ type: "sync_lifelist" }), ctx);
    expect(mocks.scheduleRetry.mock.calls[0][2]).toBe(RATE_LIMIT_RETRY_DELAY_MS);

    vi.clearAllMocks();
    mocks.updateProgress.mockResolvedValue({ cancelRequested: false });
    syncMocks.syncTaxonomy.mockRejectedValueOnce(
      new syncMocks.FakeEbirdError("too many requests", 429),
    );
    await runJob(jobRow({ type: "sync_taxonomy" }), ctx);
    expect(mocks.scheduleRetry.mock.calls[0][2]).toBe(RATE_LIMIT_RETRY_DELAY_MS);
  });

  it("an invalid API key (EbirdError 401/403) is TERMINAL, never retried", async () => {
    for (const status of [401, 403]) {
      vi.clearAllMocks();
      mocks.updateProgress.mockResolvedValue({ cancelRequested: false });
      syncMocks.syncTaxonomy.mockRejectedValueOnce(
        new syncMocks.FakeEbirdError("eBird rejected the API key", status),
      );
      await runJob(jobRow({ type: "sync_taxonomy" }), ctx);
      expect(mocks.failJob).toHaveBeenCalledTimes(1);
      expect(mocks.scheduleRetry).not.toHaveBeenCalled();
    }
  });

  it("an EbirdError 5xx retries as transient", async () => {
    syncMocks.syncTaxonomy.mockRejectedValueOnce(
      new syncMocks.FakeEbirdError("eBird 502", 502),
    );
    await runJob(jobRow({ type: "sync_taxonomy" }), ctx);
    expect(mocks.scheduleRetry).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleRetry.mock.calls[0][2]).toBe(TRANSIENT_RETRY_DELAYS_MS[0]);
    expect(mocks.failJob).not.toHaveBeenCalled();
  });

  it("sync_taxonomy success → taxa + photo re-match counts", async () => {
    await runJob(jobRow({ type: "sync_taxonomy" }), ctx);
    expect(syncMocks.syncTaxonomy).toHaveBeenCalledWith("key");
    expect(mocks.completeJob.mock.calls[0][2]).toEqual({
      taxa: 42,
      photosMatched: 5,
      photosUnmatched: 1,
    });
  });

  it("sync_taxonomy without an API key → terminal failJob", async () => {
    syncMocks.getEbirdApiKey.mockResolvedValueOnce(null);
    await runJob(jobRow({ type: "sync_taxonomy" }), ctx);
    expect(mocks.failJob).toHaveBeenCalledTimes(1);
    expect(mocks.failJob.mock.calls[0][2]).toMatch(/API key/);
    expect(mocks.scheduleRetry).not.toHaveBeenCalled();
  });
});

describe("runJob — scan_need_alerts (plan Part A, Web Push channel)", () => {
  const ENDPOINT = "https://push.apple.example/dev-abc123SECRET";
  const HOME = { home_lat: 27.77, home_lon: -82.64 };
  const PREF_ROW = { user_id: 3, radius_km: 40, realert_days: 7, ...HOME };
  const SUB_ROW = { endpoint: ENDPOINT, p256dh: "k1", auth: "a1" };
  const NOTABLE = {
    speciesCode: "snakit",
    comName: "Snail Kite",
    locId: "L9",
    locName: "Sweetwater",
    obsDt: "2026-08-16 14:40",
    lat: 27.9,
    lng: -82.64,
    obsValid: true,
    obsReviewed: true,
    locationPrivate: false,
    subId: "S555",
  };

  function scanDb(prefs: unknown[], subsByUser: Record<number, unknown[]> = { 3: [SUB_ROW], 4: [SUB_ROW] }, sent: unknown[] = []) {
    db.handler = (text, params) => {
      if (text.includes("FROM user_alert_prefs p JOIN users")) return { rows: prefs };
      if (text.includes("FROM need_alerts_sent")) return { rows: sent };
      if (text.includes("FROM push_subscriptions"))
        return { rows: subsByUser[(params?.[0] as number) ?? 0] ?? [] };
      if (text.includes("FROM users WHERE role = 'admin'")) return { rows: [{ id: 1 }] };
      return undefined;
    };
  }

  it("happy path: push to the device with ABSOLUTE url + collapse tag, sent-row upserted, successor scheduled", async () => {
    scanDb([PREF_ROW]);
    syncMocks.notableNearbyObs.mockResolvedValue({
      data: [NOTABLE],
      fetchedAt: new Date(),
      stale: false,
    });
    await runJob(jobRow({ type: "scan_need_alerts", payload: {} }), ctx);

    expect(syncMocks.sendWebPush).toHaveBeenCalledTimes(1);
    const [sub, msg] = syncMocks.sendWebPush.mock.calls[0] as unknown as [
      { endpoint: string },
      { title: string; url: string; tag: string },
    ];
    expect(sub.endpoint).toBe(ENDPOINT);
    expect(msg.title).toBe("Lifer nearby: Snail Kite");
    // td-78a7b1: the click lands on the TRIGGERING report's checklist.
    expect(msg.url).toBe("https://ebird.org/checklist/S555");
    expect(msg.tag).toBe("need-snakit");
    const upsert = db.calls.find((c) => c.text.includes("INSERT INTO need_alerts_sent"));
    expect(upsert?.params?.slice(0, 8)).toEqual([
      3,
      "snakit",
      "L9",
      "2026-08-16 14:40",
      "S555",
      msg.title,
      (msg as unknown as { body: string }).body,
      msg.url,
    ]);
    // 9th param: the triggering reports JSON (td-78a7b1).
    expect(JSON.parse((upsert?.params?.[8] as string) ?? "[]")[0]).toMatchObject({
      subId: "S555",
    });
    expect(mocks.terminalizeAndReschedule).toHaveBeenCalledTimes(1);
    const [, , outcome, successor] = mocks.terminalizeAndReschedule.mock.calls[0] as unknown as [
      number,
      number,
      { kind: string; result: { alertsSent: number } },
      { runAfterMs: number; dedupKey: string },
    ];
    expect(outcome.kind).toBe("complete");
    expect(outcome.result.alertsSent).toBe(1);
    expect(successor.runAfterMs).toBe(30 * 60_000);
    expect(successor.dedupKey).toBe("scan_need_alerts:global");
    expect(mocks.completeJob).not.toHaveBeenCalled();
  });

  it("suppression row + history row commit as ONE atomic statement (writable CTE) — CODEX1 round 2", async () => {
    scanDb([PREF_ROW]);
    syncMocks.notableNearbyObs.mockResolvedValue({
      data: [NOTABLE],
      fetchedAt: new Date(),
      stale: false,
    });
    await runJob(jobRow({ type: "scan_need_alerts", payload: {} }), ctx);

    const [, msg] = syncMocks.sendWebPush.mock.calls[0] as unknown as [
      unknown,
      { title: string; body: string; url: string },
    ];
    // Exactly one settlement write carries BOTH inserts — a history hole can
    // never hide behind a committed suppression row, and the pair costs one
    // grace-bounded statement, not two.
    const combined = db.calls.filter(
      (c) =>
        c.text.includes("INSERT INTO need_alerts_sent") &&
        c.text.includes("INSERT INTO need_alert_log"),
    );
    expect(combined).toHaveLength(1);
    expect(
      db.calls.filter((c) => c.text.includes("INSERT INTO need_alert_log")),
    ).toHaveLength(1); // no separate second write
    // Verbatim: the history line is the pushed content, exactly — plus the
    // triggering reports (td-78a7b1) closest-first with full detail.
    expect(combined[0].params.slice(5, 8)).toEqual([msg.title, msg.body, msg.url]);
    const reports = JSON.parse(combined[0].params[8] as string) as {
      subId: string;
      locName: string;
      distanceMi: number;
    }[];
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ subId: "S555", locName: "Sweetwater" });
  });

  it("no subId on the triggering obs → click falls back to the in-app species page", async () => {
    scanDb([PREF_ROW]);
    syncMocks.notableNearbyObs.mockResolvedValue({
      data: [{ ...NOTABLE, subId: undefined }],
      fetchedAt: new Date(),
      stale: false,
    });
    await runJob(jobRow({ type: "scan_need_alerts", payload: {} }), ctx);
    const [, msg] = syncMocks.sendWebPush.mock.calls[0] as unknown as [
      unknown,
      { url: string },
    ];
    expect(msg.url).toMatch(/\/forecast\/species\?species=snakit$/);
  });

  it("no enrolled devices → unit_skipped('no-devices'), nothing sent", async () => {
    scanDb([PREF_ROW], { 3: [] });
    syncMocks.notableNearbyObs.mockResolvedValue({
      data: [NOTABLE],
      fetchedAt: new Date(),
      stale: false,
    });
    await runJob(jobRow({ type: "scan_need_alerts", payload: {} }), ctx);
    expect(syncMocks.sendWebPush).not.toHaveBeenCalled();
    const skips = mocks.recordEvent.mock.calls.filter((c) => c[1] === "unit_skipped");
    expect((skips[0][2] as { reason: string }).reason).toBe("no-devices");
  });

  it("a GONE endpoint (410) is pruned; delivery to a live sibling still counts", async () => {
    const dead = { endpoint: "https://push.apple.example/dead", p256dh: "k2", auth: "a2" };
    scanDb([PREF_ROW], { 3: [dead, SUB_ROW] });
    syncMocks.notableNearbyObs.mockResolvedValue({
      data: [NOTABLE],
      fetchedAt: new Date(),
      stale: false,
    });
    syncMocks.sendWebPush
      .mockRejectedValueOnce(new pushMocks.FakePushError("push endpoint returned HTTP 410", 410, true))
      .mockResolvedValueOnce(undefined);
    await runJob(jobRow({ type: "scan_need_alerts", payload: {} }), ctx);
    // Delivered to the live device → sent-row recorded.
    expect(db.calls.filter((c) => c.text.includes("INSERT INTO need_alerts_sent"))).toHaveLength(1);
    // Dead endpoint pruned in the bounded cleanup write.
    const prune = db.calls.find((c) => c.text.includes("DELETE FROM push_subscriptions"));
    expect(prune?.params?.[1]).toEqual(["https://push.apple.example/dead"]);
    const oks = mocks.recordEvent.mock.calls.filter((c) => c[1] === "unit_ok");
    expect((oks[0][2] as { alerts: number }).alerts).toBe(1);
  });

  it("a 410 sibling is pruned EVEN WHEN the user fails (500 sibling, zero delivery) — CODEX1", async () => {
    const dead = { endpoint: "https://push.apple.example/dead", p256dh: "k2", auth: "a2" };
    scanDb([PREF_ROW], { 3: [dead, SUB_ROW] });
    syncMocks.notableNearbyObs.mockResolvedValue({
      data: [NOTABLE],
      fetchedAt: new Date(),
      stale: false,
    });
    syncMocks.sendWebPush
      .mockRejectedValueOnce(new pushMocks.FakePushError("push endpoint returned HTTP 410", 410, true))
      .mockRejectedValueOnce(new pushMocks.FakePushError("push endpoint returned HTTP 500", 500, false));
    await runJob(jobRow({ type: "scan_need_alerts", payload: {} }), ctx);
    // The user failed (zero delivery, non-gone error present)...
    const fails = mocks.recordEvent.mock.calls.filter((c) => c[1] === "unit_failed");
    expect(fails).toHaveLength(1);
    // ...but the settlement path STILL pruned the dead endpoint — it must
    // not survive to repeat on every retry.
    const prune = db.calls.find((c) => c.text.includes("DELETE FROM push_subscriptions"));
    expect(prune?.params?.[1]).toEqual(["https://push.apple.example/dead"]);
    expect(db.calls.filter((c) => c.text.includes("INSERT INTO need_alerts_sent"))).toHaveLength(0);
  });

  it("TRUE OUTER WALL: late send + gone sibling + stalling writes share ONE grace (budget+push-timeout+5s) — CODEX1", async () => {
    vi.useFakeTimers();
    try {
      const dead = { endpoint: "https://push.apple.example/dead", p256dh: "k2", auth: "a2" };
      scanDb([PREF_ROW], { 3: [dead, SUB_ROW] });
      // Pre-send pipeline consumes ~59s (signal-unaware slow fetch that DOES
      // resolve, just slowly — before the deadline).
      syncMocks.notableNearbyObs.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(
              () => resolve({ data: [NOTABLE], fetchedAt: new Date(), stale: false }),
              59_000,
            );
          }),
      );
      // Dead sibling 410s instantly; the live send starts ~59s (just before
      // the 60s deadline) and resolves at ~68s — inside its own 10s bound.
      syncMocks.sendWebPush.mockImplementation((...a: unknown[]) => {
        const sub = a[0] as { endpoint: string };
        if (sub.endpoint.endsWith("/dead")) {
          return Promise.reject(
            new pushMocks.FakePushError("push endpoint returned HTTP 410", 410, true),
          );
        }
        return new Promise<void>((resolve) => setTimeout(() => resolve(), 9_000));
      });
      // Every must-settle write stalls to its full timeout then rejects.
      db.stallTimedWrites = true;
      const p = runJob(jobRow({ type: "scan_need_alerts", payload: {} }), ctx);
      let doneAt = 0;
      void p.then(() => (doneAt = Date.now()));
      const startAt = Date.now();
      await vi.advanceTimersByTimeAsync(80_000);
      await p;
      const elapsed = doneAt - startAt;
      // One shared grace: wall ≤ 60s budget + 10s push timeout + 5s grace
      // (+ small epsilon). Stacked per-write graces would exceed this.
      expect(elapsed).toBeGreaterThan(60_000);
      expect(elapsed).toBeLessThanOrEqual(75_500);
      // Both writes were bounded by the SHARED window — each timeout handed
      // to queryTimed was ≤ the grace remainder, never a fresh 5s+.
      for (const t of db.timedTimeouts) {
        expect(t).toBeLessThanOrEqual(5_000 + 100);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("EVERY endpoint failing (non-gone) fails the user; no sent-row, next scan re-attempts", async () => {
    scanDb([PREF_ROW]);
    syncMocks.notableNearbyObs.mockResolvedValue({
      data: [NOTABLE],
      fetchedAt: new Date(),
      stale: false,
    });
    syncMocks.sendWebPush.mockRejectedValue(
      new pushMocks.FakePushError("push endpoint returned HTTP 500", 500, false),
    );
    await runJob(jobRow({ type: "scan_need_alerts", payload: {} }), ctx);
    expect(db.calls.filter((c) => c.text.includes("INSERT INTO need_alerts_sent"))).toHaveLength(0);
    const fails = mocks.recordEvent.mock.calls.filter((c) => c[1] === "unit_failed");
    expect(fails).toHaveLength(1);
    // Only eligible user failed → aggregate retry, not success.
    expect(mocks.scheduleRetry).toHaveBeenCalledTimes(1);
  });

  it("STALE cache never notifies — unit_skipped and retried next scan (CODEX1 plan #4)", async () => {
    scanDb([PREF_ROW]);
    syncMocks.notableNearbyObs.mockResolvedValue({
      data: [NOTABLE],
      fetchedAt: new Date(Date.now() - 3 * 60 * 60_000),
      stale: true,
    });
    await runJob(jobRow({ type: "scan_need_alerts", payload: {} }), ctx);
    expect(syncMocks.sendWebPush).not.toHaveBeenCalled();
    const skips = mocks.recordEvent.mock.calls.filter((c) => c[1] === "unit_skipped");
    expect((skips[0][2] as { reason: string }).reason).toBe("stale-cache");
    expect(mocks.terminalizeAndReschedule).toHaveBeenCalledTimes(1);
  });

  it("skip reasons: no home, no API key", async () => {
    scanDb([
      { ...PREF_ROW, user_id: 3, home_lat: null, home_lon: null },
      { ...PREF_ROW, user_id: 4 },
    ]);
    syncMocks.getEbirdApiKey.mockResolvedValueOnce(null); // user 4
    await runJob(jobRow({ type: "scan_need_alerts", payload: {} }), ctx);
    const reasons = mocks.recordEvent.mock.calls
      .filter((c) => c[1] === "unit_skipped")
      .map((c) => (c[2] as { reason: string }).reason);
    expect(reasons.sort()).toEqual(["no-api-key", "no-home"]);
    expect(syncMocks.sendWebPush).not.toHaveBeenCalled();
  });

  it("EVERY eligible user failing takes the retry schedule, not success (CODEX1 plan #5)", async () => {
    scanDb([PREF_ROW]);
    syncMocks.notableNearbyObs.mockRejectedValue(new Error("eBird 502"));
    await runJob(jobRow({ type: "scan_need_alerts", payload: {} }), ctx);
    expect(mocks.scheduleRetry).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleRetry.mock.calls[0][2]).toBe(TRANSIENT_RETRY_DELAYS_MS[0]);
    expect(mocks.terminalizeAndReschedule).not.toHaveBeenCalled();
  });

  it("at-least-once crash window: push delivered, record failed → user unit_failed, scan survives", async () => {
    scanDb([PREF_ROW]);
    syncMocks.notableNearbyObs.mockResolvedValue({
      data: [NOTABLE],
      fetchedAt: new Date(),
      stale: false,
    });
    const baseHandler = db.handler!;
    db.handler = (text, params) => {
      if (text.includes("INSERT INTO need_alerts_sent")) throw new Error("db died");
      return baseHandler(text, params);
    };
    await runJob(jobRow({ type: "scan_need_alerts", payload: {} }), ctx);
    expect(syncMocks.sendWebPush).toHaveBeenCalledTimes(1); // push went out
    const fails = mocks.recordEvent.mock.calls.filter((c) => c[1] === "unit_failed");
    expect(fails).toHaveLength(1);
    expect(mocks.scheduleRetry).toHaveBeenCalledTimes(1);
  });

  /** A signal-respecting hang for the reads (real pool-stall shape). */
  function hangUntilAborted(): (
    ...a: unknown[]
  ) => Promise<{ data: unknown[]; fetchedAt: Date; stale: boolean }> {
    return (...a: unknown[]) =>
      new Promise((_, reject) => {
        const opts = a[5] as { signal?: AbortSignal } | undefined;
        opts?.signal?.addEventListener("abort", () =>
          reject(new Error("request aborted (deadline)")),
        );
      });
  }

  it("budget ABORTS pre-send work: hung fetch stops at the deadline, next user still alerts (CODEX1)", async () => {
    vi.useFakeTimers();
    try {
      scanDb([PREF_ROW, { ...PREF_ROW, user_id: 4 }]);
      syncMocks.notableNearbyObs
        .mockImplementationOnce(hangUntilAborted())
        .mockResolvedValueOnce({ data: [NOTABLE], fetchedAt: new Date(), stale: false });
      const p = runJob(jobRow({ type: "scan_need_alerts", payload: {} }), ctx);
      await vi.advanceTimersByTimeAsync(61_000);
      await p;
      const fails = mocks.recordEvent.mock.calls.filter((c) => c[1] === "unit_failed");
      expect(fails).toHaveLength(1);
      expect((fails[0][2] as { budget?: boolean }).budget).toBe(true);
      const opts = syncMocks.notableNearbyObs.mock.calls[0][5] as { signal?: AbortSignal };
      expect(opts?.signal).toBeInstanceOf(AbortSignal);
      expect(syncMocks.sendWebPush).toHaveBeenCalledTimes(1); // user 4 only
      expect(mocks.terminalizeAndReschedule).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a NEVER-SETTLING signal-unaware DB read detaches at the deadline: next user runs, scan terminalizes, zero publishes for the wedged user (CODEX1 re-re-review)", async () => {
    vi.useFakeTimers();
    try {
      scanDb([PREF_ROW, { ...PREF_ROW, user_id: 4 }]);
      syncMocks.seenSet
        .mockImplementationOnce(() => new Promise(() => {}))
        .mockResolvedValueOnce(new Set());
      syncMocks.notableNearbyObs.mockResolvedValue({
        data: [NOTABLE],
        fetchedAt: new Date(),
        stale: false,
      });
      const p = runJob(jobRow({ type: "scan_need_alerts", payload: {} }), ctx);
      await vi.advanceTimersByTimeAsync(61_000);
      await p;
      const fails = mocks.recordEvent.mock.calls.filter((c) => c[1] === "unit_failed");
      expect(fails).toHaveLength(1);
      expect((fails[0][2] as { budget?: boolean; userId: number })).toMatchObject({
        budget: true,
        userId: 3,
      });
      expect(syncMocks.sendWebPush).toHaveBeenCalledTimes(1); // user 4 only
      expect(mocks.terminalizeAndReschedule).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(syncMocks.sendWebPush).toHaveBeenCalledTimes(1);
      const upserts = db.calls.filter((c) => c.text.includes("INSERT INTO need_alerts_sent"));
      expect(upserts).toHaveLength(1);
      expect(upserts[0].params?.[0]).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a fetch RESOLVING after expiry causes zero post-deadline side effects (CODEX1 re-review)", async () => {
    vi.useFakeTimers();
    try {
      scanDb([PREF_ROW]);
      syncMocks.notableNearbyObs.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(
              () => resolve({ data: [NOTABLE], fetchedAt: new Date(), stale: false }),
              70_000,
            );
          }),
      );
      const p = runJob(jobRow({ type: "scan_need_alerts", payload: {} }), ctx);
      await vi.advanceTimersByTimeAsync(71_000);
      await p;
      expect(syncMocks.sendWebPush).not.toHaveBeenCalled();
      expect(db.calls.filter((c) => c.text.includes("INSERT INTO need_alerts_sent"))).toHaveLength(0);
      const fails = mocks.recordEvent.mock.calls.filter((c) => c[1] === "unit_failed");
      expect(fails).toHaveLength(1);
      expect((fails[0][2] as { budget?: boolean }).budget).toBe(true);
      expect(mocks.scheduleRetry).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("red-team: the endpoint URL appears in NOTHING recorded (capability secrecy)", async () => {
    scanDb([PREF_ROW]);
    syncMocks.notableNearbyObs.mockResolvedValue({
      data: [NOTABLE],
      fetchedAt: new Date(),
      stale: false,
    });
    // Even when a push FAILS, the typed error carries no endpoint.
    syncMocks.sendWebPush.mockRejectedValue(
      new pushMocks.FakePushError("push endpoint returned HTTP 500", 500, false),
    );
    await runJob(jobRow({ type: "scan_need_alerts", payload: {} }), ctx);
    const stored = [
      ...mocks.recordEvent.mock.calls.map((c) => JSON.stringify(c[2] ?? {})),
      ...mocks.updateProgress.mock.calls.map((c) => JSON.stringify(c[1])),
      ...mocks.terminalizeAndReschedule.mock.calls.map((c) => JSON.stringify([c[2], c[3]])),
      ...mocks.scheduleRetry.mock.calls.map((c) => JSON.stringify(c[4] ?? null)),
    ];
    expect(stored.length).toBeGreaterThan(0);
    for (const json of stored) {
      expect(json).not.toContain(ENDPOINT);
      expect(json).not.toContain("dev-abc123SECRET");
    }
  });
});

describe("ensureNeedAlertScan (reconciliation)", () => {
  it("enqueues the singleton when absent, owned by the lowest-id admin", async () => {
    db.handler = (text) =>
      text.includes("FROM users WHERE role = 'admin'") ? { rows: [{ id: 1 }] } : undefined;
    mocks.hasActiveJob.mockResolvedValueOnce(false);
    await ensureNeedAlertScan();
    expect(mocks.enqueueJob).toHaveBeenCalledTimes(1);
    const p = mocks.enqueueJob.mock.calls[0][0] as {
      type: string;
      dedupKey: string;
      requestedBy: number;
    };
    expect(p.type).toBe("scan_need_alerts");
    expect(p.dedupKey).toBe("scan_need_alerts:global");
    expect(p.requestedBy).toBe(1);
  });

  it("no-ops while an active singleton exists", async () => {
    mocks.hasActiveJob.mockResolvedValueOnce(true);
    await ensureNeedAlertScan();
    expect(mocks.enqueueJob).not.toHaveBeenCalled();
  });
});

describe("runJob — dispatch", () => {
  it("unknown types fail cleanly", async () => {
    await runJob(jobRow({ type: "mystery_job" }), ctx);
    expect(mocks.failJob).toHaveBeenCalledTimes(1);
    expect(mocks.failJob.mock.calls[0][2]).toMatch(/no handler/);
  });
});

const { WikidataError } = await import("./wikidata");
const { WikipediaError } = await import("./wikipedia");
const { CommonsError } = await import("./wikimedia-commons");
const { XenoCantoError } = await import("./xeno-canto");

describe("runJob — species enrichment (plan Phase 1)", () => {

  const WD = (code: string, title: string | null) => ({
    speciesCode: code,
    qid: "Q1",
    enwikiTitle: title,
    iucnStatus: "least concern",
    massKgMin: null,
    massKgMax: null,
    wingspanMMin: null,
    wingspanMMax: null,
    inatTaxonId: null,
    xenoCantoId: null,
  });

  beforeEach(() => {
    enrichMocks.fetchWikidataBatch.mockReset();
    enrichMocks.fetchWikidataBySciName.mockReset();
    enrichMocks.fetchWikidataBySciName.mockResolvedValue(new Map());
    enrichMocks.fetchArticlePlaintext.mockReset();
    // Freshness probe: default NOT fresh (attempt every unit).
    db.handler = (text) => {
      if (text.includes("AS skip")) return { rows: [{ skip: false }] };
      if (text.includes("FROM users WHERE role = 'admin'")) return { rows: [{ id: 1 }] };
      return undefined;
    };
  });

  it("chunk happy path: mixed outcomes (ok / no_article / no_mapping) complete with stage counts", async () => {
    enrichMocks.fetchWikidataBatch.mockResolvedValue(
      new Map([
        ["margod", WD("margod", "Marbled godwit")],
        ["grycat", WD("grycat", "Gray catbird")],
        // "ghost1" absent → no_mapping
      ]) as never,
    );
    enrichMocks.fetchArticlePlaintext
      .mockResolvedValueOnce({
        title: "Marbled godwit",
        revId: 7,
        extract: "prose",
        sections: [],
      })
      .mockResolvedValueOnce(null); // catbird article missing → no_article

    await runJob(
      jobRow({ type: "enrich_species", payload: { codes: ["margod", "grycat", "ghost1"] } }),
      ctx,
    );

    // All three are units with NAMED outcomes — none are skips (CODEX1 #11).
    const oks = mocks.recordEvent.mock.calls.filter((c) => c[1] === "unit_ok");
    expect(oks.map((c) => (c[2] as { outcome: string }).outcome).sort()).toEqual([
      "no_article",
      "no_mapping",
      "ok",
    ]);
    expect(mocks.completeJob).toHaveBeenCalledTimes(1);
    expect(mocks.completeJob.mock.calls[0][2]).toMatchObject({
      ok: 1,
      noArticle: 1,
      noMapping: 1,
      failed: [],
    });
    // Resolution + prose writes reached the DB gateway.
    expect(db.calls.some((c) => c.text.includes("INSERT INTO species_enrichment"))).toBe(true);
  });

  it("anti-loop pin: FRESH no_sitelink + WDQS hit never opens Wikipedia (GROK td-b7d021 P2-2)", async () => {
    // The probe says fresh (clock inside the weekly window) and NOT
    // retry_due; the batch resolution still has the QID (P3444 succeeded).
    // A resolved.has()-style rescue copied onto no_sitelink would re-fetch
    // the binomial article for every split survivor in every 15-min drain —
    // the fdb3d40 loop, on Wikipedia this time. Pin: skip stays a skip.
    enrichMocks.fetchWikidataBatch.mockResolvedValue(
      new Map([["whimbr3", WD("whimbr3", null)]]) as never,
    );
    const base = db.handler;
    db.handler = (text, params) => {
      if (text.includes("AS skip"))
        return {
          rows: [
            {
              skip: true,
              resolution: "no_sitelink",
              wiki_status: "no_article",
              retry_due: false,
            },
          ],
        };
      return base?.(text, params);
    };

    await runJob(jobRow({ type: "enrich_species", payload: { codes: ["whimbr3"] } }), ctx);

    expect(enrichMocks.fetchArticlePlaintext).not.toHaveBeenCalled();
    const skips = mocks.recordEvent.mock.calls.filter((c) => c[1] === "unit_skipped");
    expect(skips.map((c) => (c[2] as { reason: string }).reason)).toEqual(["fresh"]);
    expect(mocks.completeJob).toHaveBeenCalledTimes(1);
  });

  it("no_sitelink weekly retry_due IS rescued: the binomial fallback runs (GROK pin d)", async () => {
    enrichMocks.fetchWikidataBatch.mockResolvedValue(
      new Map([["whimbr3", WD("whimbr3", null)]]) as never,
    );
    const base = db.handler;
    db.handler = (text, params) => {
      if (text.includes("AS skip"))
        return {
          rows: [
            {
              skip: true,
              resolution: "no_sitelink",
              wiki_status: "no_article",
              retry_due: true,
            },
          ],
        };
      if (text.includes("SELECT species_code, com_name, sci_name"))
        return {
          rows: [
            {
              species_code: "whimbr3",
              com_name: "Hudsonian Whimbrel",
              sci_name: "Numenius hudsonicus",
              family: null,
            },
          ],
        };
      return base?.(text, params);
    };
    enrichMocks.fetchArticlePlaintext.mockResolvedValueOnce({
      title: "Hudsonian whimbrel",
      revId: 11,
      extract: "prose",
      sections: [],
    });

    await runJob(jobRow({ type: "enrich_species", payload: { codes: ["whimbr3"] } }), ctx);

    // Fallback title is the BINOMIAL, and the resolved page landed as ok.
    expect(enrichMocks.fetchArticlePlaintext).toHaveBeenCalledWith("Numenius hudsonicus");
    const oks = mocks.recordEvent.mock.calls.filter((c) => c[1] === "unit_ok");
    expect(oks.map((c) => (c[2] as { outcome: string }).outcome)).toEqual(["ok"]);
  });

  it("split survivor: no P3444 hit, sci-name fallback resolves it (td-e64d93 — Gull-billed Tern)", async () => {
    // Primary lookup misses gubter2 entirely (Wikidata still carries the
    // pre-split code); the binomial resolves it.
    enrichMocks.fetchWikidataBatch.mockResolvedValue(new Map() as never);
    enrichMocks.fetchWikidataBySciName.mockResolvedValueOnce(
      new Map([["gubter2", { ...WD("gubter2", "Gull-billed tern"), qid: "Q18834" }]]) as never,
    );
    const base = db.handler;
    db.handler = (text, params) => {
      if (text.includes("SELECT species_code, sci_name FROM taxonomy_cache"))
        return { rows: [{ species_code: "gubter2", sci_name: "Gelochelidon nilotica" }] };
      return base?.(text, params);
    };
    enrichMocks.fetchArticlePlaintext.mockResolvedValueOnce({
      title: "Gull-billed tern",
      revId: 9,
      extract: "prose",
      sections: [],
    });

    await runJob(jobRow({ type: "enrich_species", payload: { codes: ["gubter2"] } }), ctx);

    // The fallback got the CALLER's pairs…
    expect(enrichMocks.fetchWikidataBySciName).toHaveBeenCalledWith([
      { code: "gubter2", sciName: "Gelochelidon nilotica" },
    ]);
    // …and the unit completed as a full OK, not no_mapping.
    const oks = mocks.recordEvent.mock.calls.filter((c) => c[1] === "unit_ok");
    expect(oks.some((c) => (c[2] as { kind?: string }).kind === "sci_name_fallback")).toBe(true);
    expect(oks.some((c) => (c[2] as { outcome?: string }).outcome === "ok")).toBe(true);
    expect(oks.some((c) => (c[2] as { outcome?: string }).outcome === "no_mapping")).toBe(false);
    expect(mocks.completeJob).toHaveBeenCalledTimes(1);
    expect(mocks.completeJob.mock.calls[0][2]).toMatchObject({ ok: 1, noMapping: 0 });
  });

  it("FROZEN no_mapping row + fallback hit is RESCUED: skip-if-fresh must not discard the QID (GROK)", async () => {
    // The gubter2 shape: resolution='no_mapping', wiki_status='no_article',
    // FRESH clock — the fresh probe says skip, but the fallback just found
    // the mapping. The unit must run resolution + wiki, not record 'fresh'.
    enrichMocks.fetchWikidataBatch.mockResolvedValue(new Map() as never);
    enrichMocks.fetchWikidataBySciName.mockResolvedValueOnce(
      new Map([["gubter2", { ...WD("gubter2", "Gull-billed tern"), qid: "Q18834" }]]) as never,
    );
    const base = db.handler;
    db.handler = (text, params) => {
      if (text.includes("AS skip"))
        return { rows: [{ skip: true, resolution: "no_mapping", retry_due: false }] };
      if (text.includes("SELECT species_code, sci_name FROM taxonomy_cache"))
        return { rows: [{ species_code: "gubter2", sci_name: "Gelochelidon nilotica" }] };
      return base?.(text, params);
    };
    enrichMocks.fetchArticlePlaintext.mockResolvedValueOnce({
      title: "Gull-billed tern",
      revId: 11,
      extract: "prose",
      sections: [],
    });

    await runJob(jobRow({ type: "enrich_species", payload: { codes: ["gubter2"] } }), ctx);

    // Not skipped as fresh — the wiki stage actually ran on the fallback QID.
    expect(enrichMocks.fetchArticlePlaintext).toHaveBeenCalledWith("Gull-billed tern");
    const skips = mocks.recordEvent.mock.calls.filter((c) => c[1] === "unit_skipped");
    expect(skips).toHaveLength(0);
    expect(mocks.completeJob).toHaveBeenCalledTimes(1);
    expect(mocks.completeJob.mock.calls[0][2]).toMatchObject({ ok: 1, fresh: 0 });
    // Resolution write reached the DB gateway.
    expect(db.calls.some((c) => c.text.includes("INSERT INTO species_enrichment"))).toBe(true);
  });

  it("weekly-due no_mapping + fallback MISS restamps the clock — never a fresh-skip loop (CODEX1)", async () => {
    // The loop shape CODEX1 traced: an 8-day-old no_mapping row is due under
    // the weekly lane; both WDQS lookups miss. If the fresh-skip fires, the
    // clock is never restamped, wikiStaleCodes keeps returning the row, and
    // the scan's 15-minute drain cadence re-runs it forever. The terminal
    // no_mapping path must run instead, restamping via markWikiNoArticle.
    enrichMocks.fetchWikidataBatch.mockResolvedValue(new Map() as never);
    enrichMocks.fetchWikidataBySciName.mockResolvedValueOnce(new Map() as never); // MISS
    const base = db.handler;
    db.handler = (text, params) => {
      if (text.includes("AS skip"))
        return { rows: [{ skip: true, resolution: "no_mapping", retry_due: true }] };
      if (text.includes("SELECT species_code, sci_name FROM taxonomy_cache"))
        return { rows: [{ species_code: "gubter2", sci_name: "Gelochelidon nilotica" }] };
      return base?.(text, params);
    };

    await runJob(jobRow({ type: "enrich_species", payload: { codes: ["gubter2"] } }), ctx);

    // Not skipped as fresh — the terminal no_mapping outcome ran…
    expect(mocks.recordEvent.mock.calls.filter((c) => c[1] === "unit_skipped")).toHaveLength(0);
    expect(mocks.completeJob).toHaveBeenCalledTimes(1);
    expect(mocks.completeJob.mock.calls[0][2]).toMatchObject({ noMapping: 1, fresh: 0 });
    // …and the clock restamp reached the DB (markWikiNoArticle's write) so
    // the weekly lane will not re-select this row for another 7 days.
    expect(
      db.calls.some(
        (c) => c.text.includes("'no_article'") && c.params?.[0] === "gubter2",
      ),
    ).toBe(true);
  });

  it("sci-name fallback failure is SOFT: primary results survive, missing codes stay no_mapping", async () => {
    enrichMocks.fetchWikidataBatch.mockResolvedValue(
      new Map([["margod", WD("margod", "Marbled godwit")]]) as never,
    );
    enrichMocks.fetchWikidataBySciName.mockRejectedValueOnce(
      new WikidataError("Wikidata query failed (HTTP 503)", 503, false),
    );
    const base = db.handler;
    db.handler = (text, params) => {
      if (text.includes("SELECT species_code, sci_name FROM taxonomy_cache"))
        return { rows: [{ species_code: "ghost1", sci_name: "Nulla species" }] };
      return base?.(text, params);
    };
    enrichMocks.fetchArticlePlaintext.mockResolvedValueOnce({
      title: "Marbled godwit",
      revId: 7,
      extract: "prose",
      sections: [],
    });
    await runJob(
      jobRow({ type: "enrich_species", payload: { codes: ["margod", "ghost1"] } }),
      ctx,
    );
    // No whole-job retry — the chunk completed on primary data.
    expect(mocks.scheduleRetry).not.toHaveBeenCalled();
    expect(mocks.completeJob).toHaveBeenCalledTimes(1);
    expect(mocks.completeJob.mock.calls[0][2]).toMatchObject({ ok: 1, noMapping: 1 });
  });

  it("SPARQL transient failure → whole-job retry, nothing attempted", async () => {
    enrichMocks.fetchWikidataBatch.mockRejectedValue(
      new WikidataError("Wikidata query failed (HTTP 503)", 503, false),
    );
    await runJob(jobRow({ type: "enrich_species", payload: { codes: ["margod"] } }), ctx);
    expect(mocks.scheduleRetry).toHaveBeenCalledTimes(1);
    expect(enrichMocks.fetchArticlePlaintext).not.toHaveBeenCalled();
    expect(mocks.completeJob).not.toHaveBeenCalled();
  });

  it("wikipedia 429 stops the batch → rate-limit retry (Retry-After semantics)", async () => {
    enrichMocks.fetchWikidataBatch.mockResolvedValue(
      new Map([
        ["margod", WD("margod", "Marbled godwit")],
        ["grycat", WD("grycat", "Gray catbird")],
      ]) as never,
    );
    enrichMocks.fetchArticlePlaintext.mockRejectedValue(
      new WikipediaError("Wikipedia query failed (HTTP 429)", 429, true),
    );
    await runJob(
      jobRow({ type: "enrich_species", payload: { codes: ["margod", "grycat"] } }),
      ctx,
    );
    expect(mocks.scheduleRetry).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleRetry.mock.calls[0][2]).toBe(RATE_LIMIT_RETRY_DELAY_MS);
    // Only ONE wiki fetch happened — the batch stopped, it did not spray.
    expect(enrichMocks.fetchArticlePlaintext).toHaveBeenCalledTimes(1);
  });

  it("MIXED failure (1 ok + 1 transient) → scheduleRetry, never a green complete (CODEX1 P1 #2)", async () => {
    enrichMocks.fetchWikidataBatch.mockResolvedValue(
      new Map([
        ["margod", WD("margod", "Marbled godwit")],
        ["grycat", WD("grycat", "Gray catbird")],
      ]) as never,
    );
    enrichMocks.fetchArticlePlaintext
      .mockRejectedValueOnce(new WikipediaError("Wikipedia unreachable: boom", 0, false))
      .mockResolvedValueOnce({ title: "Gray catbird", revId: 9, extract: "p", sections: [] });
    await runJob(
      jobRow({ type: "enrich_species", payload: { codes: ["margod", "grycat"] } }),
      ctx,
    );
    const fails = mocks.recordEvent.mock.calls.filter((c) => c[1] === "unit_failed");
    expect(fails).toHaveLength(1);
    expect((fails[0][2] as { code: string }).code).toBe("margod");
    expect(db.calls.some((c) => c.text.includes("wiki_status = 'error'"))).toBe(true);
    // The success is persisted; the FAILURE forces a retry of the row — the
    // next attempt naturally narrows to margod (grycat is freshness-skipped).
    expect(mocks.completeJob).not.toHaveBeenCalled();
    expect(mocks.scheduleRetry).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleRetry.mock.calls[0][4]).toMatchObject({ ok: 1, failed: ["margod"] });
  });

  it("retry EXHAUSTION with failures → honest failJob (persisted data stays)", async () => {
    enrichMocks.fetchWikidataBatch.mockResolvedValue(
      new Map([["margod", WD("margod", "Marbled godwit")]]) as never,
    );
    enrichMocks.fetchArticlePlaintext.mockRejectedValue(
      new WikipediaError("Wikipedia unreachable: boom", 0, false),
    );
    await runJob(
      jobRow({ type: "enrich_species", payload: { codes: ["margod"] }, attempts: 4 }),
      ctx,
    );
    expect(mocks.failJob).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleRetry).not.toHaveBeenCalled();
    expect(mocks.completeJob).not.toHaveBeenCalled();
  });

  it("oversize payload (31 codes) → terminal failJob, no network (CODEX1 P2 #5)", async () => {
    const codes = Array.from({ length: 31 }, (_, i) => `spcode${i}`);
    await runJob(jobRow({ type: "enrich_species", payload: { codes } }), ctx);
    expect(mocks.failJob).toHaveBeenCalledTimes(1);
    expect(enrichMocks.fetchWikidataBatch).not.toHaveBeenCalled();
  });

  it("wikipedia Retry-After is honored over the default rate-limit delay (CODEX1 P2 #6)", async () => {
    enrichMocks.fetchWikidataBatch.mockResolvedValue(
      new Map([["margod", WD("margod", "Marbled godwit")]]) as never,
    );
    enrichMocks.fetchArticlePlaintext.mockRejectedValue(
      new WikipediaError("Wikipedia query failed (HTTP 429)", 429, true, 90_000),
    );
    await runJob(jobRow({ type: "enrich_species", payload: { codes: ["margod"] } }), ctx);
    expect(mocks.scheduleRetry).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleRetry.mock.calls[0][2]).toBe(90_000);
  });

  it("terminal no_mapping/no_sitelink stamp the freshness clock (CODEX1 P1 #1 — no scanner loop)", async () => {
    enrichMocks.fetchWikidataBatch.mockResolvedValue(
      new Map([["grycat", WD("grycat", null)]]) as never, // mapped, no sitelink
    );
    await runJob(
      jobRow({ type: "enrich_species", payload: { codes: ["grycat", "ghost1"] } }),
      ctx,
    );
    // Both terminal paths wrote the no_article clock stamp.
    const stamps = db.calls.filter((c) => c.text.includes("'no_article'"));
    expect(stamps.length).toBeGreaterThanOrEqual(2);
    expect(mocks.completeJob).toHaveBeenCalledTimes(1);
    expect(mocks.completeJob.mock.calls[0][2]).toMatchObject({ noMapping: 1, noSitelink: 1 });
  });

  it("cancel observed mid-chunk → cancelRunningJob with partial summary", async () => {
    enrichMocks.fetchWikidataBatch.mockResolvedValue(
      new Map([
        ["margod", WD("margod", "Marbled godwit")],
        ["grycat", WD("grycat", "Gray catbird")],
      ]) as never,
    );
    enrichMocks.fetchArticlePlaintext.mockResolvedValue({
      title: "T",
      revId: 1,
      extract: "p",
      sections: [],
    });
    mocks.updateProgress.mockResolvedValue({ cancelRequested: true });
    await runJob(
      jobRow({ type: "enrich_species", payload: { codes: ["margod", "grycat"] } }),
      ctx,
    );
    expect(mocks.cancelRunningJob).toHaveBeenCalledTimes(1);
    expect(enrichMocks.fetchArticlePlaintext).toHaveBeenCalledTimes(1); // second unit never started
  });

  it("invalid payload (bad codes) → terminal failJob, no network", async () => {
    await runJob(
      jobRow({ type: "enrich_species", payload: { codes: ['evil"} UNION'] } }),
      ctx,
    );
    expect(mocks.failJob).toHaveBeenCalledTimes(1);
    expect(enrichMocks.fetchWikidataBatch).not.toHaveBeenCalled();
  });

  it("scan_enrichment enqueues bounded content-hashed chunks and reschedules FAST while work remains", async () => {
    const codes = Array.from({ length: 70 }, (_, i) => `spcode${i}`);
    db.handler = (text, params) => {
      if (text.includes("se.media_status IS NULL")) {
        expect(params).toEqual([false]);
        return { rows: [] };
      }
      if (text.includes("FROM taxonomy_cache tc"))
        return { rows: codes.map((c) => ({ species_code: c })) };
      if (text.includes("FROM users WHERE role = 'admin'")) return { rows: [{ id: 1 }] };
      return undefined;
    };
    await runJob(jobRow({ type: "scan_enrichment", payload: {} }), ctx);
    // 70 codes → 3 chunks (30/30/10), each with a distinct content-hash key.
    expect(mocks.enqueueJob).toHaveBeenCalledTimes(3);
    const keys = mocks.enqueueJob.mock.calls.map(
      (c) => (c[0] as { dedupKey: string }).dedupKey,
    );
    expect(new Set(keys).size).toBe(3);
    for (const k of keys) expect(k).toMatch(/^enrich_species:[0-9a-f]{16}$/);
    const sizes = mocks.enqueueJob.mock.calls.map(
      (c) => ((c[0] as { payload: { codes: string[] } }).payload.codes ?? []).length,
    );
    expect(sizes).toEqual([30, 30, 10]);
    // Successor scheduled at the drain cadence (backlog exists).
    expect(mocks.terminalizeAndReschedule).toHaveBeenCalledTimes(1);
    const successor = mocks.terminalizeAndReschedule.mock.calls[0][3] as {
      runAfterMs: number;
    };
    expect(successor.runAfterMs).toBe(ENRICH_SCAN_DRAIN_MS);
  });

  it("scan cap accounting counts REPRESENTED CODES across mixed partitions, not chunks×30 (CODEX1)", async () => {
    // 1 wiki-due code + 240 AI-due codes at cap 8: chunks = 1 wiki (1 code)
    // + 7 AI (210 codes) → covered 211, remaining 30 — the old arithmetic
    // reported remaining=1.
    const aiCodes = Array.from({ length: 240 }, (_, i) => `aidue${String(i).padStart(3, "0")}`);
    db.handler = (text) => {
      if (text.includes("se.ai_status IS NULL"))
        return { rows: aiCodes.map((c) => ({ species_code: c })) };
      if (text.includes("se.media_status IS NULL")) return { rows: [] };
      if (text.includes("FROM taxonomy_cache tc"))
        return { rows: [{ species_code: "wikidue1" }] };
      if (text.includes("FROM users WHERE role = 'admin'")) return { rows: [{ id: 1 }] };
      return undefined;
    };
    await runJob(jobRow({ type: "scan_enrichment", payload: {} }), ctx);
    expect(mocks.enqueueJob).toHaveBeenCalledTimes(8);
    const result = (mocks.terminalizeAndReschedule.mock.calls[0][2] as {
      result: { candidates: number; remaining: number; chunksEnqueued: number };
    }).result;
    expect(result.candidates).toBe(241);
    expect(result.chunksEnqueued).toBe(8);
    expect(result.remaining).toBe(30);
  });

  it("scan with nothing to do → zero chunks, successor at the DAILY cadence", async () => {
    db.handler = (text) => {
      if (text.includes("FROM taxonomy_cache tc")) return { rows: [] };
      if (text.includes("FROM users WHERE role = 'admin'")) return { rows: [{ id: 1 }] };
      return undefined;
    };
    await runJob(jobRow({ type: "scan_enrichment", payload: {} }), ctx);
    expect(mocks.enqueueJob).not.toHaveBeenCalled();
    const successor = mocks.terminalizeAndReschedule.mock.calls[0][3] as {
      runAfterMs: number;
    };
    expect(successor.runAfterMs).toBe(ENRICH_SCAN_IDLE_MS);
  });

  it("recurring scan selects due media with normal backoff semantics", async () => {
    db.handler = (text, params) => {
      if (text.includes("se.ai_status IS NULL")) return { rows: [] };
      if (text.includes("se.media_status IS NULL")) {
        expect(params).toEqual([false]);
        return { rows: [{ species_code: "melthr" }] };
      }
      if (text.includes("FROM taxonomy_cache tc")) return { rows: [] };
      if (text.includes("FROM users WHERE role = 'admin'")) return { rows: [{ id: 1 }] };
      return undefined;
    };

    await runJob(jobRow({ type: "scan_enrichment", payload: {} }), ctx);

    const media = mocks.enqueueJob.mock.calls.find(
      (c) => (c[0] as { type: string }).type === "enrich_species_media",
    );
    expect(media).toBeDefined();
    expect(media![0]).toMatchObject({
      type: "enrich_species_media",
      payload: { codes: ["melthr"] },
    });
    expect((media![0] as { dedupKey: string }).dedupKey).toMatch(/^enrich_media:/);
    expect((media![0] as { payload: { force?: boolean } }).payload.force).toBeUndefined();
  });
});

const { EnrichmentAiError } = await import("./ai-enrichment");

describe("runJob — enrichment AI stage (plan Phase 2, td-47d6d5)", () => {
  const TAXA_ROW = {
    species_code: "margod",
    com_name: "Marbled Godwit",
    sci_name: "Limosa fedoa",
    family: "Scolopacidae",
  };
  const ANNOTATION = {
    tags: ["habitat:mudflat", "tide:falling"],
    fieldCraft: "Scan exposed flats on a falling tide.",
    droppedTags: [],
  };

  beforeEach(() => {
    enrichMocks.fetchWikidataBatch.mockReset();
    enrichMocks.fetchArticlePlaintext.mockReset();
    enrichMocks.generateSpeciesAnnotation.mockReset();
    db.handler = (text) => {
      if (text.includes("AS skip")) return { rows: [{ skip: false }] };
      if (text.includes("FROM taxonomy_cache WHERE species_code = ANY"))
        return { rows: [TAXA_ROW] };
      if (text.includes("FROM users WHERE role = 'admin'")) return { rows: [{ id: 1 }] };
      return undefined;
    };
    enrichMocks.fetchWikidataBatch.mockResolvedValue(
      new Map([
        [
          "margod",
          {
            speciesCode: "margod",
            qid: "Q1",
            enwikiTitle: "Marbled godwit",
            iucnStatus: null,
            massKgMin: null,
            massKgMax: null,
            wingspanMMin: null,
            wingspanMMax: null,
            inatTaxonId: null,
            xenoCantoId: null,
          },
        ],
      ]) as never,
    );
    enrichMocks.fetchArticlePlaintext.mockResolvedValue({
      title: "Marbled godwit",
      revId: 77,
      extract: "prose",
      sections: [],
    });
  });

  it("AI runs after a wiki fetch: annotation persisted with the source revision", async () => {
    enrichMocks.generateSpeciesAnnotation.mockResolvedValue(ANNOTATION);
    await runJob(jobRow({ type: "enrich_species", payload: { codes: ["margod"] } }), ctx);
    expect(enrichMocks.generateSpeciesAnnotation).toHaveBeenCalledTimes(1);
    const aiWrite = db.calls.find((c) => c.text.includes("field_craft = $2"));
    expect(aiWrite?.params?.slice(0, 3)).toEqual([
      "margod",
      "Scan exposed flats on a falling tide.",
      ["habitat:mudflat", "tide:falling"],
    ]);
    expect(aiWrite?.params?.[4]).toBe(77); // ai_source_rev_id = fetched revision
    expect(mocks.completeJob).toHaveBeenCalledTimes(1);
    expect(mocks.completeJob.mock.calls[0][2]).toMatchObject({ ok: 1, aiOk: 1, aiFailed: [] });
  });

  it("AI failure NEVER fails the unit or retries the job — ai_status carries the retry state", async () => {
    enrichMocks.generateSpeciesAnnotation.mockRejectedValue(
      new EnrichmentAiError("AI service error (500).", 500, false),
    );
    await runJob(jobRow({ type: "enrich_species", payload: { codes: ["margod"] } }), ctx);
    expect(db.calls.some((c) => c.text.includes("ai_status = 'error'"))).toBe(true);
    const oks = mocks.recordEvent.mock.calls.filter((c) => c[1] === "unit_ok");
    expect((oks[0][2] as { outcome: string }).outcome).toBe("ok"); // wiki unit still ok
    expect(mocks.completeJob).toHaveBeenCalledTimes(1);
    expect(mocks.completeJob.mock.calls[0][2]).toMatchObject({ aiFailed: ["margod"] });
    expect(mocks.scheduleRetry).not.toHaveBeenCalled();
  });

  it("Anthropic 429 stops AI for the batch; wiki work continues; no unit failures", async () => {
    enrichMocks.fetchWikidataBatch.mockResolvedValue(
      new Map([
        ["margod", { speciesCode: "margod", qid: "Q1", enwikiTitle: "A", iucnStatus: null, massKgMin: null, massKgMax: null, wingspanMMin: null, wingspanMMax: null, inatTaxonId: null, xenoCantoId: null }],
        ["grycat", { speciesCode: "grycat", qid: "Q2", enwikiTitle: "B", iucnStatus: null, massKgMin: null, massKgMax: null, wingspanMMin: null, wingspanMMax: null, inatTaxonId: null, xenoCantoId: null }],
      ]) as never,
    );
    db.handler = (text) => {
      if (text.includes("AS skip")) return { rows: [{ skip: false }] };
      if (text.includes("FROM taxonomy_cache WHERE species_code = ANY"))
        return { rows: [TAXA_ROW, { ...TAXA_ROW, species_code: "grycat" }] };
      if (text.includes("FROM users WHERE role = 'admin'")) return { rows: [{ id: 1 }] };
      return undefined;
    };
    enrichMocks.generateSpeciesAnnotation.mockRejectedValue(
      new EnrichmentAiError("AI service rate-limited.", 429, true),
    );
    await runJob(
      jobRow({ type: "enrich_species", payload: { codes: ["margod", "grycat"] } }),
      ctx,
    );
    // First 429 flips the batch flag — only ONE AI attempt total.
    expect(enrichMocks.generateSpeciesAnnotation).toHaveBeenCalledTimes(1);
    expect(mocks.completeJob).toHaveBeenCalledTimes(1);
    expect(mocks.completeJob.mock.calls[0][2]).toMatchObject({
      ok: 2,
      aiRateLimited: true,
      aiFailed: [],
    });
  });

  it("ai_only path: wiki-fresh unit with missing AI gets annotated WITHOUT a Wikipedia refetch", async () => {
    db.handler = (text) => {
      if (text.includes("AS skip")) return { rows: [{ skip: true }] }; // wiki fresh
      if (text.includes("FROM taxonomy_cache WHERE species_code = ANY"))
        return { rows: [TAXA_ROW] };
      if (text.includes("wiki_status = 'ok' AND wikipedia_extract IS NOT NULL"))
        return {
          rows: [
            {
              wikipedia_extract: "stored prose",
              wikipedia_sections: [],
              wikipedia_rev_id: "55",
              ai_status: null,
              ai_source_rev_id: null,
              ai_attempted_at: null,
            },
          ],
        };
      if (text.includes("FROM users WHERE role = 'admin'")) return { rows: [{ id: 1 }] };
      return undefined;
    };
    enrichMocks.generateSpeciesAnnotation.mockResolvedValue(ANNOTATION);
    await runJob(jobRow({ type: "enrich_species", payload: { codes: ["margod"] } }), ctx);
    expect(enrichMocks.fetchArticlePlaintext).not.toHaveBeenCalled();
    expect(enrichMocks.generateSpeciesAnnotation).toHaveBeenCalledTimes(1);
    const oks = mocks.recordEvent.mock.calls.filter((c) => c[1] === "unit_ok");
    expect((oks[0][2] as { outcome: string }).outcome).toBe("ai_only");
    const aiWrite = db.calls.find((c) => c.text.includes("field_craft = $2"));
    expect(aiWrite?.params?.[4]).toBe(55); // stored revision, not a refetch
  });

  it("wiki-fresh unit with FRESH AI stays a plain fresh skip", async () => {
    db.handler = (text) => {
      if (text.includes("AS skip")) return { rows: [{ skip: true }] };
      if (text.includes("FROM taxonomy_cache WHERE species_code = ANY"))
        return { rows: [TAXA_ROW] };
      if (text.includes("wiki_status = 'ok' AND wikipedia_extract IS NOT NULL"))
        return {
          rows: [
            {
              wikipedia_extract: "stored prose",
              wikipedia_sections: [],
              wikipedia_rev_id: "55",
              ai_status: "ok",
              ai_source_rev_id: "55",
              ai_attempted_at: null,
            },
          ],
        };
      if (text.includes("FROM users WHERE role = 'admin'")) return { rows: [{ id: 1 }] };
      return undefined;
    };
    await runJob(jobRow({ type: "enrich_species", payload: { codes: ["margod"] } }), ctx);
    expect(enrichMocks.generateSpeciesAnnotation).not.toHaveBeenCalled();
    const skips = mocks.recordEvent.mock.calls.filter((c) => c[1] === "unit_skipped");
    expect((skips[0][2] as { reason: string }).reason).toBe("fresh");
  });
});

describe("runJob — AI truthful accounting + aiOnly route (CODEX1 Phase-2 re-review)", () => {
  const TAXA_ROW = {
    species_code: "margod",
    com_name: "Marbled Godwit",
    sci_name: "Limosa fedoa",
    family: "Scolopacidae",
  };
  const ANNOTATION = {
    tags: ["habitat:mudflat", "tide:falling"],
    fieldCraft: "Scan exposed flats on a falling tide.",
    droppedTags: [],
  };
  /** Routing for a wiki-FRESH row whose AI is missing. */
  const freshAiDueDb = () => {
    db.handler = (text) => {
      if (text.includes("AS skip")) return { rows: [{ skip: true }] };
      if (text.includes("FROM taxonomy_cache WHERE species_code = ANY"))
        return { rows: [TAXA_ROW] };
      if (text.includes("wiki_status = 'ok' AND wikipedia_extract IS NOT NULL"))
        return {
          rows: [
            {
              wikipedia_extract: "stored prose",
              wikipedia_sections: [],
              wikipedia_rev_id: "55",
              ai_status: null,
              ai_source_rev_id: null,
              ai_attempted_at: null,
            },
          ],
        };
      if (text.includes("FROM users WHERE role = 'admin'")) return { rows: [{ id: 1 }] };
      return undefined;
    };
  };

  beforeEach(() => {
    enrichMocks.fetchWikidataBatch.mockReset();
    // Real contract: fetchWikidataBatch always returns a Map — a bare reset
    // returns undefined, which no caller has to survive.
    enrichMocks.fetchWikidataBatch.mockResolvedValue(new Map());
    enrichMocks.fetchWikidataBySciName.mockResolvedValue(new Map());
    enrichMocks.fetchArticlePlaintext.mockReset();
    enrichMocks.generateSpeciesAnnotation.mockReset();
  });

  it("fresh-wiki + AI 500: NO unit_ok, unit counted FAILED, narrowed aiOnly remediation enqueued", async () => {
    freshAiDueDb();
    enrichMocks.generateSpeciesAnnotation.mockRejectedValue(
      new EnrichmentAiError("AI service error (500).", 500, false),
    );
    await runJob(jobRow({ type: "enrich_species", payload: { codes: ["margod"] } }), ctx);
    // Truthful accounting: the attempted AI-only unit failed.
    expect(mocks.recordEvent.mock.calls.filter((c) => c[1] === "unit_ok")).toHaveLength(0);
    const fails = mocks.recordEvent.mock.calls.filter((c) => c[1] === "unit_failed");
    expect(fails).toHaveLength(1);
    expect((fails[0][2] as { stage: string }).stage).toBe("ai");
    // Wiki work is intact, so the row completes — but ONLY alongside the
    // durable narrowed remediation chunk.
    expect(mocks.completeJob).toHaveBeenCalledTimes(1);
    const remediation = mocks.enqueueJob.mock.calls.find(
      (c) => (c[0] as { payload: { aiOnly?: boolean } }).payload?.aiOnly === true,
    );
    expect(remediation).toBeDefined();
    expect((remediation![0] as { payload: { codes: string[] } }).payload.codes).toEqual([
      "margod",
    ]);
    expect((remediation![0] as { dedupKey: string }).dedupKey).toMatch(
      /^enrich_species_ai:[0-9a-f]{16}$/,
    );
  });

  it("fresh-wiki + first-call 429: unit parked (no unit_ok), remediation enqueued with the Retry-After delay", async () => {
    freshAiDueDb();
    enrichMocks.generateSpeciesAnnotation.mockRejectedValue(
      new EnrichmentAiError("AI service rate-limited.", 429, true, 120_000),
    );
    await runJob(jobRow({ type: "enrich_species", payload: { codes: ["margod"] } }), ctx);
    expect(mocks.recordEvent.mock.calls.filter((c) => c[1] === "unit_ok")).toHaveLength(0);
    const skips = mocks.recordEvent.mock.calls.filter((c) => c[1] === "unit_skipped");
    expect((skips[0][2] as { reason: string }).reason).toBe("ai_rate_limited");
    const remediation = mocks.enqueueJob.mock.calls.find(
      (c) => (c[0] as { payload: { aiOnly?: boolean } }).payload?.aiOnly === true,
    );
    expect((remediation![0] as { runAfterMs: number }).runAfterMs).toBe(120_000);
    expect(mocks.completeJob).toHaveBeenCalledTimes(1);
    expect(mocks.completeJob.mock.calls[0][2]).toMatchObject({
      aiPending: ["margod"],
      aiRateLimited: true,
    });
  });

  it("aiOnly happy path: stored prose annotated, NO WDQS, NO Wikipedia", async () => {
    freshAiDueDb();
    enrichMocks.generateSpeciesAnnotation.mockResolvedValue(ANNOTATION);
    await runJob(
      jobRow({ type: "enrich_species", payload: { codes: ["margod"], aiOnly: true } }),
      ctx,
    );
    expect(enrichMocks.fetchWikidataBatch).not.toHaveBeenCalled();
    expect(enrichMocks.fetchArticlePlaintext).not.toHaveBeenCalled();
    const oks = mocks.recordEvent.mock.calls.filter((c) => c[1] === "unit_ok");
    expect((oks[0][2] as { outcome: string }).outcome).toBe("ai_only");
    expect(mocks.completeJob).toHaveBeenCalledTimes(1);
    expect(mocks.completeJob.mock.calls[0][2]).toMatchObject({ aiOk: 1, aiFailed: [] });
  });

  it("aiOnly with ERROR rows: always due (no 7d wait) — the job exists because they failed", async () => {
    db.handler = (text) => {
      if (text.includes("FROM taxonomy_cache WHERE species_code = ANY"))
        return { rows: [TAXA_ROW] };
      if (text.includes("wiki_status = 'ok' AND wikipedia_extract IS NOT NULL"))
        return {
          rows: [
            {
              wikipedia_extract: "stored prose",
              wikipedia_sections: [],
              wikipedia_rev_id: "55",
              ai_status: "error",
              ai_source_rev_id: null,
              ai_attempted_at: new Date().toISOString(), // JUST failed
            },
          ],
        };
      if (text.includes("FROM users WHERE role = 'admin'")) return { rows: [{ id: 1 }] };
      return undefined;
    };
    enrichMocks.generateSpeciesAnnotation.mockResolvedValue(ANNOTATION);
    await runJob(
      jobRow({ type: "enrich_species", payload: { codes: ["margod"], aiOnly: true } }),
      ctx,
    );
    expect(enrichMocks.generateSpeciesAnnotation).toHaveBeenCalledTimes(1);
    expect(mocks.completeJob).toHaveBeenCalledTimes(1);
  });

  it("aiOnly all-fail → scheduleRetry with transient backoff; exhaustion → failJob", async () => {
    freshAiDueDb();
    enrichMocks.generateSpeciesAnnotation.mockRejectedValue(
      new EnrichmentAiError("AI service error (500).", 500, false),
    );
    await runJob(
      jobRow({ type: "enrich_species", payload: { codes: ["margod"], aiOnly: true } }),
      ctx,
    );
    expect(mocks.scheduleRetry).toHaveBeenCalledTimes(1);
    expect(mocks.completeJob).not.toHaveBeenCalled();

    mocks.scheduleRetry.mockClear();
    await runJob(
      jobRow({
        type: "enrich_species",
        payload: { codes: ["margod"], aiOnly: true },
        attempts: 4,
      }),
      ctx,
    );
    expect(mocks.failJob).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleRetry).not.toHaveBeenCalled();
  });

  it("aiOnly 429 → scheduleRetry honoring Retry-After (durable rate-limit ownership)", async () => {
    freshAiDueDb();
    enrichMocks.generateSpeciesAnnotation.mockRejectedValue(
      new EnrichmentAiError("AI service rate-limited.", 429, true, 90_000),
    );
    await runJob(
      jobRow({ type: "enrich_species", payload: { codes: ["margod"], aiOnly: true } }),
      ctx,
    );
    expect(mocks.scheduleRetry).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleRetry.mock.calls[0][2]).toBe(90_000);
    expect(mocks.completeJob).not.toHaveBeenCalled();
  });

  it("scanner partitions: wiki-due → normal chunks, AI-due → aiOnly chunks with distinct keys", async () => {
    db.handler = (text) => {
      // enrichmentScope + wikiStaleCodes both hit taxonomy_cache tc; aiDueCodes too.
      if (text.includes("se.ai_status IS NULL"))
        return { rows: [{ species_code: "aidue1" }, { species_code: "aidue2" }] };
      if (text.includes("se.media_status IS NULL")) return { rows: [] };
      if (text.includes("FROM taxonomy_cache tc"))
        return { rows: [{ species_code: "wikidue1" }] };
      if (text.includes("FROM users WHERE role = 'admin'")) return { rows: [{ id: 1 }] };
      return undefined;
    };
    await runJob(jobRow({ type: "scan_enrichment", payload: {} }), ctx);
    const payloads = mocks.enqueueJob.mock.calls.map((c) => c[0] as {
      type: string;
      payload: { codes: string[]; aiOnly?: boolean };
      dedupKey: string;
    });
    const wiki = payloads.filter((p) => p.type === "enrich_species" && !p.payload.aiOnly);
    const ai = payloads.filter((p) => p.payload.aiOnly);
    expect(wiki).toHaveLength(1);
    expect(wiki.flatMap((p) => p.payload.codes)).toContain("wikidue1");
    expect(ai.flatMap((p) => p.payload.codes)).toEqual(["aidue1", "aidue2"]);
    for (const p of ai) expect(p.dedupKey).toMatch(/^enrich_species_ai:/);
  });
});

describe("runJob — aiOnly route holes (CODEX1 Phase-2 round 2)", () => {
  const TAXA_ROW = {
    species_code: "margod",
    com_name: "Marbled Godwit",
    sci_name: "Limosa fedoa",
    family: "Scolopacidae",
  };
  const AI_INPUT_ROW = {
    wikipedia_extract: "stored prose",
    wikipedia_sections: [],
    wikipedia_rev_id: "55",
    ai_status: null,
    ai_source_rev_id: null,
    ai_attempted_at: null,
  };
  const ANNOTATION = {
    tags: ["habitat:mudflat"],
    fieldCraft: "Craft.",
    droppedTags: [],
  };

  beforeEach(() => {
    enrichMocks.fetchWikidataBatch.mockReset();
    enrichMocks.fetchArticlePlaintext.mockReset();
    enrichMocks.generateSpeciesAnnotation.mockReset();
  });

  it("aiOnly wall-budget spillover PRESERVES the route: aiOnly payload + enrich_species_ai key, no WDQS/Wikipedia", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      db.handler = (text) => {
        if (text.includes("FROM taxonomy_cache WHERE species_code = ANY"))
          return { rows: [TAXA_ROW, { ...TAXA_ROW, species_code: "grycat" }] };
        if (text.includes("wiki_status = 'ok' AND wikipedia_extract IS NOT NULL"))
          return { rows: [AI_INPUT_ROW] };
        if (text.includes("FROM users WHERE role = 'admin'")) return { rows: [{ id: 1 }] };
        return undefined;
      };
      // First AI call succeeds but burns past the wall budget.
      enrichMocks.generateSpeciesAnnotation.mockImplementationOnce(async () => {
        vi.setSystemTime(Date.now() + 11 * 60_000);
        return ANNOTATION;
      });
      await runJob(
        jobRow({ type: "enrich_species", payload: { codes: ["margod", "grycat"], aiOnly: true } }),
        ctx,
      );
      expect(enrichMocks.fetchWikidataBatch).not.toHaveBeenCalled();
      expect(enrichMocks.fetchArticlePlaintext).not.toHaveBeenCalled();
      const spill = mocks.enqueueJob.mock.calls.find((c) =>
        ((c[0] as { label: string }).label ?? "").includes("spillover"),
      );
      expect(spill).toBeDefined();
      const arg = spill![0] as { payload: { codes: string[]; aiOnly?: boolean }; dedupKey: string };
      expect(arg.payload.aiOnly).toBe(true);
      expect(arg.payload.codes).toEqual(["grycat"]);
      expect(arg.dedupKey).toMatch(/^enrich_species_ai:[0-9a-f]{16}$/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aiOnly unexpected input-read failure = AI-stage failure: no wiki-error stamp, no green complete", async () => {
    db.handler = (text) => {
      if (text.includes("FROM taxonomy_cache WHERE species_code = ANY"))
        return { rows: [TAXA_ROW] };
      if (text.includes("wiki_status = 'ok' AND wikipedia_extract IS NOT NULL"))
        throw new Error("db read exploded");
      if (text.includes("FROM users WHERE role = 'admin'")) return { rows: [{ id: 1 }] };
      return undefined;
    };
    await runJob(
      jobRow({ type: "enrich_species", payload: { codes: ["margod"], aiOnly: true } }),
      ctx,
    );
    // AI-stage failure, never a wiki one.
    expect(db.calls.some((c) => c.text.includes("wiki_status = 'error'"))).toBe(false);
    expect(db.calls.some((c) => c.text.includes("ai_status = 'error'"))).toBe(true);
    const fails = mocks.recordEvent.mock.calls.filter((c) => c[1] === "unit_failed");
    expect((fails[0][2] as { stage: string }).stage).toBe("ai");
    expect(mocks.completeJob).not.toHaveBeenCalled();
    expect(mocks.scheduleRetry).toHaveBeenCalledTimes(1);
  });
});

describe("runJob — species media enrichment (td-86a2b6)", () => {
  const QID = "Q123";
  const SCI = "Testus birdus";

  const PHOTO_INFO = {
    filename: "Test.jpg",
    url: "https://commons/x.jpg",
    thumbUrl: null,
    width: 100,
    height: 80,
    mimeType: "image/jpeg",
    artist: "A",
    licenseCode: "CC BY-SA 4.0",
    licenseUrl: "https://x",
    duration: null,
  };
  const SONG_REC = {
    xcId: "XC1",
    mediaUrl: "u",
    sourceUrl: "s",
    type: "song",
    quality: "A",
    duration: 10,
    recordist: "R",
    license: "CC BY-NC-SA 4.0",
    licenseUrl: "https://l",
    location: null,
  };
  const CALL_REC = { ...SONG_REC, xcId: "XC2", type: "call" };

  const mediaDb = (codes: string[]) => {
    db.handler = (text) => {
      if (text.includes("wikidata_qid FROM species_enrichment"))
        return {
          rows: codes.map((c) => ({ species_code: c, wikidata_qid: QID })),
        };
      if (text.includes("sci_name FROM taxonomy_cache"))
        return { rows: codes.map((c) => ({ species_code: c, sci_name: SCI })) };
      return undefined;
    };
  };

  beforeEach(() => {
    enrichMocks.fetchWikidataMedia.mockReset();
    enrichMocks.fetchCommonsFileInfo.mockReset();
    enrichMocks.fetchXenoCantoRecordings.mockReset();
  });

  it("invalid payload (empty / oversized) → fail, never calls any gateway", async () => {
    await runJob(jobRow({ type: "enrich_species_media", payload: { codes: [] } }), ctx);
    expect(mocks.failJob).toHaveBeenCalledTimes(1);
    expect(enrichMocks.fetchWikidataMedia).not.toHaveBeenCalled();

    mocks.failJob.mockClear();
    const tooMany = Array.from({ length: 21 }, (_, i) => `sp${String(i).padStart(2, "0")}`);
    await runJob(jobRow({ type: "enrich_species_media", payload: { codes: tooMany } }), ctx);
    expect(mocks.failJob).toHaveBeenCalledTimes(1);
    expect(enrichMocks.fetchWikidataMedia).not.toHaveBeenCalled();
  });

  it("happy path: Commons photo + xeno-canto song/call → complete as ok", async () => {
    mediaDb(["margod"]);
    enrichMocks.fetchWikidataMedia.mockResolvedValue(
      new Map([[QID, { qid: QID, imageFilename: "Test.jpg", audioFilename: null }]]),
    );
    enrichMocks.fetchCommonsFileInfo.mockResolvedValue(new Map([["Test.jpg", PHOTO_INFO]]));
    enrichMocks.fetchXenoCantoRecordings.mockResolvedValue({
      song: SONG_REC,
      call: CALL_REC,
      downloadsRestricted: false,
    });

    await runJob(jobRow({ type: "enrich_species_media", payload: { codes: ["margod"] } }), ctx);

    expect(mocks.completeJob).toHaveBeenCalledTimes(1);
    expect(mocks.completeJob.mock.calls[0][2]).toMatchObject({
      ok: 1,
      partial: 0,
      noMedia: 0,
      failed: [],
    });
    const oks = mocks.recordEvent.mock.calls.filter((c) => c[1] === "unit_ok");
    expect(oks[0][2]).toMatchObject({ code: "margod", outcome: "ok" });
  });

  it("missing xeno-canto key → partial, not error; Commons photo still counted", async () => {
    mediaDb(["margod"]);
    enrichMocks.fetchWikidataMedia.mockResolvedValue(
      new Map([[QID, { qid: QID, imageFilename: "Test.jpg", audioFilename: null }]]),
    );
    enrichMocks.fetchCommonsFileInfo.mockResolvedValue(new Map([["Test.jpg", PHOTO_INFO]]));
    enrichMocks.fetchXenoCantoRecordings.mockRejectedValue(
      new XenoCantoError("xeno-canto API key not configured", 0, false),
    );

    await runJob(jobRow({ type: "enrich_species_media", payload: { codes: ["margod"] } }), ctx);

    expect(mocks.completeJob).toHaveBeenCalledTimes(1);
    expect(mocks.completeJob.mock.calls[0][2]).toMatchObject({
      ok: 0,
      partial: 1,
      noMedia: 0,
      failed: [],
    });
    expect(mocks.recordEvent.mock.calls.some((c) => c[1] === "unit_failed")).toBe(false);
  });

  it("both sources answer empty → no_media, job still completes (not failed)", async () => {
    mediaDb(["margod"]);
    enrichMocks.fetchWikidataMedia.mockResolvedValue(new Map());
    enrichMocks.fetchCommonsFileInfo.mockResolvedValue(new Map());
    enrichMocks.fetchXenoCantoRecordings.mockResolvedValue({
      song: null,
      call: null,
      downloadsRestricted: false,
    });

    await runJob(jobRow({ type: "enrich_species_media", payload: { codes: ["margod"] } }), ctx);

    expect(mocks.completeJob).toHaveBeenCalledTimes(1);
    expect(mocks.completeJob.mock.calls[0][2]).toMatchObject({
      ok: 0,
      partial: 0,
      noMedia: 1,
    });
  });

  it("no QID on a code → unit_skipped 'no-qid', never calls a media gateway for it", async () => {
    db.handler = (text) => {
      if (text.includes("wikidata_qid FROM species_enrichment")) return { rows: [] };
      if (text.includes("sci_name FROM taxonomy_cache"))
        return { rows: [{ species_code: "margod", sci_name: SCI }] };
      return undefined;
    };
    await runJob(jobRow({ type: "enrich_species_media", payload: { codes: ["margod"] } }), ctx);
    expect(enrichMocks.fetchWikidataMedia).not.toHaveBeenCalled();
    const skips = mocks.recordEvent.mock.calls.filter((c) => c[1] === "unit_skipped");
    expect(skips[0][2]).toMatchObject({ code: "margod", reason: "no-qid" });
    expect(mocks.completeJob).toHaveBeenCalledTimes(1);
  });

  it("freshness skip on non-force; force bypasses it", async () => {
    db.handler = (text) => {
      if (text.includes("wikidata_qid FROM species_enrichment"))
        return { rows: [{ species_code: "margod", wikidata_qid: QID }] };
      if (text.includes("sci_name FROM taxonomy_cache"))
        return { rows: [{ species_code: "margod", sci_name: SCI }] };
      if (text.includes("media_status IN")) return { rows: [{ fresh: true }] };
      return undefined;
    };
    await runJob(jobRow({ type: "enrich_species_media", payload: { codes: ["margod"] } }), ctx);
    expect(enrichMocks.fetchWikidataMedia).not.toHaveBeenCalled();
    expect(mocks.completeJob.mock.calls[0][2]).toMatchObject({ fresh: 1 });

    mocks.completeJob.mockClear();
    enrichMocks.fetchWikidataMedia.mockResolvedValue(new Map());
    enrichMocks.fetchCommonsFileInfo.mockResolvedValue(new Map());
    enrichMocks.fetchXenoCantoRecordings.mockResolvedValue({
      song: null,
      call: null,
      downloadsRestricted: false,
    });
    await runJob(
      jobRow({
        type: "enrich_species_media",
        payload: { codes: ["margod"], force: true },
      }),
      ctx,
    );
    expect(enrichMocks.fetchWikidataMedia).toHaveBeenCalled();
    expect(mocks.completeJob.mock.calls[0][2]).toMatchObject({ noMedia: 1 });
  });

  it("rate limit on any provider → scheduleRetry with its Retry-After, no spillover enqueue", async () => {
    mediaDb(["margod", "grycat"]);
    enrichMocks.fetchWikidataMedia.mockRejectedValueOnce(
      new WikidataError("Wikidata query failed (HTTP 429)", 429, true, 12_345),
    );
    await runJob(
      jobRow({
        type: "enrich_species_media",
        payload: { codes: ["margod", "grycat"] },
      }),
      ctx,
    );
    expect(mocks.scheduleRetry).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleRetry.mock.calls[0][2]).toBe(12_345);
    expect(mocks.completeJob).not.toHaveBeenCalled();
    expect(
      mocks.enqueueJob.mock.calls.some(
        (c) => (c[0] as { type: string }).type === "enrich_species_media",
      ),
    ).toBe(false);
  });

  it("Commons rate limit is ALSO classified as a rate-limit stop (any provider, not just Wikidata)", async () => {
    mediaDb(["margod"]);
    enrichMocks.fetchWikidataMedia.mockResolvedValue(
      new Map([[QID, { qid: QID, imageFilename: "Test.jpg", audioFilename: null }]]),
    );
    enrichMocks.fetchCommonsFileInfo.mockRejectedValue(
      new CommonsError("Commons imageinfo query failed (HTTP 429)", 429, true, 60_000),
    );
    await runJob(jobRow({ type: "enrich_species_media", payload: { codes: ["margod"] } }), ctx);
    expect(mocks.scheduleRetry).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleRetry.mock.calls[0][2]).toBe(60_000);
  });

  it("xeno-canto rate limit is not downgraded to partial and honors Retry-After", async () => {
    mediaDb(["margod"]);
    enrichMocks.fetchWikidataMedia.mockResolvedValue(new Map());
    enrichMocks.fetchCommonsFileInfo.mockResolvedValue(new Map());
    enrichMocks.fetchXenoCantoRecordings.mockRejectedValue(
      new XenoCantoError("xeno-canto query failed (HTTP 429)", 429, true, 45_000),
    );
    await runJob(jobRow({ type: "enrich_species_media", payload: { codes: ["margod"] } }), ctx);
    expect(mocks.scheduleRetry).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleRetry.mock.calls[0][2]).toBe(45_000);
    expect(mocks.completeJob).not.toHaveBeenCalled();
  });

  it("wall budget → spillover chunk preserves the un-started remainder", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      mediaDb(["margod", "grycat"]);
      enrichMocks.fetchWikidataMedia.mockImplementation(async () => {
        vi.setSystemTime(Date.now() + 9 * 60_000); // past MEDIA_WALL_BUDGET_MS (8 min)
        return new Map();
      });
      enrichMocks.fetchCommonsFileInfo.mockResolvedValue(new Map());
      enrichMocks.fetchXenoCantoRecordings.mockResolvedValue({
        song: null,
        call: null,
        downloadsRestricted: false,
      });
      await runJob(
        jobRow({
          type: "enrich_species_media",
          payload: { codes: ["margod", "grycat"] },
        }),
        ctx,
      );
      const spill = mocks.enqueueJob.mock.calls.find(
        (c) => (c[0] as { type: string }).type === "enrich_species_media",
      );
      expect(spill).toBeDefined();
      const arg = spill![0] as {
        payload: { codes: string[] };
        dedupKey: string;
      };
      expect(arg.payload.codes).toEqual(["grycat"]);
      expect(arg.dedupKey).toMatch(/^enrich_media:[0-9a-f]{16}$/);
      expect(mocks.completeJob).toHaveBeenCalledTimes(1);
      expect(mocks.completeJob.mock.calls[0][2]).toMatchObject({ noMedia: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("drain mid-chunk → requeueInterrupted, never completes", async () => {
    mediaDb(["margod"]);
    const drainCtx = { isDraining: () => true };
    await runJob(
      jobRow({ type: "enrich_species_media", payload: { codes: ["margod"] } }),
      drainCtx,
    );
    expect(mocks.requeueInterrupted).toHaveBeenCalledTimes(1);
    expect(mocks.completeJob).not.toHaveBeenCalled();
  });

  it("cancel observed mid-chunk → cancelRunningJob only, remaining code untouched", async () => {
    mediaDb(["margod", "grycat"]);
    enrichMocks.fetchWikidataMedia.mockResolvedValue(new Map());
    enrichMocks.fetchCommonsFileInfo.mockResolvedValue(new Map());
    enrichMocks.fetchXenoCantoRecordings.mockResolvedValue({
      song: null,
      call: null,
      downloadsRestricted: false,
    });
    mocks.updateProgress.mockResolvedValue({ cancelRequested: true });
    await runJob(
      jobRow({
        type: "enrich_species_media",
        payload: { codes: ["margod", "grycat"] },
      }),
      ctx,
    );
    expect(mocks.cancelRunningJob).toHaveBeenCalledTimes(1);
    expect(mocks.completeJob).not.toHaveBeenCalled();
    expect(enrichMocks.fetchWikidataMedia).toHaveBeenCalledTimes(1); // only margod attempted
  });

  it("non-rate-limit error → markMediaError write with sanitized text, unit failed, row retries", async () => {
    mediaDb(["margod"]);
    enrichMocks.fetchWikidataMedia.mockRejectedValue(new Error("boom api_key=SECRET123"));
    await runJob(jobRow({ type: "enrich_species_media", payload: { codes: ["margod"] } }), ctx);
    expect(JSON.stringify(mocks.recordEvent.mock.calls)).not.toContain("SECRET123");
    expect(JSON.stringify(db.calls)).not.toContain("SECRET123");
    expect(db.calls.some((c) => c.text.includes("media_status = 'error'"))).toBe(true);
    expect(mocks.scheduleRetry).toHaveBeenCalledTimes(1);
    expect(mocks.completeJob).not.toHaveBeenCalled();
  });
});

describe("nudgeEnrichmentScan (admin impatient nudge — direct enqueue)", () => {
  const scopeDb = (codes: string[]) => {
    db.handler = (text) => {
      if (text.includes("se.ai_status IS NULL")) return { rows: [] };
      if (text.includes("se.media_status IS NULL")) return { rows: [] };
      if (text.includes("FROM taxonomy_cache tc"))
        return { rows: codes.map((c) => ({ species_code: c })) };
      if (text.includes("FROM users WHERE role = 'admin'")) return { rows: [{ id: 1 }] };
      return undefined;
    };
  };

  it("enqueues due work DIRECTLY — deterministic even while a scan is running with a stale snapshot (CODEX1)", async () => {
    // No pending scan row to nudge (a scan is 'running' elsewhere) — the
    // nudge must not depend on it: fresh scope still gets queued NOW.
    scopeDb(["newsp1", "newsp2"]);
    const summary = await nudgeEnrichmentScan();
    expect(summary.candidates).toBe(2);
    expect(summary.chunksEnqueued).toBe(1);
    const chunk = mocks.enqueueJob.mock.calls.find(
      (c) => (c[0] as { type: string }).type === "enrich_species",
    );
    expect((chunk![0] as { payload: { codes: string[] } }).payload.codes).toEqual([
      "newsp1",
      "newsp2",
    ]);
    expect((chunk![0] as { dedupKey: string }).dedupKey).toMatch(/^enrich_species:[0-9a-f]{16}$/);
  });

  it("collision-safe: identical chunk already queued by the scan → deduped, counted honestly", async () => {
    scopeDb(["newsp1", "newsp2"]);
    mocks.enqueueJob.mockResolvedValueOnce({ jobId: 7, deduped: true });
    const summary = await nudgeEnrichmentScan();
    expect(summary.chunksEnqueued).toBe(0);
    expect(summary.deduped).toBe(1);
  });

  it("UNCAPPED: >8-chunks of fresh scope is FULLY enqueued before returning — no remainder to race a stale scan's 24h successor (CODEX1)", async () => {
    const codes = Array.from({ length: 300 }, (_, i) => `spx${String(i).padStart(3, "0")}`);
    scopeDb(codes);
    const summary = await nudgeEnrichmentScan();
    expect(summary.candidates).toBe(300);
    expect(summary.chunksEnqueued).toBe(10); // 300/30 — past the scan's cap of 8
    expect(summary.remaining).toBe(0);
    expect(mocks.enqueueJob).toHaveBeenCalledTimes(10);
  });

  it("nothing due → zero chunks, zero candidates; pending scan timer still pulled (cadence assist)", async () => {
    let timerPulled = false;
    db.handler = (text) => {
      if (text.includes("se.ai_status IS NULL")) return { rows: [] };
      if (text.includes("FROM taxonomy_cache tc")) return { rows: [] };
      if (text.includes("FROM users WHERE role = 'admin'")) return { rows: [{ id: 1 }] };
      if (text.includes("UPDATE jobs SET next_retry_at = NOW()")) {
        timerPulled = true;
        return { rows: [] };
      }
      return undefined;
    };
    const summary = await nudgeEnrichmentScan();
    expect(summary.candidates).toBe(0);
    expect(mocks.enqueueJob).not.toHaveBeenCalled();
    expect(timerPulled).toBe(true);
  });

  it("explicit admin scan immediately retries a recent partial media failure with force", async () => {
    db.handler = (text, params) => {
      if (text.includes("se.ai_status IS NULL")) return { rows: [] };
      if (text.includes("se.media_status IS NULL")) {
        expect(params).toEqual([true]);
        return { rows: [{ species_code: "melthr" }] };
      }
      if (text.includes("FROM taxonomy_cache tc")) return { rows: [] };
      if (text.includes("FROM users WHERE role = 'admin'")) return { rows: [{ id: 1 }] };
      return undefined;
    };

    const summary = await nudgeEnrichmentScan();
    expect(summary).toMatchObject({ candidates: 1, mediaCandidates: 1, chunksEnqueued: 1 });
    const chunk = mocks.enqueueJob.mock.calls.find(
      (c) => (c[0] as { type: string }).type === "enrich_species_media",
    );
    expect((chunk![0] as { payload: { codes: string[]; force: boolean } }).payload).toEqual({
      codes: ["melthr"],
      force: true,
    });
    expect((chunk![0] as { dedupKey: string }).dedupKey).toMatch(/^enrich_media_force:/);
  });

  it("queues media repair even when the same species also needs wiki enrichment", async () => {
    db.handler = (text) => {
      if (text.includes("se.ai_status IS NULL")) return { rows: [] };
      if (text.includes("se.media_status IS NULL")) {
        return { rows: [{ species_code: "melthr" }] };
      }
      if (text.includes("FROM taxonomy_cache tc")) {
        return { rows: [{ species_code: "melthr" }] };
      }
      if (text.includes("FROM users WHERE role = 'admin'")) return { rows: [{ id: 1 }] };
      return undefined;
    };

    const summary = await nudgeEnrichmentScan();
    expect(summary).toMatchObject({
      candidates: 2,
      wikiCandidates: 1,
      mediaCandidates: 1,
      chunksEnqueued: 2,
    });
    expect(
      mocks.enqueueJob.mock.calls.map((c) => (c[0] as { type: string }).type),
    ).toEqual(["enrich_species", "enrich_species_media"]);
    const media = mocks.enqueueJob.mock.calls.find(
      (c) => (c[0] as { type: string }).type === "enrich_species_media",
    );
    expect((media![0] as { payload: { force: boolean } }).payload.force).toBe(true);
  });
});

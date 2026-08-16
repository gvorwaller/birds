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
}));

vi.mock("$server/jobs", () => ({
  recordEvent: mocks.recordEvent,
  updateProgress: mocks.updateProgress,
  completeJob: mocks.completeJob,
  failJob: mocks.failJob,
  cancelRunningJob: mocks.cancelRunningJob,
  scheduleRetry: mocks.scheduleRetry,
  requeueInterrupted: mocks.requeueInterrupted,
  enqueueJob: mocks.enqueueJob,
  hasActiveJob: mocks.hasActiveJob,
  terminalizeAndReschedule: mocks.terminalizeAndReschedule,
}));

const db = vi.hoisted(() => {
  const state = {
    handler: null as null | ((text: string, params?: unknown[]) => { rows: unknown[] } | undefined),
    calls: [] as { text: string; params: unknown[] }[],
  };
  return state;
});

vi.mock("$lib/db", () => ({
  query: vi.fn(async (text: string, params?: unknown[]) => {
    db.calls.push({ text, params: params ?? [] });
    return db.handler?.(text, params) ?? { rows: [] };
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
    sendNtfy: vi.fn<(...a: unknown[]) => Promise<void>>(async () => {}),
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
vi.mock("$server/ntfy", () => ({
  sendNtfy: syncMocks.sendNtfy,
}));
vi.mock("$server/crypto", () => ({
  decryptSecret: (v: string) => v.replace(/^enc-/, ""),
  encryptSecret: (v: string) => `enc-${v}`,
}));

const { runJob, ensureNeedAlertScan } = await import("./job-handlers");
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
    expect(syncMocks.syncLifeListFromEbird).toHaveBeenCalledWith(7);
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

describe("runJob — scan_need_alerts (plan Part A)", () => {
  const SECRET = "gv-birds-x7Qp29rTmZ";
  const HOME = { home_lat: 27.77, home_lon: -82.64 };
  const PREF_ROW = {
    user_id: 3,
    ntfy_topic_enc: `enc-${SECRET}`,
    radius_km: 40,
    realert_days: 7,
    ...HOME,
  };
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

  function scanDb(prefs: unknown[], sent: unknown[] = []) {
    db.handler = (text) => {
      if (text.includes("FROM user_alert_prefs p JOIN users")) return { rows: prefs };
      if (text.includes("FROM need_alerts_sent")) return { rows: sent };
      if (text.includes("FROM users WHERE role = 'admin'")) return { rows: [{ id: 1 }] };
      return undefined;
    };
  }

  it("happy path: push sent with ABSOLUTE click URL, sent-row upserted, successor scheduled", async () => {
    scanDb([PREF_ROW]);
    syncMocks.notableNearbyObs.mockResolvedValue({
      data: [NOTABLE],
      fetchedAt: new Date(),
      stale: false,
    });
    await runJob(jobRow({ type: "scan_need_alerts", payload: {} }), ctx);

    expect(syncMocks.sendNtfy).toHaveBeenCalledTimes(1);
    const [topic, msg] = syncMocks.sendNtfy.mock.calls[0] as unknown as [
      string,
      { title: string; clickUrl: string },
    ];
    expect(topic).toBe(SECRET);
    expect(msg.title).toBe("Lifer nearby: Snail Kite");
    expect(msg.clickUrl).toMatch(/^https:\/\/.+\/forecast\/species\?species=snakit$/);
    // Sent-row upsert happened AFTER the send (at-least-once, CODEX1 #3).
    const upsert = db.calls.find((c) => c.text.includes("INSERT INTO need_alerts_sent"));
    expect(upsert?.params).toEqual([3, "snakit", "L9", "2026-08-16 14:40", "S555"]);
    // Atomic handoff with the 30-min successor.
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
    expect(mocks.completeJob).not.toHaveBeenCalled(); // handoff owns terminalization
  });

  it("STALE cache never notifies — unit_skipped and retried next scan (CODEX1 #4)", async () => {
    scanDb([PREF_ROW]);
    syncMocks.notableNearbyObs.mockResolvedValue({
      data: [NOTABLE],
      fetchedAt: new Date(Date.now() - 3 * 60 * 60_000),
      stale: true,
    });
    await runJob(jobRow({ type: "scan_need_alerts", payload: {} }), ctx);
    expect(syncMocks.sendNtfy).not.toHaveBeenCalled();
    const skips = mocks.recordEvent.mock.calls.filter((c) => c[1] === "unit_skipped");
    expect(skips).toHaveLength(1);
    expect((skips[0][2] as { reason: string }).reason).toBe("stale-cache");
    // All-skipped (no eligible) still completes + reschedules.
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
    expect(syncMocks.sendNtfy).not.toHaveBeenCalled();
  });

  it("EVERY eligible user failing takes the retry schedule, not success (CODEX1 #5)", async () => {
    scanDb([PREF_ROW]);
    syncMocks.notableNearbyObs.mockRejectedValue(new Error("eBird 502"));
    await runJob(jobRow({ type: "scan_need_alerts", payload: {} }), ctx);
    expect(mocks.scheduleRetry).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleRetry.mock.calls[0][2]).toBe(TRANSIENT_RETRY_DELAYS_MS[0]);
    expect(mocks.terminalizeAndReschedule).not.toHaveBeenCalled(); // dedup key held by waiting_retry
  });

  it("at-least-once crash window: send succeeded, record failed → user unit_failed, scan survives", async () => {
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
    expect(syncMocks.sendNtfy).toHaveBeenCalledTimes(1); // push went out
    const fails = mocks.recordEvent.mock.calls.filter((c) => c[1] === "unit_failed");
    expect(fails).toHaveLength(1);
    // Aggregate rule → retry (the only eligible user failed).
    expect(mocks.scheduleRetry).toHaveBeenCalledTimes(1);
  });

  it("budget covers PRE-SEND work: a hung notable fetch fails the user, scan survives (CODEX1)", async () => {
    vi.useFakeTimers();
    try {
      scanDb([PREF_ROW, { ...PREF_ROW, user_id: 4 }]);
      // User 3's fetch hangs forever; user 4 is healthy.
      syncMocks.notableNearbyObs
        .mockImplementationOnce(() => new Promise(() => {}))
        .mockResolvedValueOnce({ data: [NOTABLE], fetchedAt: new Date(), stale: false });
      const p = runJob(jobRow({ type: "scan_need_alerts", payload: {} }), ctx);
      await vi.advanceTimersByTimeAsync(61_000);
      await p;
      const fails = mocks.recordEvent.mock.calls.filter((c) => c[1] === "unit_failed");
      expect(fails).toHaveLength(1);
      expect((fails[0][2] as { budget?: boolean }).budget).toBe(true);
      // The healthy user still ran and alerted — no starvation.
      expect(syncMocks.sendNtfy).toHaveBeenCalledTimes(1);
      expect(mocks.terminalizeAndReschedule).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("mid-candidate expiry: ACTUAL sends counted, not the candidate list (CODEX1)", async () => {
    vi.useFakeTimers();
    try {
      scanDb([PREF_ROW]);
      syncMocks.notableNearbyObs.mockResolvedValue({
        data: [
          NOTABLE,
          { ...NOTABLE, speciesCode: "wantat1", comName: "Wandering Tattler", locId: "L2", lat: 28.4 },
        ],
        fetchedAt: new Date(),
        stale: false,
      });
      // First push lands; the second hangs past the budget.
      syncMocks.sendNtfy
        .mockResolvedValueOnce(undefined)
        .mockImplementationOnce(() => new Promise(() => {}));
      const p = runJob(jobRow({ type: "scan_need_alerts", payload: {} }), ctx);
      await vi.advanceTimersByTimeAsync(61_000);
      await p;
      const fails = mocks.recordEvent.mock.calls.filter((c) => c[1] === "unit_failed");
      expect(fails).toHaveLength(1);
      expect(fails[0][2]).toMatchObject({ budget: true, sentBeforeExpiry: 1 });
      // One sent-row upsert — for the push that actually went out.
      expect(db.calls.filter((c) => c.text.includes("INSERT INTO need_alerts_sent"))).toHaveLength(1);
      // Only eligible user failed → aggregate retry; its summary counts 1 real send.
      expect(mocks.scheduleRetry).toHaveBeenCalledTimes(1);
      expect(
        (mocks.scheduleRetry.mock.calls[0][4] as { alertsSent: number }).alertsSent,
      ).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("red-team: the decrypted topic appears in NOTHING recorded (CODEX1 #4)", async () => {
    scanDb([PREF_ROW]);
    syncMocks.notableNearbyObs.mockResolvedValue({
      data: [NOTABLE],
      fetchedAt: new Date(),
      stale: false,
    });
    await runJob(jobRow({ type: "scan_need_alerts", payload: {} }), ctx);
    const stored = [
      ...mocks.recordEvent.mock.calls.map((c) => JSON.stringify(c[2] ?? {})),
      ...mocks.updateProgress.mock.calls.map((c) => JSON.stringify(c[1])),
      ...mocks.terminalizeAndReschedule.mock.calls.map((c) => JSON.stringify([c[2], c[3]])),
      ...mocks.scheduleRetry.mock.calls.map((c) => JSON.stringify(c[4] ?? null)),
    ];
    expect(stored.length).toBeGreaterThan(0);
    for (const json of stored) expect(json).not.toContain(SECRET);
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

/**
 * Job-queue DB integration tests against the LOCAL TEST CLUSTER (birds_test
 * on :15436) — pins what mocks cannot: the partial-unique dedup index, the
 * single-statement SKIP LOCKED claim, next_retry_at gating, CAS transitions,
 * cancel semantics, startup reclaim, and retention pruning.
 *
 * Same connection convention as forecast-db.test.ts: .env.test is parsed
 * before importing $lib/db; if the test cluster isn't running the suite
 * skips instead of failing, and the guarded port (15436) means it can never
 * touch another cluster.
 */
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

function loadEnvTest(): Record<string, string> {
  const out: Record<string, string> = {};
  let raw: string;
  try {
    raw = readFileSync(new URL("../../../.env.test", import.meta.url), "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^"|"$/g, "");
  }
  return out;
}

const envTest = loadEnvTest();
for (const k of ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD"]) {
  if (envTest[k]) process.env[k] = envTest[k];
}
process.env.EBIRD_KEY_SECRET ??= envTest.EBIRD_KEY_SECRET ?? "test-secret";

const { query, withTransaction } = await import("$lib/db");
const {
  cancelRunningJob,
  claimNextJob,
  completeJob,
  enqueueJob,
  failJob,
  getJob,
  hasActiveJob,
  jobEvents,
  listJobs,
  pruneHistory,
  reclaimStartupJobs,
  requeueInterrupted,
  requestCancel,
  scheduleRetry,
  terminalizeAndReschedule,
  updateProgress,
  workerHealth,
} = await import("./jobs");

let dbUp = false;
try {
  if (envTest.PGPORT === "15436") {
    await query("SELECT 1");
    dbUp = true;
  }
} catch {
  dbUp = false;
}

let userId = 0;

const wipeJobs = async () => {
  // job_events cascades from jobs.
  await query("DELETE FROM jobs WHERE label LIKE 'JOBTEST %'");
};

beforeAll(async () => {
  if (!dbUp) return;
  const r = await query<{ id: number }>(
    `INSERT INTO users (username, display_name, password_hash, role)
     VALUES ('jobtest-fixture', 'Job Test', 'x', 'admin')
     ON CONFLICT (username) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING id`,
  );
  userId = r.rows[0].id;
  await wipeJobs();
});

afterEach(async () => {
  if (dbUp) await wipeJobs();
});

afterAll(async () => {
  if (!dbUp) return;
  await wipeJobs();
  await query("DELETE FROM users WHERE username = 'jobtest-fixture'");
});

function params(overrides: Record<string, unknown> = {}) {
  return {
    type: "load_region" as const,
    payload: { locs: [{ code: "US-ZZ", kind: "region", name: "Test", regionCode: "US-ZZ" }] },
    dedupKey: null as string | null,
    requestedBy: userId,
    label: "JOBTEST region",
    ...overrides,
  };
}

describe.runIf(dbUp)("enqueue + dedup", () => {
  it("dedups an active job and records both events on the winner", async () => {
    const a = await enqueueJob(params({ dedupKey: "JOBTEST:dedup1" }));
    expect(a.deduped).toBe(false);
    const b = await enqueueJob(params({ dedupKey: "JOBTEST:dedup1" }));
    expect(b).toEqual({ jobId: a.jobId, deduped: true });
    const events = await jobEvents(a.jobId);
    expect(events.map((e) => e.action)).toEqual(["enqueued", "deduped"]);
  });

  it("a FINISHED job with the same dedup key does not block a new enqueue", async () => {
    const a = await enqueueJob(params({ dedupKey: "JOBTEST:dedup2" }));
    const claimed = await claimNextJob();
    expect(claimed?.id).toBe(a.jobId);
    await completeJob(a.jobId, claimed!.attempts, { ok: true });
    const b = await enqueueJob(params({ dedupKey: "JOBTEST:dedup2" }));
    expect(b.deduped).toBe(false);
    expect(b.jobId).not.toBe(a.jobId);
  });

  it("null dedup keys never collide", async () => {
    const a = await enqueueJob(params());
    const b = await enqueueJob(params());
    expect(a.jobId).not.toBe(b.jobId);
  });

  it("concurrent same-key enqueues settle on ONE winner", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        enqueueJob(params({ dedupKey: "JOBTEST:race" })),
      ),
    );
    const ids = new Set(results.map((r) => r.jobId));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => !r.deduped)).toHaveLength(1);
  });
});

describe.runIf(dbUp)("claim", () => {
  it("claims oldest-first, increments attempts, and skips future retries", async () => {
    const a = await enqueueJob(params({ label: "JOBTEST first" }));
    const b = await enqueueJob(params({ label: "JOBTEST second" }));
    // Push a's next_retry_at into the future — b must be claimed instead.
    await query(
      `UPDATE jobs SET next_retry_at = NOW() + interval '1 hour' WHERE id = $1`,
      [a.jobId],
    );
    const claimed = await claimNextJob();
    expect(claimed?.id).toBe(b.jobId);
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.status).toBe("running");
    // Nothing else is runnable now.
    expect(await claimNextJob()).toBeNull();
  });

  it("never claims a cancel_requested pending job", async () => {
    const a = await enqueueJob(params());
    await query(`UPDATE jobs SET cancel_requested = TRUE WHERE id = $1`, [a.jobId]);
    expect(await claimNextJob()).toBeNull();
  });

  it("concurrent claims hand out distinct jobs (SKIP LOCKED)", async () => {
    await enqueueJob(params({ label: "JOBTEST c1" }));
    await enqueueJob(params({ label: "JOBTEST c2" }));
    const [x, y] = await Promise.all([claimNextJob(), claimNextJob()]);
    const ids = [x?.id, y?.id].filter((v) => v != null);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe.runIf(dbUp)("transitions (CAS)", () => {
  it("complete wins once; a raced second transition is a no-op", async () => {
    const a = await enqueueJob(params());
    const claimed = await claimNextJob();
    expect(await completeJob(a.jobId, claimed!.attempts, { n: 1 })).toBe(true);
    expect(await failJob(a.jobId, claimed!.attempts, "too late")).toBe(false);
    const row = await getJob(a.jobId);
    expect(row?.status).toBe("succeeded");
    expect(row?.error).toBeNull();
  });

  it("stale attempts value cannot fire a transition", async () => {
    const a = await enqueueJob(params());
    const claimed = await claimNextJob();
    expect(await completeJob(a.jobId, claimed!.attempts + 1, {})).toBe(false);
    expect((await getJob(a.jobId))?.status).toBe("running");
    await cancelRunningJob(a.jobId, claimed!.attempts);
  });

  it("scheduleRetry re-pends with next_retry_at and waiting_retry phase", async () => {
    const a = await enqueueJob(params());
    const claimed = await claimNextJob();
    await updateProgress(a.jobId, {
      phase: "fetching",
      unitsTotal: 3,
      unitsDone: 1,
      unitsFailed: 0,
      unitsSkipped: 0,
      round: 1,
    });
    expect(
      await scheduleRetry(a.jobId, claimed!.attempts, 16 * 60_000, "test retry"),
    ).toBe(true);
    const row = await getJob(a.jobId);
    expect(row?.status).toBe("pending");
    expect(row?.next_retry_at).not.toBeNull();
    expect((row?.progress as { phase?: string }).phase).toBe("waiting_retry");
    // Not claimable until the delay elapses.
    expect(await claimNextJob()).toBeNull();
  });

  it("requeueInterrupted refunds the attempt (deploys don't spend budget)", async () => {
    const a = await enqueueJob(params());
    const claimed = await claimNextJob();
    expect(claimed?.attempts).toBe(1);
    expect(await requeueInterrupted(a.jobId, claimed!.attempts)).toBe(true);
    const row = await getJob(a.jobId);
    expect(row?.status).toBe("pending");
    expect(row?.attempts).toBe(0);
    // Immediately claimable again.
    const again = await claimNextJob();
    expect(again?.id).toBe(a.jobId);
    expect(again?.attempts).toBe(1);
    await cancelRunningJob(a.jobId, 1);
  });
});

describe.runIf(dbUp)("cancel round-trip", () => {
  it("pending → cancelled outright", async () => {
    const a = await enqueueJob(params());
    expect(await requestCancel(a.jobId, userId)).toBe("cancelled");
    expect((await getJob(a.jobId))?.status).toBe("cancelled");
  });

  it("running → flag only, then the worker honors it", async () => {
    const a = await enqueueJob(params());
    const claimed = await claimNextJob();
    expect(await requestCancel(a.jobId, userId)).toBe("flagged");
    expect((await getJob(a.jobId))?.status).toBe("running");
    // Worker sees the flag via its progress write…
    const { cancelRequested } = await updateProgress(a.jobId, {
      phase: "fetching",
      unitsTotal: 2,
      unitsDone: 1,
      unitsFailed: 0,
      unitsSkipped: 0,
      round: 1,
    });
    expect(cancelRequested).toBe(true);
    // …and finalizes the cancel.
    expect(await cancelRunningJob(a.jobId, claimed!.attempts, { partial: 1 })).toBe(true);
    expect((await getJob(a.jobId))?.status).toBe("cancelled");
  });

  it("terminal → noop", async () => {
    const a = await enqueueJob(params());
    const claimed = await claimNextJob();
    await completeJob(a.jobId, claimed!.attempts, {});
    expect(await requestCancel(a.jobId, userId)).toBe("noop");
    expect((await getJob(a.jobId))?.status).toBe("succeeded");
  });
});

describe.runIf(dbUp)("cancel at the terminalization boundary (CODEX1 re-re-review)", () => {
  // Simulates: last updateProgress returned cancelRequested=false, THEN the
  // user's cancel lands, THEN the worker terminalizes. The transition SQL
  // must atomically resolve to cancelled — no lost cancel, single event.
  async function claimThenFlag(label: string) {
    const a = await enqueueJob(params({ label }));
    const claimed = await claimNextJob();
    expect(claimed?.id).toBe(a.jobId);
    const { cancelRequested } = await updateProgress(a.jobId, {
      phase: "fetching",
      unitsTotal: 1,
      unitsDone: 1,
      unitsFailed: 0,
      unitsSkipped: 0,
      round: 1,
    });
    expect(cancelRequested).toBe(false); // worker's last observation
    expect(await requestCancel(a.jobId, userId)).toBe("flagged");
    return { jobId: a.jobId, attempts: claimed!.attempts };
  }

  async function expectCancelledOnce(jobId: number) {
    const row = await getJob(jobId);
    expect(row?.status).toBe("cancelled");
    const events = await jobEvents(jobId);
    const terminal = events.filter((e) =>
      ["completed", "failed", "retry_scheduled", "interrupted", "cancelled"].includes(e.action),
    );
    expect(terminal.map((e) => e.action)).toEqual(["cancelled"]);
  }

  it("completeJob after a late cancel → cancelled, not succeeded", async () => {
    const { jobId, attempts } = await claimThenFlag("JOBTEST late-cancel complete");
    expect(await completeJob(jobId, attempts, { n: 1 })).toBe(true);
    await expectCancelledOnce(jobId);
  });

  it("failJob after a late cancel → cancelled, not failed", async () => {
    const { jobId, attempts } = await claimThenFlag("JOBTEST late-cancel fail");
    expect(await failJob(jobId, attempts, "would-be error")).toBe(true);
    const row = await getJob(jobId);
    expect(row?.error).toBeNull();
    await expectCancelledOnce(jobId);
  });

  it("scheduleRetry after a late cancel → cancelled, never re-pended", async () => {
    const { jobId, attempts } = await claimThenFlag("JOBTEST late-cancel retry");
    expect(await scheduleRetry(jobId, attempts, 16 * 60_000, "test")).toBe(true);
    const row = await getJob(jobId);
    expect(row?.next_retry_at).toBeNull();
    await expectCancelledOnce(jobId);
    expect(await claimNextJob()).toBeNull();
  });

  it("requeueInterrupted after a late cancel → cancelled, never resurrects", async () => {
    const { jobId, attempts } = await claimThenFlag("JOBTEST late-cancel requeue");
    expect(await requeueInterrupted(jobId, attempts)).toBe(true);
    await expectCancelledOnce(jobId);
    expect(await claimNextJob()).toBeNull();
  });

  it("reclaim resolves a cancel-flagged running row to cancelled, not pending", async () => {
    const a = await enqueueJob(params({ label: "JOBTEST reclaim-flagged" }));
    const claimed = await claimNextJob();
    expect(claimed?.id).toBe(a.jobId);
    expect(await requestCancel(a.jobId, userId)).toBe("flagged");
    await reclaimStartupJobs("test-boot");
    await expectCancelledOnce(a.jobId);
    expect(await claimNextJob()).toBeNull();
  });

  /**
   * Deterministic lock choreography (no scheduler-dependent sleeps):
   * `run` executes inside a held-open transaction and resolves `lockHeld`
   * only after its UPDATE returns — i.e. after the row lock is acquired;
   * `waitForLockWaiter` polls pg_stat_activity until a backend is actually
   * BLOCKED (wait_event_type='Lock') on a matching statement.
   */
  async function holdLockedUpdate(run: (client: { query: (t: string, p?: unknown[]) => Promise<unknown> }) => Promise<void>) {
    let lockAcquired!: () => void;
    let commit!: () => void;
    const acquired = new Promise<void>((r) => (lockAcquired = r));
    const gate = new Promise<void>((r) => (commit = r));
    const txn = withTransaction(async (client) => {
      await run(client as never);
      lockAcquired();
      await gate;
    });
    await acquired;
    return { commit, txn };
  }

  async function waitForLockWaiter(pattern: string) {
    for (let i = 0; i < 250; i++) {
      const r = await query(
        `SELECT 1 FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query ILIKE $1`,
        [pattern],
      );
      if ((r.rowCount ?? 0) > 0) return;
      await new Promise((res) => setTimeout(res, 20));
    }
    throw new Error(`no backend ever blocked on a lock for: ${pattern}`);
  }

  it("TWO-CLIENT RACE: a cancel committing while reclaim's UPDATE waits on the row lock still wins", async () => {
    // Flag transaction acquires the row lock; reclaim's batch UPDATE is
    // verified BLOCKED on it; the flag then commits. Under READ COMMITTED
    // the blocked UPDATE re-reads the committed row, so its CASE must see
    // cancel_requested=true and resolve to cancelled — branching on any
    // earlier observation would re-pend the row into a permanent wedge.
    const a = await enqueueJob(params({ label: "JOBTEST reclaim-race" }));
    const claimed = await claimNextJob();
    expect(claimed?.id).toBe(a.jobId);

    const { commit, txn } = await holdLockedUpdate(async (client) => {
      await client.query(
        `UPDATE jobs SET cancel_requested = TRUE WHERE id = $1 AND status = 'running'`,
        [a.jobId],
      );
    });
    const reclaim = reclaimStartupJobs("race-boot");
    await waitForLockWaiter("%UPDATE jobs SET%status = CASE%WHEN cancel_requested%");
    commit();
    await txn;
    expect(await reclaim).toBe(1);

    await expectCancelledOnce(a.jobId);
    expect(await claimNextJob()).toBeNull();
  });

  it("INVERSE RACE: requestCancel waiting on reclaim's lock re-evaluates the re-pended row and cancels it", async () => {
    // The two-statement gap CODEX1 flagged: reclaim (simulated by its exact
    // budget-left effect inside a held transaction — the real function
    // autocommits, leaving no window to hold) moves running→pending while
    // requestCancel is BLOCKED on the row lock. After commit, the
    // single-statement requestCancel re-evaluates the committed PENDING row
    // and must cancel it outright — the old pending-then-running UPDATE
    // pair returned noop here and the cancel was silently lost.
    const a = await enqueueJob(params({ label: "JOBTEST cancel-race" }));
    const claimed = await claimNextJob();
    expect(claimed?.id).toBe(a.jobId);

    const { commit, txn } = await holdLockedUpdate(async (client) => {
      await client.query(
        `UPDATE jobs SET status = 'pending', next_retry_at = NOW()
          WHERE id = $1 AND status = 'running'`,
        [a.jobId],
      );
    });
    const cancel = requestCancel(a.jobId, userId);
    await waitForLockWaiter("%UPDATE jobs SET%status = CASE WHEN status = 'pending'%");
    commit();
    await txn;
    expect(await cancel).toBe("cancelled");

    await expectCancelledOnce(a.jobId);
    expect(await claimNextJob()).toBeNull();
  });
});

describe.runIf(dbUp)("startup reclaim", () => {
  it("budget left → pending with reclaimed event; exhausted → failed", async () => {
    const fresh = await enqueueJob(params({ label: "JOBTEST reclaim-fresh" }));
    const spent = await enqueueJob(params({ label: "JOBTEST reclaim-spent" }));
    await query(`UPDATE jobs SET status = 'running', attempts = 1 WHERE id = $1`, [
      fresh.jobId,
    ]);
    await query(`UPDATE jobs SET status = 'running', attempts = 4 WHERE id = $1`, [
      spent.jobId,
    ]);
    const n = await reclaimStartupJobs("test-boot");
    expect(n).toBe(2);
    expect((await getJob(fresh.jobId))?.status).toBe("pending");
    expect((await getJob(spent.jobId))?.status).toBe("failed");
    const freshEvents = await jobEvents(fresh.jobId);
    expect(freshEvents.some((e) => e.action === "reclaimed")).toBe(true);
  });
});

describe.runIf(dbUp)("durable-boundary sanitization (CODEX1 Phase-2 #1)", () => {
  it("hostile details/error/result are stored REDACTED, read back clean", async () => {
    const HOSTILE = "echo: password=hunter2 Authorization: Bearer abc.def.ghi";
    const a = await enqueueJob(params({ label: "JOBTEST scrub" }));
    const claimed = await claimNextJob();
    await updateProgress(a.jobId, {
      phase: "fetching",
      unitsTotal: 1,
      unitsDone: 0,
      unitsFailed: 1,
      unitsSkipped: 0,
      lastError: HOSTILE,
      round: 1,
    });
    await failJob(a.jobId, claimed!.attempts, HOSTILE, {
      failed: [{ code: "L1", error: HOSTILE }],
    });
    const row = await getJob(a.jobId);
    const events = await jobEvents(a.jobId);
    const everything = JSON.stringify([row?.progress, row?.error, row?.result, events]);
    expect(everything).not.toContain("hunter2");
    expect(everything).not.toContain("abc.def.ghi");
    expect(everything).toContain("[redacted]");
  });
});

describe.runIf(dbUp)("recurring primitives (need-alert scheduler)", () => {
  const KEY = "JOBTEST:recur";
  function recurParams(label: string) {
    return params({
      type: "scan_need_alerts" as const,
      dedupKey: KEY,
      label,
    });
  }

  it("runAfterMs gates claiming until the delay elapses", async () => {
    await enqueueJob({ ...recurParams("JOBTEST scheduled"), runAfterMs: 60_000 });
    expect(await hasActiveJob(KEY)).toBe(true);
    expect(await claimNextJob()).toBeNull(); // not claimable yet
    const row = await query<{ id: number }>(
      `SELECT id FROM jobs WHERE dedup_key = $1 AND status = 'pending'`,
      [KEY],
    );
    // Make it due, then it claims.
    await query(`UPDATE jobs SET next_retry_at = NOW() WHERE id = $1`, [row.rows[0].id]);
    const claimed = await claimNextJob();
    expect(claimed?.id).toBe(row.rows[0].id);
    await cancelRunningJob(claimed!.id, claimed!.attempts);
  });

  it("scheduled enqueue event carries scheduled details (not waiting_retry)", async () => {
    const { jobId } = await enqueueJob({
      ...recurParams("JOBTEST sched-event"),
      runAfterMs: 30_000,
    });
    const events = await jobEvents(jobId);
    expect(events[0].action).toBe("enqueued");
    expect((events[0].details as { scheduled?: boolean }).scheduled).toBe(true);
    await query(`UPDATE jobs SET status='cancelled', finished_at=NOW() WHERE id=$1`, [jobId]);
  });

  it("terminalizeAndReschedule: terminal row + successor + BOTH events in one txn", async () => {
    const { jobId } = await enqueueJob(recurParams("JOBTEST handoff"));
    await query(`UPDATE jobs SET next_retry_at = NULL WHERE id = $1`, [jobId]);
    const claimed = await claimNextJob();
    expect(claimed?.id).toBe(jobId);
    const r = await terminalizeAndReschedule(
      jobId,
      claimed!.attempts,
      { kind: "complete", result: { usersScanned: 2, alertsSent: 1 } },
      { ...recurParams("JOBTEST handoff-next"), runAfterMs: 30 * 60_000 },
    );
    expect(r.won).toBe(true);
    expect(r.finalStatus).toBe("succeeded");
    expect(r.successorId).not.toBeNull();
    // Current terminalized with its completed event...
    expect((await getJob(jobId))?.status).toBe("succeeded");
    const doneEvents = await jobEvents(jobId);
    expect(doneEvents.some((e) => e.action === "completed")).toBe(true);
    // ...successor pending, gated, with its scheduled enqueued event.
    const succ = await getJob(r.successorId!);
    expect(succ?.status).toBe("pending");
    expect(succ?.next_retry_at).not.toBeNull();
    const succEvents = await jobEvents(r.successorId!);
    expect(succEvents.map((e) => e.action)).toEqual(["enqueued"]);
    expect((succEvents[0].details as { scheduled?: boolean }).scheduled).toBe(true);
    // Exactly one active holder of the dedup key.
    const active = await query(
      `SELECT COUNT(*)::int AS n FROM jobs WHERE dedup_key = $1 AND status IN ('pending','running')`,
      [KEY],
    );
    expect((active.rows[0] as { n: number }).n).toBe(1);
  });

  it("terminalizeAndReschedule honors a raced cancel: cancelled, NO successor", async () => {
    const { jobId } = await enqueueJob(recurParams("JOBTEST handoff-cancel"));
    await query(`UPDATE jobs SET next_retry_at = NULL WHERE id = $1`, [jobId]);
    const claimed = await claimNextJob();
    // Flag lands after the worker's last observation, before terminalization.
    await query(`UPDATE jobs SET cancel_requested = TRUE WHERE id = $1`, [jobId]);
    const r = await terminalizeAndReschedule(
      jobId,
      claimed!.attempts,
      { kind: "complete", result: {} },
      { ...recurParams("JOBTEST handoff-cancel-next"), runAfterMs: 30 * 60_000 },
    );
    expect(r.finalStatus).toBe("cancelled");
    expect(r.successorId).toBeNull();
    expect(await hasActiveJob(KEY)).toBe(false);
  });

  it("a lost CAS writes NOTHING (rollback: no successor, no events)", async () => {
    const { jobId } = await enqueueJob(recurParams("JOBTEST handoff-lost"));
    await query(`UPDATE jobs SET next_retry_at = NULL WHERE id = $1`, [jobId]);
    const claimed = await claimNextJob();
    const r = await terminalizeAndReschedule(
      jobId,
      claimed!.attempts + 7, // stale expectation → CAS loses
      { kind: "complete", result: {} },
      { ...recurParams("JOBTEST handoff-lost-next"), runAfterMs: 30 * 60_000 },
    );
    expect(r.won).toBe(false);
    expect((await getJob(jobId))?.status).toBe("running");
    const active = await query(
      `SELECT COUNT(*)::int AS n FROM jobs WHERE dedup_key = $1 AND status IN ('pending','running')`,
      [KEY],
    );
    expect((active.rows[0] as { n: number }).n).toBe(1); // just the running row
    await cancelRunningJob(jobId, claimed!.attempts);
  });

  it("requestCancel noops for the recurring type (CODEX1 plan #2)", async () => {
    const { jobId } = await enqueueJob(recurParams("JOBTEST cancel-guard"));
    expect(await requestCancel(jobId, userId)).toBe("noop");
    expect((await getJob(jobId))?.status).toBe("pending");
    await query(`UPDATE jobs SET status='cancelled', finished_at=NOW() WHERE id=$1`, [jobId]);
  });
});

describe.runIf(dbUp)("user_alert_prefs upsert (prod 500, 2026-08-16)", () => {
  const wipe = () => query("DELETE FROM user_alert_prefs WHERE user_id = $1", [userId]);

  it("re-save with enabled + empty topic input keeps the saved topic — the candidate row must satisfy the CHECK itself", async () => {
    await wipe();
    const upsert = (enabled: boolean, topicEnc: string | null) =>
      query(
        `INSERT INTO user_alert_prefs (user_id, enabled, ntfy_topic_enc, radius_km, realert_days, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           enabled = $2, ntfy_topic_enc = $3,
           radius_km = $4, realert_days = $5, updated_at = NOW()`,
        [userId, enabled, topicEnc, 40, 7],
      );
    // First save: topic + enabled.
    await upsert(true, "enc-topic-1");
    // The PROD failure shape: re-save (radius tweak) with the topic field
    // empty. The action resolves the effective topic FIRST — the old
    // COALESCE-in-DO-UPDATE shape put NULL in the candidate row and
    // violated user_alert_prefs_check before conflict resolution.
    const effective = await query<{ ntfy_topic_enc: string | null }>(
      `SELECT ntfy_topic_enc FROM user_alert_prefs WHERE user_id = $1`,
      [userId],
    );
    await upsert(true, effective.rows[0]?.ntfy_topic_enc ?? null); // must not throw
    const after = await query<{ enabled: boolean; ntfy_topic_enc: string | null }>(
      `SELECT enabled, ntfy_topic_enc FROM user_alert_prefs WHERE user_id = $1`,
      [userId],
    );
    expect(after.rows[0]).toEqual({ enabled: true, ntfy_topic_enc: "enc-topic-1" });
    // And the DB still rejects a genuinely topic-less enable.
    await wipe();
    await expect(upsert(true, null)).rejects.toThrow(/user_alert_prefs_check/);
    await wipe();
  });
});

describe.runIf(dbUp)("listing, health, prune", () => {
  it("listJobs returns active plus recent finished", async () => {
    const a = await enqueueJob(params({ label: "JOBTEST list-active" }));
    const b = await enqueueJob(params({ label: "JOBTEST list-done" }));
    const claimed = await claimNextJob();
    await completeJob(claimed!.id, claimed!.attempts, {});
    const rows = await listJobs();
    const mine = rows.filter((r) => r.label.startsWith("JOBTEST "));
    expect(mine.map((r) => r.id).sort()).toEqual([a.jobId, b.jobId].sort());
  });

  it("workerHealth never throws and reports staleness honestly", async () => {
    const h = await workerHealth();
    expect(typeof h.alive).toBe("boolean");
  });

  it("pruneHistory removes old finished jobs and their events", async () => {
    const a = await enqueueJob(params({ label: "JOBTEST prune-old" }));
    const keep = await enqueueJob(params({ label: "JOBTEST prune-keep" }));
    await query(
      `UPDATE jobs SET status = 'succeeded', finished_at = NOW() - interval '91 days' WHERE id = $1`,
      [a.jobId],
    );
    await query(
      `UPDATE jobs SET status = 'succeeded', finished_at = NOW() WHERE id = $1`,
      [keep.jobId],
    );
    await pruneHistory();
    expect(await getJob(a.jobId)).toBeNull();
    expect(await getJob(keep.jobId)).not.toBeNull();
  });
});

describe.runIf(!dbUp)("job queue DB suite", () => {
  it.skip("skipped — test cluster not running (npm run test:db:up)", () => {});
});

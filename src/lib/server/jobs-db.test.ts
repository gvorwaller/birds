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

const { query } = await import("$lib/db");
const {
  cancelRunningJob,
  claimNextJob,
  completeJob,
  enqueueJob,
  failJob,
  getJob,
  jobEvents,
  listJobs,
  pruneHistory,
  reclaimStartupJobs,
  requeueInterrupted,
  requestCancel,
  scheduleRetry,
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

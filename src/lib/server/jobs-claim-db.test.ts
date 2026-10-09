/**
 * td-894144 B5 (plan §3z): per-claim fencing of the job queue against the
 * local test cluster. `attempts` is refunded by a drain requeue, so a stale
 * execution and its replacement can hold the same attempts; jobs.claim_seq is
 * the per-claim identity and every holder-side write carries it.
 *
 * Owns its rows (label 'CLAIMTEST %'); never calls claimNextJob, which could
 * take another file's pending job on the shared database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { query, withTransaction } from "$lib/db";
import type { JobRow } from "$server/job-policy";
import {
  cancelRunningJob,
  completeJob,
  enqueueJob,
  failJob,
  isStaleClaim,
  reclaimStartupJobs,
  recordEvent,
  recordQueueEvent,
  requestCancel,
  requeueInterrupted,
  runWithClaim,
  scheduleRetry,
  setJobLabel,
  StaleClaimError,
  terminalizeAndReschedule,
  updateProgress,
  yieldRemainder,
} from "./jobs";
import {
  assertClaimHeld,
  boundedQueueWrite,
  ClaimTxMisuseError,
  claimFencedQuery,
  QueueLockTimeoutError,
  QueueWriteUnrecoverableError,
  withClaimBoundsForTest,
  withClaimTx,
} from "./job-claim";
import { TagTxRollback, withTagWriteTx } from "./tag-engine/runtime";
import { runJob } from "./job-handlers";

const migrated = await query(
  "SELECT 1 FROM information_schema.columns WHERE table_name = 'jobs' AND column_name = 'claim_seq'",
)
  .then((r) => r.rows.length > 0)
  .catch(() => false);

const RUN = `${process.pid.toString(36)}${Date.now().toString(36).slice(-6)}`;
let userId = 0;

async function newJob(type = "tag_preview", payload: unknown = {}): Promise<number> {
  return (
    await query<{ id: number }>(
      `INSERT INTO jobs (type, payload, requested_by, label, max_attempts)
       VALUES ($1, $2, $3, $4, 3) RETURNING id`,
      [type, JSON.stringify(payload), userId, `CLAIMTEST ${RUN}`],
    )
  ).rows[0].id;
}

/** Claim OUR row exactly as claimNextJob does (attempts + 1, claim_seq + 1). */
async function claim(id: number): Promise<JobRow> {
  const r = await query<JobRow>(
    `UPDATE jobs SET status = 'running', started_at = NOW(), attempts = attempts + 1,
                     heartbeat_at = NOW(), claim_seq = claim_seq + 1
      WHERE id = $1 AND status = 'pending' RETURNING *`,
    [id],
  );
  expect(r.rows[0], `job ${id} claimable`).toBeDefined();
  return r.rows[0];
}

const row = async (id: number) =>
  (
    await query<{
      status: string;
      attempts: number;
      claim_seq: string;
      progress: unknown;
      heartbeat_at: string;
    }>(
      "SELECT status, attempts, claim_seq::text, progress, heartbeat_at::text FROM jobs WHERE id = $1",
      [id],
    )
  ).rows[0];

const PROGRESS = {
  phase: "fetching" as const,
  unitsTotal: 1,
  unitsDone: 0,
  unitsFailed: 0,
  unitsSkipped: 0,
  round: 1,
};

describe.runIf(migrated).sequential("claim fencing (plan §3z)", () => {
  beforeAll(async () => {
    userId = (
      await query<{ id: number }>(
        `INSERT INTO users (username, display_name, password_hash, role)
         VALUES ($1, 'Claim fixture', '!unset', 'admin') RETURNING id`,
        [`claim-${RUN}`],
      )
    ).rows[0].id;
  });
  afterAll(async () => {
    await query("DELETE FROM ebird_cache WHERE cache_key LIKE $1", [`CLAIMTEST:${RUN}:%`]);
    await query("DELETE FROM jobs WHERE label = $1", [`CLAIMTEST ${RUN}`]);
    await query("DELETE FROM users WHERE id = $1", [userId]);
  });

  it("every claim gets a new claim_seq; a drain refunds attempts but never the claim", async () => {
    const id = await newJob();
    const a = await claim(id);
    expect(Number(a.claim_seq)).toBe(1);
    await runWithClaim(a, () => requeueInterrupted(id, a.attempts));
    const b = await claim(id);
    expect(b.attempts).toBe(a.attempts); // refunded, then re-claimed at the same number
    expect(Number(b.claim_seq)).toBe(2);
  });

  it("after a refunding drain + re-claim, the OLD claim is refused by every write; the new claim proceeds", async () => {
    const id = await newJob();
    const a = await claim(id);
    await runWithClaim(a, () => requeueInterrupted(id, a.attempts));
    const b = await claim(id);
    await runWithClaim(b, () => updateProgress(id, { ...PROGRESS, unitsDone: 7 }));
    const before = await row(id);
    const asA = <T>(fn: () => Promise<T>) => runWithClaim(a, fn);
    const refused = [
      () => asA(() => updateProgress(id, PROGRESS)),
      () => asA(() => completeJob(id, a.attempts, { by: "A" })),
      () => asA(() => failJob(id, a.attempts, "A failed")),
      () => asA(() => scheduleRetry(id, a.attempts, 1000, "A")),
      () => asA(() => requeueInterrupted(id, a.attempts)),
      () => asA(() => yieldRemainder(id, a.attempts, null, {})),
      () => asA(() => cancelRunningJob(id, a.attempts, {})),
      () =>
        asA(() =>
          terminalizeAndReschedule(
            id,
            a.attempts,
            { kind: "complete", result: {} },
            {
              type: "tag_preview",
              payload: {},
              dedupKey: `claimtest:${RUN}:succ`,
              requestedBy: userId,
              label: `CLAIMTEST ${RUN}`,
            },
          ),
        ),
    ];
    for (const f of refused) await expect(f()).rejects.toBeInstanceOf(StaleClaimError);
    // B's row is untouched: still running, B's progress and heartbeat.
    expect(await row(id)).toEqual(before);
    expect((before.progress as { unitsDone: number }).unitsDone).toBe(7);
    // The same write under B works.
    expect(await runWithClaim(b, () => completeJob(id, b.attempts, { by: "B" }))).toBe(true);
    expect((await row(id)).status).toBe("succeeded");
  });

  it("a claim dies the moment its job leaves running — pending and terminal rows refuse it", async () => {
    const pending = await newJob();
    const a = await claim(pending);
    await runWithClaim(a, () => requeueInterrupted(pending, a.attempts)); // now pending, no B yet
    await expect(runWithClaim(a, () => updateProgress(pending, PROGRESS))).rejects.toBeInstanceOf(
      StaleClaimError,
    );
    await expect(runWithClaim(a, () => completeJob(pending, a.attempts, {}))).rejects.toBeInstanceOf(
      StaleClaimError,
    );
    const done = await newJob();
    const c = await claim(done);
    await runWithClaim(c, () => completeJob(done, c.attempts, {}));
    await expect(runWithClaim(c, () => updateProgress(done, PROGRESS))).rejects.toBeInstanceOf(
      StaleClaimError,
    );
    expect((await row(done)).status).toBe("succeeded");
  });

  it("without a claim context the queue behaves as before (tests, scripts)", async () => {
    const id = await newJob();
    const a = await claim(id);
    await updateProgress(id, PROGRESS);
    expect(await completeJob(id, a.attempts, {})).toBe(true);
    expect(await completeJob(id, a.attempts, {})).toBe(false); // lost CAS: false, no throw
  });

  it("runJob: a stale execution stops at its first fenced write and changes nothing", async () => {
    const id = await newJob("tag_preview", { proposalId: "not-a-uuid" });
    const a = await claim(id);
    await runWithClaim(a, () => requeueInterrupted(id, a.attempts));
    const b = await claim(id);
    const before = await row(id);
    const events = async () =>
      (await query("SELECT 1 FROM job_events WHERE job_id = $1", [id])).rows.length;
    const eventsBefore = await events();
    // The handler's first write is its fenced "claimed" event: refused under
    // the stale claim, so A stops there and runJob swallows the stale claim.
    await runJob(a, { isDraining: () => false });
    expect(await row(id)).toEqual(before);
    expect(await events()).toBe(eventsBefore); // no event of ANY action from A
    // The live claim B still owns the job.
    await runJob(b, { isDraining: () => false });
    expect((await row(id)).status).toBe("failed");
  });

  it("isStaleClaim recognises the queue's error and the definers' 'stale claim' message", () => {
    expect(isStaleClaim(new StaleClaimError(1, "x"))).toBe(true);
    expect(isStaleClaim(new Error("stale claim: preview job 9 is not the running claim"))).toBe(true);
    expect(isStaleClaim(new Error("something else"))).toBe(false);
  });

  // ── td-b99b6d Phase A: every durable side effect fenced to the live claim ──

  /** A drained-and-reclaimed job: A is the stale claim, B the live one (spec §6.2). */
  async function staleAndLive(): Promise<{ id: number; a: JobRow; b: JobRow }> {
    const id = await newJob();
    const a = await claim(id);
    await runWithClaim(a, () => requeueInterrupted(id, a.attempts));
    const b = await claim(id);
    return { id, a, b };
  }
  const eventCount = async (id: number) =>
    Number(
      (await query<{ n: string }>("SELECT count(*)::text AS n FROM job_events WHERE job_id = $1", [id]))
        .rows[0].n,
    );
  const cacheKey = (k: string) => `CLAIMTEST:${RUN}:${k}`;
  const cacheRow = async (k: string) =>
    (await query("SELECT payload FROM ebird_cache WHERE cache_key = $1", [cacheKey(k)])).rows[0] ?? null;
  const insertCache = (c: { query: (t: string, p: unknown[]) => Promise<unknown> }, k: string) =>
    c.query(
      "INSERT INTO ebird_cache (cache_key, payload) VALUES ($1, '{}'::jsonb) ON CONFLICT (cache_key) DO NOTHING",
      [cacheKey(k)],
    );
  function deferred() {
    let release!: () => void;
    const promise = new Promise<void>((r) => (release = r));
    return { promise, release };
  }
  /** Track a promise's settlement without awaiting it. */
  function watch<T>(p: Promise<T>) {
    const state = { settled: false, value: undefined as T | undefined, error: undefined as unknown };
    const done = p.then(
      (v) => {
        state.settled = true;
        state.value = v;
      },
      (e) => {
        state.settled = true;
        state.error = e;
      },
    );
    return { state, done };
  }
  /** Connection 1 holds the job row FOR SHARE (an event or fenced transaction mid-flight) until released. */
  function holdForShare(id: number) {
    const gate = deferred();
    const locked = deferred();
    const tx = withTransaction(async (c) => {
      await c.query("SELECT 1 FROM jobs WHERE id = $1 FOR SHARE", [id]);
      locked.release();
      await gate.promise;
    });
    return { locked: locked.promise, release: gate.release, done: tx };
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("events: a stale claim's recordEvent is refused for every action; the live claim's lands; no claim and the queue writer are plain", async () => {
    const { id, a, b } = await staleAndLive();
    const before = await eventCount(id);
    for (const action of ["claimed", "unit_ok", "unit_failed", "unit_skipped", "progress"] as const)
      await expect(runWithClaim(a, () => recordEvent(id, action, { by: "A" }))).rejects.toBeInstanceOf(
        StaleClaimError,
      );
    expect(await eventCount(id)).toBe(before);
    await runWithClaim(b, () => recordEvent(id, "unit_ok", { by: "B" }));
    expect(await eventCount(id)).toBe(before + 1);
    await recordEvent(id, "progress", { by: "no claim" });
    expect(await eventCount(id)).toBe(before + 2);
    // The queue's own writer is unfenced: it records on a terminal row.
    await runWithClaim(b, () => completeJob(id, b.attempts, {}));
    await recordQueueEvent(id, "progress", { after: "terminal" });
    expect(await eventCount(id)).toBe(before + 4); // + 'completed' + this one
  });

  it("event race (i): a transition waits for an in-flight fenced event, then the old claim's next event is refused", async () => {
    const id = await newJob();
    const a = await claim(id);
    const hold = holdForShare(id);
    await hold.locked;
    const requeue = watch(runWithClaim(a, () => requeueInterrupted(id, a.attempts)));
    await sleep(200);
    expect(requeue.state.settled).toBe(false); // blocked behind the event's FOR SHARE
    hold.release();
    await hold.done;
    await requeue.done;
    expect(requeue.state.value).toBe(true);
    expect((await row(id)).status).toBe("pending");
    await expect(runWithClaim(a, () => recordEvent(id, "unit_ok", {}))).rejects.toBeInstanceOf(
      StaleClaimError,
    );
  });

  it("event race (ii): the transition commits first — the fenced event finds no running row and writes nothing", async () => {
    const id = await newJob();
    const a = await claim(id);
    await runWithClaim(a, () => requeueInterrupted(id, a.attempts));
    const before = await eventCount(id);
    await expect(runWithClaim(a, () => recordEvent(id, "unit_ok", {}))).rejects.toBeInstanceOf(
      StaleClaimError,
    );
    expect(await eventCount(id)).toBe(before);
  });

  it("lost lock session: a startup reclaim + new claim while A runs on — A commits nothing, B proceeds", async () => {
    const id = await newJob();
    const a = await claim(id);
    // What a new worker does after the old one's lock session died (spec §1.1 #2).
    expect(await reclaimStartupJobs("lost session", { jobIds: [id] })).toBe(1);
    // Pending, no B yet: A is already dead.
    await expect(runWithClaim(a, () => assertClaimHeld("probe"))).rejects.toBeInstanceOf(StaleClaimError);
    const b = await claim(id);
    const before = await eventCount(id);
    const asA = <T>(fn: () => Promise<T>) => runWithClaim(a, fn);
    for (const f of [
      () => asA(() => recordEvent(id, "unit_ok", {})),
      () => asA(() => withClaimTx((c) => insertCache(c, "lost-a"))),
      () => asA(() => claimFencedQuery("SELECT 1", [])),
      () => asA(() => setJobLabel(id, "A")),
      () => asA(() => updateProgress(id, PROGRESS)),
      () =>
        asA(() =>
          enqueueJob({
            type: "tag_preview",
            payload: {},
            dedupKey: `claimtest:${RUN}:lost-a`,
            requestedBy: userId,
            label: `CLAIMTEST ${RUN}`,
          }),
        ),
    ])
      await expect(f()).rejects.toBeInstanceOf(StaleClaimError);
    expect(await cacheRow("lost-a")).toBeNull();
    expect(await eventCount(id)).toBe(before);
    expect(
      (await query("SELECT 1 FROM jobs WHERE dedup_key = $1", [`claimtest:${RUN}:lost-a`])).rows,
    ).toHaveLength(0);
    // B does all of it.
    await runWithClaim(b, () => withClaimTx((c) => insertCache(c, "lost-b")));
    await runWithClaim(b, () => setJobLabel(id, `CLAIMTEST ${RUN}`));
    const enq = await runWithClaim(b, () =>
      enqueueJob({
        type: "tag_preview",
        payload: {},
        dedupKey: `claimtest:${RUN}:lost-b`,
        requestedBy: userId,
        label: `CLAIMTEST ${RUN}`,
      }),
    );
    expect(enq.deduped).toBe(false);
    expect(await cacheRow("lost-b")).not.toBeNull();
    expect(await runWithClaim(b, () => completeJob(id, b.attempts, {}))).toBe(true);
  });

  it("COMMIT ordering: a transition waits for the fenced transaction; its business row commits, then the job completes", async () => {
    const id = await newJob();
    const b = await claim(id);
    const gate = deferred();
    const wrote = deferred();
    const holder = watch(
      runWithClaim(b, () =>
        withClaimTx(async (c) => {
          await insertCache(c, "commit-order");
          wrote.release();
          await gate.promise;
        }),
      ),
    );
    await wrote.promise;
    const writer = watch(runWithClaim(b, () => completeJob(id, b.attempts, { by: "B" })));
    await sleep(200);
    expect(writer.state.settled).toBe(false);
    expect((await row(id)).status).toBe("running");
    gate.release();
    await holder.done;
    await writer.done;
    expect(holder.state.error).toBeUndefined();
    expect(writer.state.value).toBe(true);
    expect(await cacheRow("commit-order")).not.toBeNull();
    expect((await row(id)).status).toBe("succeeded");
  });

  it("transition wins: once the requeue committed, the stale holder's fenced transaction writes nothing", async () => {
    const id = await newJob();
    const a = await claim(id);
    await runWithClaim(a, () => requeueInterrupted(id, a.attempts));
    let ran = false;
    await expect(
      runWithClaim(a, () =>
        withClaimTx(async (c) => {
          ran = true;
          await insertCache(c, "transition-wins");
        }),
      ),
    ).rejects.toBeInstanceOf(StaleClaimError);
    expect(ran).toBe(false);
    expect(await cacheRow("transition-wins")).toBeNull();
  });

  it("ROLLBACK release: a fenced transaction that rolls back lets the waiting transition through; the old claim is then refused", async () => {
    const id = await newJob();
    const a = await claim(id);
    const gate = deferred();
    const wrote = deferred();
    const holder = watch(
      runWithClaim(a, () =>
        withClaimTx(async (c) => {
          await insertCache(c, "rollback");
          wrote.release();
          await gate.promise;
          throw new Error("holder fails");
        }),
      ),
    );
    await wrote.promise;
    const writer = watch(runWithClaim(a, () => requeueInterrupted(id, a.attempts)));
    await sleep(200);
    expect(writer.state.settled).toBe(false);
    gate.release();
    await holder.done;
    await writer.done;
    expect((holder.state.error as Error).message).toBe("holder fails");
    expect(writer.state.value).toBe(true);
    expect(await cacheRow("rollback")).toBeNull();
    await expect(runWithClaim(a, () => withClaimTx((c) => insertCache(c, "rollback-2")))).rejects.toBeInstanceOf(
      StaleClaimError,
    );
  });

  it("self-deadlock guard: a queue write on the job from inside its own fenced transaction fails fast, rolled back", async () => {
    const id = await newJob();
    const b = await claim(id);
    const before = await row(id);
    const t0 = Date.now();
    await expect(
      runWithClaim(b, () =>
        withClaimTx(async (c) => {
          await insertCache(c, "misuse");
          await updateProgress(id, { ...PROGRESS, unitsDone: 9 });
        }),
      ),
    ).rejects.toBeInstanceOf(ClaimTxMisuseError);
    expect(Date.now() - t0).toBeLessThan(100);
    expect(await cacheRow("misuse")).toBeNull();
    expect(await row(id)).toEqual(before);
    // The same guard inside the tag engine's transaction (completeJob there).
    let caught: unknown = null;
    await expect(
      runWithClaim(b, () =>
        withTagWriteTx("shared", `claimtest:${RUN}:misuse`, "claimtest", async () => {
          try {
            await completeJob(id, b.attempts, {});
          } catch (e) {
            caught = e;
          }
          throw new TagTxRollback(); // leave no materialization record behind
        }),
      ),
    ).rejects.toBeInstanceOf(TagTxRollback);
    expect(caught).toBeInstanceOf(ClaimTxMisuseError);
    expect((await row(id)).status).toBe("running");
    // Outside the transaction the same writes work.
    await runWithClaim(b, () => updateProgress(id, PROGRESS));
    expect(await runWithClaim(b, () => completeJob(id, b.attempts, {}))).toBe(true);
  });

  it("transaction caps: the central tag fence keeps 20s/30s; withClaimTx sets 2min, also under REPEATABLE READ", async () => {
    const id = await newJob();
    const b = await claim(id);
    const show = async (c: { query: (t: string) => Promise<{ rows: Record<string, string>[] }> }, k: string) =>
      (await c.query(`SHOW ${k}`)).rows[0][k];
    const seen: Record<string, string> = {};
    for (const mode of ["shared", "exclusive"] as const)
      await runWithClaim(b, () =>
        withTagWriteTx(mode, `claimtest:${RUN}:caps`, "claimtest", async (tx) => {
          // Read AFTER the central assert ran (it precedes the callback): its
          // FOR SHARE shows as this transaction's RowShareLock on jobs.
          const held = await tx.client.query(
            "SELECT 1 FROM pg_locks WHERE pid = pg_backend_pid() AND relation = 'jobs'::regclass AND mode = 'RowShareLock'",
          );
          expect(held.rowCount).toBeGreaterThan(0);
          seen[mode] = await show(tx.client as never, "transaction_timeout");
          throw new TagTxRollback();
        }),
      ).catch((e) => {
        if (!(e instanceof TagTxRollback)) throw e;
      });
    expect(seen).toEqual({ shared: "20s", exclusive: "30s" });
    expect(await runWithClaim(b, () => withClaimTx((c) => show(c as never, "transaction_timeout")))).toBe("2min");
    expect(
      await runWithClaim(b, () =>
        withClaimTx(
          async (c) => [await show(c as never, "transaction_timeout"), await show(c as never, "transaction_isolation")],
          { isolation: "REPEATABLE READ" },
        ),
      ),
    ).toEqual(["2min", "repeatable read"]);
    // No claim: today's transaction exactly — no cap set.
    expect(await withClaimTx((c) => show(c as never, "transaction_timeout"))).toBe("0");
    await runWithClaim(b, () => completeJob(id, b.attempts, {}));
  });

  it("bounded queue write (scaled): a transition retries its lock through the holder's whole hold and then succeeds", async () => {
    const id = await newJob();
    const b = await claim(id);
    const hold = holdForShare(id);
    await hold.locked;
    let timeouts = 0;
    const t0 = Date.now();
    const writer = watch(
      withClaimBoundsForTest({ lockTimeoutMs: 300, deadlineMs: 2_000, onLockTimeout: () => timeouts++ }, () =>
        runWithClaim(b, () => completeJob(id, b.attempts, {})),
      ),
    );
    await sleep(1_200);
    expect(writer.state.settled).toBe(false);
    hold.release();
    await hold.done;
    await writer.done;
    expect(writer.state.error).toBeUndefined();
    expect(writer.state.value).toBe(true);
    expect(timeouts).toBeGreaterThanOrEqual(3);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1_200);
    expect((await row(id)).status).toBe("succeeded");
  });

  it("bounded queue write (scaled): past the deadline it throws QueueWriteUnrecoverableError, the row stays running, and a startup reclaim converts it", async () => {
    const id = await newJob();
    const b = await claim(id);
    const hold = holdForShare(id);
    await hold.locked;
    const t0 = Date.now();
    await expect(
      withClaimBoundsForTest({ lockTimeoutMs: 200, deadlineMs: 700 }, () =>
        runWithClaim(b, () => completeJob(id, b.attempts, {})),
      ),
    ).rejects.toBeInstanceOf(QueueWriteUnrecoverableError);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(700);
    expect(elapsed).toBeLessThan(700 + 200 + 500); // at most one attempt of overrun (+ slack)
    expect((await row(id)).status).toBe("running");
    hold.release();
    await hold.done;
    expect(await reclaimStartupJobs("unwritable row", { jobIds: [id] })).toBe(1);
    expect((await row(id)).status).toBe("pending");
  });

  it("holder cap (scaled): Postgres ends a fenced transaction at its cap, nothing commits, and the waiting transition proceeds", async () => {
    const id = await newJob();
    const b = await claim(id);
    const wrote = deferred();
    const holder = watch(
      withClaimBoundsForTest({ claimTxTimeoutMs: 1_000 }, () =>
        runWithClaim(b, () =>
          withClaimTx(async (c) => {
            await insertCache(c, "capped");
            wrote.release();
            await sleep(2_500);
            await c.query("SELECT 1");
          }),
        ),
      ),
    );
    await wrote.promise;
    const t0 = Date.now();
    const writer = watch(runWithClaim(b, () => completeJob(id, b.attempts, {})));
    const writerMs = await writer.done.then(() => Date.now() - t0);
    await holder.done;
    expect(writer.state.value).toBe(true);
    expect(writerMs).toBeLessThan(2_000); // acquired at the holder's kill, not after its 2.5 s sleep
    expect(holder.state.error).toBeDefined();
    expect(await cacheRow("capped")).toBeNull();
    expect((await row(id)).status).toBe("succeeded");
  });

  it("startup reclaim goes row by row: an early row commits while a later row is still held (scaled bounds)", async () => {
    const r1 = await newJob();
    const r2 = await newJob();
    await claim(r1);
    await claim(r2);
    const hold = holdForShare(r2);
    await hold.locked;
    try {
      const reclaim = watch(
        withClaimBoundsForTest({ lockTimeoutMs: 300, deadlineMs: 5_000 }, () =>
          reclaimStartupJobs("per-row", { jobIds: [r1, r2] }),
        ),
      );
      await sleep(400);
      expect(reclaim.state.settled).toBe(false); // still waiting on r2…
      expect((await row(r1)).status).toBe("pending"); // …but r1 is already committed, not held
      // so another writer of r1 proceeds at once, never queued behind r2's holder.
      const t0 = Date.now();
      expect(await requestCancel(r1, userId)).toBe("cancelled");
      expect(Date.now() - t0).toBeLessThan(250);
      hold.release();
      await hold.done;
      await reclaim.done;
      expect(reclaim.state.value).toBe(2);
      expect((await row(r2)).status).toBe("pending");
    } finally {
      hold.release();
      await hold.done.catch(() => {});
    }
  });

  it("each queue-writer micro-transaction is duration-capped; a capped attempt rolls back and is retried", async () => {
    expect(
      await boundedQueueWrite(null, "probe", async (c) =>
        [
          (await c.query("SHOW transaction_timeout")).rows[0].transaction_timeout,
          (await c.query("SHOW lock_timeout")).rows[0].lock_timeout,
        ],
      ),
    ).toEqual(["30s", "15s"]);
    let attempts = 0;
    let timeouts = 0;
    const t0 = Date.now();
    const out = await withClaimBoundsForTest(
      { queueTxTimeoutMs: 300, deadlineMs: 5_000, onLockTimeout: () => timeouts++ },
      () =>
        boundedQueueWrite(null, "probe", async (c) => {
          attempts++;
          await insertCache(c, `capped-write-${attempts}`);
          if (attempts === 1) await c.query("SELECT pg_sleep(1)"); // outlives the 300 ms cap
          return attempts;
        }),
    );
    expect(out).toBe(2);
    expect(timeouts).toBe(1);
    expect(Date.now() - t0).toBeLessThan(1_000); // killed at the cap, not after the sleep
    expect(await cacheRow("capped-write-1")).toBeNull(); // the capped attempt committed nothing
    expect(await cacheRow("capped-write-2")).not.toBeNull();
  });

  it("cancel from the web: ONE bounded attempt — a held row is QueueLockTimeoutError, then cancels once free", async () => {
    const id = await newJob();
    await claim(id);
    const hold = holdForShare(id);
    await hold.locked;
    const t0 = Date.now();
    await expect(
      withClaimBoundsForTest({ lockTimeoutMs: 300 }, () => requestCancel(id, userId)),
    ).rejects.toBeInstanceOf(QueueLockTimeoutError);
    expect(Date.now() - t0).toBeLessThan(1_500);
    hold.release();
    await hold.done;
    expect(await requestCancel(id, userId)).toBe("flagged");
  });

  // Slow (> 70 s), so opt-in: BIRDS_SLOW_BOUND_TESTS=1 npx vitest run --mode test
  //   src/lib/server/jobs-claim-db.test.ts -t "production bounds"
  // The scaled contention tests above carry the same contract in the default suite.
  it.runIf(process.env.BIRDS_SLOW_BOUND_TESTS === "1")(
    "> 70 s contention with the production bounds: the transition resolves when the holder releases",
    async () => {
      const id = await newJob();
      const b = await claim(id);
      const hold = holdForShare(id);
      await hold.locked;
      const t0 = Date.now();
      const writer = watch(runWithClaim(b, () => completeJob(id, b.attempts, {})));
      await sleep(70_000);
      expect(writer.state.settled).toBe(false); // five 15 s lock waits in, still retrying
      hold.release();
      await hold.done;
      await writer.done;
      expect(writer.state.value).toBe(true);
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeGreaterThanOrEqual(70_000);
      expect(elapsed).toBeLessThan(80_000);
      expect((await row(id)).status).toBe("succeeded");
    },
    // The bound under test (D = 150 s) needs a > 60 s hold to cross several
    // 15 s lock waits; 100 s covers the 70 s hold plus settle time.
    100_000,
  );
});

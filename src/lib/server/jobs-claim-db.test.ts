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
import { query } from "$lib/db";
import type { JobRow } from "$server/job-policy";
import {
  cancelRunningJob,
  completeJob,
  failJob,
  isStaleClaim,
  requeueInterrupted,
  runWithClaim,
  scheduleRetry,
  StaleClaimError,
  terminalizeAndReschedule,
  updateProgress,
  yieldRemainder,
} from "./jobs";
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
});

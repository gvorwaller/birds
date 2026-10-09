/**
 * Worker handlers for the blind test (td-894144 Release B4, plan rev 26
 * §B4g, §B4g2, §B4i):
 *
 *  tag_design_simulation — build the frame, size the sample, record a
 *                          `simulation` report (hard stops: missing states,
 *                          infeasible design);
 *  tag_eval_create       — draw the seeded sample from the report's frame and
 *                          create the set (> 250 needs the owner's explicit
 *                          acceptance in the payload);
 *  tag_gate_report       — compute and record the gate for a frozen set.
 *
 * Every job re-checks at execution time that its requester is an admin.
 */
import { query } from "$lib/db";
import { claimFencedQuery, isStaleClaim } from "$server/job-claim";
import { ALL_TAGS } from "$lib/species-tags";
import { sanitizeErrorText, type JobRow } from "$server/job-policy";
import { completeJob, failJob, recordClaimedEvent } from "$server/jobs";
import { designHash, tagEvalDesign } from "$server/tag-engine/eval-design";
import { buildFrame } from "$server/tag-engine/eval-frame";
import {
  createEvalSet,
  missingReferencesMessage,
  recordGateReport,
} from "$server/tag-engine/eval-sample";
import {
  PROPOSED_GATES,
  RATE_GRID,
  SIZING,
  parseGates,
  sizeDesign,
  type Stratum,
} from "$server/tag-engine/eval-stats";

/** The owner's budget from the plan's decision 5; above it the owner decides. */
export const OWNER_LABEL_BUDGET = 250;

const ID = /^[1-9][0-9]{0,18}$/;

async function isAdmin(userId: number): Promise<boolean> {
  return (
    (
      await query<{ role: string }>("SELECT role FROM users WHERE id = $1", [
        userId,
      ])
    ).rows[0]?.role === "admin"
  );
}

async function recordReport(
  kind: string,
  tag: string,
  revisionId: string,
  body: unknown,
): Promise<string> {
  // Fenced to the job's live claim (td-b99b6d): a stale job records no report.
  return (
    await claimFencedQuery<{ id: string }>(
      "SELECT public.record_tag_report($1, $2, $3, $4::jsonb)::text AS id",
      [kind, tag, revisionId, JSON.stringify(body)],
      `${kind} report`,
    )
  ).rows[0].id;
}

export interface SimulationBody {
  feasible: boolean;
  frameHash: string;
  designHash: string;
  N: Record<Stratum, number>;
  n: Record<Stratum, number>;
  total: number;
  needsOwnerDecision: boolean;
  worstPrecisionGap: number;
  worstRetentionGap: number;
  targets: typeof SIZING;
  grid: typeof RATE_GRID;
  proposedGates: typeof PROPOSED_GATES;
  noLegacyBaseline: number;
}

export async function designSimulation(
  tag: string,
  revisionId: string,
): Promise<{ reportId: string; body: SimulationBody }> {
  if (!tagEvalDesign(tag))
    throw new Error(`${tag} has no evaluation design yet`);
  const frame = await buildFrame(tag, revisionId);
  if (frame.missingStates > 0)
    throw new Error(
      `${frame.missingStates} species have no current result for this revision — run the stage report first`,
    );
  if (frame.missingReferences.length > 0)
    throw new Error(missingReferencesMessage(frame.missingReferences));
  const size = sizeDesign(frame.N);
  if (!size.feasible)
    throw new Error(
      `no sample of at most ${SIZING.cap} labels meets the design targets for this frame`,
    );
  const body: SimulationBody = {
    feasible: true,
    frameHash: frame.frameHash,
    designHash: frame.designHash,
    N: frame.N,
    n: size.n,
    total: size.total,
    needsOwnerDecision: size.total > OWNER_LABEL_BUDGET,
    worstPrecisionGap: size.worstPrecisionGap,
    worstRetentionGap: size.worstRetentionGap,
    targets: SIZING,
    grid: RATE_GRID,
    proposedGates: PROPOSED_GATES,
    noLegacyBaseline: frame.noLegacyBaseline,
  };
  return {
    reportId: await recordReport("simulation", tag, revisionId, body),
    body,
  };
}

export interface EvalCreatePayload {
  tag: string;
  revisionId: string;
  simulationReportId: string;
  gates: unknown;
  acceptOverBudget: boolean;
}

export function parseEvalCreatePayload(raw: unknown): EvalCreatePayload | null {
  const p = (raw ?? {}) as Record<string, unknown>;
  if (typeof p.tag !== "string" || !ALL_TAGS.has(p.tag)) return null;
  if (typeof p.revisionId !== "string" || !ID.test(p.revisionId)) return null;
  if (
    typeof p.simulationReportId !== "string" ||
    !ID.test(p.simulationReportId)
  )
    return null;
  try {
    parseGates(p.gates);
  } catch { // stale-safe: payload parse only
    return null;
  }
  return {
    tag: p.tag,
    revisionId: p.revisionId,
    simulationReportId: p.simulationReportId,
    gates: p.gates,
    acceptOverBudget: p.acceptOverBudget === true,
  };
}

export async function createBlindTest(
  p: EvalCreatePayload,
  userId: number,
): Promise<{ setId: string; items: number }> {
  const rep = (
    await query<{ body: SimulationBody }>(
      `SELECT body FROM tag_report WHERE id = $1 AND kind = 'simulation' AND tag = $2 AND revision_id = $3`,
      [p.simulationReportId, p.tag, p.revisionId],
    )
  ).rows[0];
  if (!rep) throw new Error("that design report is not for this tag revision");
  // Never trust a recorded body (record_tag_report is a generic recorder,
  // CODEX1 rev-26 #1): recompute every derived value from the stratum sizes —
  // which create_tag_eval_set verifies against the live frame — and refuse
  // any mismatch. Decisions (feasible, over budget) use the RECOMPUTED values.
  const verified = verifySimulationBody(p.tag, rep.body);
  if (verified.needsOwnerDecision && !p.acceptOverBudget)
    throw new Error(
      `the design needs ${verified.total} labels (over ${OWNER_LABEL_BUDGET}); confirm to accept`,
    );
  const set = await createEvalSet({
    tag: p.tag,
    revisionId: p.revisionId,
    n: verified.n,
    expectedFrameHash: rep.body.frameHash,
    gates: p.gates,
    userId,
    designExtra: {
      simulationReportId: p.simulationReportId,
      ownerAcceptedOverBudget: verified.needsOwnerDecision
        ? p.acceptOverBudget
        : null,
    },
  });
  return { setId: set.setId, items: set.items };
}

/** Key-order-independent JSON (jsonb reorders keys on the round trip). */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v as object)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  return JSON.stringify(v);
}

const STRATA_KEYS = ["A", "B", "C1", "C2", "U"] as const;

/**
 * Recompute a design from its stratum sizes and demand the recorded body
 * agrees exactly (n, total, feasible, needsOwnerDecision, design hash, sizing
 * targets and grid). Throws on any forgery or drift.
 */
export function verifySimulationBody(
  tag: string,
  raw: unknown,
): { n: Record<Stratum, number>; total: number; needsOwnerDecision: boolean } {
  const b = raw as Partial<SimulationBody> | null;
  const isCounts = (v: unknown): v is Record<Stratum, number> =>
    !!v &&
    typeof v === "object" &&
    STRATA_KEYS.every(
      (h) =>
        Number.isInteger((v as Record<string, unknown>)[h]) &&
        (v as Record<string, number>)[h] >= 0,
    ) &&
    Object.keys(v as object).length === STRATA_KEYS.length;
  if (!b || !isCounts(b.N) || !isCounts(b.n))
    throw new Error("the design report is malformed");
  if (typeof b.frameHash !== "string" || !/^[0-9a-f]{64}$/.test(b.frameHash))
    throw new Error("the design report is malformed");
  if (b.designHash !== designHash(tag))
    throw new Error(
      "the evaluation design changed since this report — run the design again",
    );
  if (
    canonical(b.targets) !== canonical(SIZING) ||
    canonical(b.grid) !== canonical(RATE_GRID)
  )
    throw new Error(
      "the sizing rules changed since this report — run the design again",
    );
  const size = sizeDesign(b.N);
  if (!size.feasible) throw new Error("the design is infeasible");
  const total = STRATA_KEYS.reduce((a, h) => a + size.n[h], 0);
  const needsOwnerDecision = total > OWNER_LABEL_BUDGET;
  const same =
    STRATA_KEYS.every((h) => size.n[h] === b.n![h]) &&
    b.total === total &&
    b.feasible === true &&
    b.needsOwnerDecision === needsOwnerDecision;
  if (!same)
    throw new Error(
      "the design report does not match its own recomputation (refused)",
    );
  return { n: size.n, total, needsOwnerDecision };
}

/** One handler for the three blind-test job types. */
export async function runTagEvalJob(job: JobRow): Promise<void> {
  const attempts = job.attempts;
  const payload = (job.payload ?? {}) as Record<string, unknown>;
  await recordClaimedEvent(job.id, { attempt: attempts });
  if (!(await isAdmin(job.requested_by))) {
    await failJob(
      job.id,
      attempts,
      `${job.type}: requester is no longer an admin`,
    );
    return;
  }
  try {
    let result: Record<string, unknown>;
    if (job.type === "tag_design_simulation") {
      const tag = payload.tag;
      const revisionId = payload.revisionId;
      if (
        typeof tag !== "string" ||
        !ALL_TAGS.has(tag) ||
        typeof revisionId !== "string" ||
        !ID.test(revisionId)
      ) {
        await failJob(job.id, attempts, `${job.type}: malformed payload`);
        return;
      }
      const r = await designSimulation(tag, revisionId);
      result = {
        reportId: r.reportId,
        total: r.body.total,
        needsOwnerDecision: r.body.needsOwnerDecision,
      };
    } else if (job.type === "tag_eval_create") {
      const p = parseEvalCreatePayload(payload);
      if (!p) {
        await failJob(job.id, attempts, `${job.type}: malformed payload`);
        return;
      }
      result = await createBlindTest(p, job.requested_by);
    } else if (job.type === "tag_gate_report") {
      const setId = payload.setId;
      if (typeof setId !== "string" || !ID.test(setId)) {
        await failJob(job.id, attempts, `${job.type}: malformed payload`);
        return;
      }
      result = await recordGateReport(setId);
    } else {
      await failJob(job.id, attempts, `no blind-test handler for ${job.type}`);
      return;
    }
    await completeJob(job.id, attempts, result);
  } catch (err) {
    if (isStaleClaim(err)) throw err;
    // A refusal (drift, infeasible, over budget, not frozen) is an answer, not a transient.
    await failJob(
      job.id,
      attempts,
      sanitizeErrorText(err instanceof Error ? err.message : String(err)).slice(
        0,
        300,
      ),
    );
  }
}

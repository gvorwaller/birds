/**
 * td-894144 B4 (plan rev 26): the blind-test jobs end to end on a fixture tag
 * — design report, seeded set, labels, freeze, gate report — plus the hard
 * stops (missing states, over budget without acceptance, malformed payload).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { query } from "$lib/db";
import type { JobRow } from "$server/job-policy";
import { stageRevision } from "./tag-engine/activation";
import { __registerEvalDesignForTests } from "./tag-engine/eval-design";
import {
  cleanupEvalSets,
  FIXTURE_GATES,
  tagEngineFixture,
} from "./tag-engine/engine-fixture.test-helper";
import { tagRepairState } from "./tag-engine/repair";
import {
  createBlindTest,
  designSimulation,
  runTagEvalJob,
  verifySimulationBody,
} from "./tag-eval-jobs";
import { designHash } from "./tag-engine/eval-design";
import { RATE_GRID, SIZING, sizeDesign } from "./tag-engine/eval-stats";

const dbUp = await query("SELECT 1")
  .then(() => true)
  .catch(() => false);
const migrated = dbUp
  ? await query(
      `SELECT to_regprocedure('public.create_tag_eval_set(text,bigint,jsonb,jsonb,jsonb,integer)') IS NOT NULL AS ok`,
    ).then((r) => r.rows[0].ok === true)
  : false;

const fx = tagEngineFixture("zzv");
const sets = { setIds: new Set<string>() };
let T = "";
let rev = "";

async function job(
  type: string,
  payload: Record<string, unknown>,
): Promise<JobRow> {
  const r = await query<JobRow>(
    `INSERT INTO jobs (type, payload, dedup_key, requested_by, label, status, attempts, started_at)
     VALUES ($1, $2, $3, $4, 'fixture', 'running', 1, now()) RETURNING *`,
    [
      type,
      JSON.stringify(payload),
      `${type}:fixture-${fx.RUN}-${Math.random().toString(36).slice(2)}`,
      fx.adminId,
    ],
  );
  fx.jobIds.add(r.rows[0].id);
  return r.rows[0];
}
const jobRow = async (id: number) =>
  (
    await query<{
      status: string;
      error: string | null;
      result: Record<string, unknown> | null;
    }>("SELECT status, error, result FROM jobs WHERE id = $1", [id])
  ).rows[0];

describe.runIf(migrated).sequential("blind-test jobs", () => {
  beforeAll(async () => {
    if ((await tagRepairState())?.pending)
      throw new Error("refusing to run while a repair is pending");
    await fx.setup(1);
    T = fx.tags[0];
    __registerEvalDesignForTests(T);
    for (const k of ["a", "b", "c", "d"]) await fx.addSpecies(k);
    await fx.addSpecies("q", { text: "A quiet fixture shorebird." });
    await fx.settleUniverse();
    await fx.approveAndActivate(T);
    await fx.retire(T);
    rev = fx.revisions[T];
  }, 240_000);

  afterAll(async () => {
    await cleanupEvalSets(sets.setIds);
    await fx.cleanup();
  }, 240_000);

  it("design refuses until every species has a result for the revision (stage first)", async () => {
    await fx.addSpecies("late");
    await fx.settleUniverse();
    await expect(designSimulation(T, rev)).rejects.toThrow(
      /run the stage report first/,
    );
    await stageRevision(T, rev);
  }, 120_000);

  it("design → set → labels → freeze → gate, all through the jobs", async () => {
    const d = await job("tag_design_simulation", { tag: T, revisionId: rev });
    await runTagEvalJob(d);
    const dr = await jobRow(d.id);
    expect(dr.status).toBe("succeeded");
    const reportId = dr.result!.reportId as string;
    const c = await job("tag_eval_create", {
      tag: T,
      revisionId: rev,
      simulationReportId: reportId,
      gates: FIXTURE_GATES,
      acceptOverBudget: false,
    });
    await runTagEvalJob(c);
    const cr = await jobRow(c.id);
    expect(cr.status).toBe("succeeded");
    const setId = cr.result!.setId as string;
    sets.setIds.add(setId);
    const items = (
      await query<{ id: string; rules_yes: boolean; labelled: boolean }>(
        `SELECT i.id::text, i.rules_yes,
                EXISTS (SELECT 1 FROM tag_eval_label l WHERE l.tag = $2 AND l.species_code = i.species_code AND l.eval_text_hash = i.eval_text_hash) AS labelled
           FROM tag_eval_item i WHERE i.set_id = $1`,
        [setId, T],
      )
    ).rows;
    for (const it of items.filter((i) => !i.labelled))
      await query("SELECT record_tag_eval_label($1, $2, $3, $4)", [
        setId,
        it.id,
        fx.adminId,
        it.rules_yes ? "yes" : "no",
      ]);
    await query("SELECT freeze_tag_eval_set($1, $2)", [setId, fx.adminId]);
    const g = await job("tag_gate_report", { setId });
    await runTagEvalJob(g);
    const gr = await jobRow(g.id);
    expect(gr.status).toBe("succeeded");
    const body = (
      await query<{ body: Record<string, unknown> }>(
        "SELECT body FROM tag_report WHERE id = $1",
        [gr.result!.reportId],
      )
    ).rows[0].body;
    expect(body).toMatchObject({ setId, passed: gr.result!.passed });
  }, 180_000);

  it("a recorded design body is never trusted: forged n/total/flags are refused (CODEX1 rev-26 #1)", async () => {
    const d = await designSimulation(T, rev);
    const forge = async (body: Record<string, unknown>) =>
      (
        await query<{ id: string }>(
          `SELECT record_tag_report('simulation', $1, $2, $3::jsonb)::text AS id`,
          [T, rev, JSON.stringify(body)],
        )
      ).rows[0].id;
    const bigger = Object.fromEntries(
      Object.entries(d.body.n).map(([h, v]) => [h, v]),
    );
    const cases = [
      { ...d.body, needsOwnerDecision: false, total: 0 }, // hide the budget
      { ...d.body, n: { ...bigger, A: (bigger.A ?? 0) + 1 } }, // inflate a stratum
      { ...d.body, feasible: false },
      { ...d.body, targets: { ...d.body.targets, precisionGap: 0.5 } },
    ];
    for (const body of cases) {
      const id = await forge(body);
      await expect(
        createBlindTest(
          {
            tag: T,
            revisionId: rev,
            simulationReportId: id,
            gates: FIXTURE_GATES,
            acceptOverBudget: true,
          },
          fx.adminId,
        ),
      ).rejects.toThrow(
        /does not match its own recomputation|infeasible|sizing rules changed/,
      );
    }
    const bad = await job("tag_eval_create", {
      tag: T,
      revisionId: rev,
      simulationReportId: d.reportId,
      gates: { version: 2 },
    });
    await runTagEvalJob(bad);
    expect((await jobRow(bad.id)).error).toMatch(/malformed payload/);
  }, 120_000);

  it("the owner's budget comes from the recomputation, not the report (over 250 needs acceptance)", () => {
    const N = { A: 300, B: 150, C1: 50, C2: 150, U: 20 };
    const size = sizeDesign(N);
    expect(size.total).toBeGreaterThan(250);
    const body = {
      feasible: true,
      frameHash: "0".repeat(64),
      designHash: designHash("habitat:open-ocean"),
      N,
      n: size.n,
      total: size.total,
      needsOwnerDecision: true,
      targets: SIZING,
      grid: RATE_GRID,
    };
    expect(verifySimulationBody("habitat:open-ocean", body)).toMatchObject({
      needsOwnerDecision: true,
      total: size.total,
    });
    expect(() =>
      verifySimulationBody("habitat:open-ocean", {
        ...body,
        needsOwnerDecision: false,
      }),
    ).toThrow(/recomputation/);
  });
});

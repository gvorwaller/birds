/**
 * td-894144 (0075): whole-taxon confirmation in a blind test. A schema-2
 * revision lists two fixture families whole. The owner confirms one, and only
 * that family's unanswered pages are answered Yes (basis taxon:family:X). A
 * page answered on its own keeps its answer, and the gate report counts the
 * answers by how they were given. Owned fixtures (zzk…) through the shared
 * engine fixture; the Preview runs over the whole test universe, so this is slow.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { query } from "$lib/db";
import { runWithClaim } from "$server/jobs";
import { approveProposal } from "$server/tag-admin";
import { createBlindTest, designSimulation } from "$server/tag-eval-jobs";
import { runTagPreviewJob } from "$server/tag-preview-job";
import { withOwnerClient } from "../tag-fixtures.test-helper";
import { stageRevision } from "./activation";
import { __registerEvalDesignForTests, tagEvalDesign } from "./eval-design";
import { recordGateReport } from "./eval-sample";
import {
  cleanupEvalSets,
  cleanupFamilyReferences,
  FIXTURE_GATES,
  seedFrameReferences,
  tagEngineFixture,
} from "./engine-fixture.test-helper";
import { previewDesignHash } from "./preview";
import { tagRepairState } from "./repair";

const dbUp = await query("SELECT 1")
  .then(() => true)
  .catch(() => false);
const migrated = dbUp
  ? await query(
      "SELECT to_regprocedure('public.confirm_tag_eval_taxa(bigint,integer,jsonb)') IS NOT NULL AS ok",
    ).then((r) => r.rows[0].ok === true)
  : false;

const fx = tagEngineFixture("zzk");
const refs = new Set<string>();
let T = "";
let rev = "";
let setId = "";
let viewerId = 0;

const artifact = () => ({
  schema: 2,
  tag: T,
  rev: `zzk-${fx.RUN}`,
  denySections: [],
  comparisonMarkers: [],
  support: [],
  exclude: [],
  taxon: [
    { id: "a_fixture", rank: "family", action: "assign", values: ["Fixtureidae"], note: "fixture family" },
    { id: "a_other", rank: "family", action: "assign", values: ["Otheridae"], note: "second fixture family" },
  ],
});

type Row = { id: string; code: string; family: string | null; label: string | null; basis: string | null };
const items = async (): Promise<Row[]> =>
  (
    await query<Row>(
      `SELECT i.id::text, i.species_code AS code, si.family_sci_name AS family, l.label, l.basis
         FROM tag_eval_item i
         JOIN species_tag_input si ON si.species_code = i.species_code
         LEFT JOIN tag_eval_label l
           ON l.tag = $2 AND l.species_code = i.species_code AND l.eval_text_hash = i.eval_text_hash
        WHERE i.set_id = $1 ORDER BY i.species_code`,
      [setId, T],
    )
  ).rows;
const confirm = (taxa: unknown, user = fx.adminId) =>
  query<{ n: number }>("SELECT public.confirm_tag_eval_taxa($1, $2, $3::jsonb) AS n", [
    setId,
    user,
    JSON.stringify(taxa),
  ]);
const label = (itemId: string, value: string) =>
  query("SELECT public.record_tag_eval_label($1, $2, $3, $4)", [setId, itemId, fx.adminId, value]);

describe.runIf(migrated).sequential("0075: confirm whole taxa in a blind test", () => {
  beforeAll(async () => {
    if ((await tagRepairState())?.pending)
      throw new Error("refusing to run while a repair is pending");
    await fx.setup(1);
    T = fx.tags[0];
    __registerEvalDesignForTests(T);
    for (const k of ["a", "b", "c"]) await fx.addSpecies(k);
    for (const k of ["x", "y"]) await fx.addSpecies(k, { family: "Otheridae" });
    await fx.settleUniverse();
    await fx.asOwner("INSERT INTO tag_preview_design (tag, design_hash) VALUES ($1, $2)", [
      T,
      previewDesignHash(T, tagEvalDesign(T)!),
    ]);
    viewerId = (
      await query<{ id: number }>(
        `INSERT INTO users (username, display_name, password_hash, role)
         VALUES ($1, 'Confirm viewer', '!unset', 'viewer') RETURNING id`,
        [`zzk-viewer-${fx.RUN}`],
      )
    ).rows[0].id;

    // A schema-2 revision listing both fixture families whole:
    // proposal → Preview (in-process) → cross-check → approve.
    const proposalId = (
      await query<{ id: string }>(
        "SELECT public.create_human_tag_proposal($1, $2::jsonb, $3)::text AS id",
        [T, JSON.stringify(artifact()), fx.adminId],
      )
    ).rows[0].id;
    fx.proposals.push(proposalId);
    const jobId = (
      await query<{ id: number }>(
        `INSERT INTO jobs (type, payload, requested_by, label, max_attempts)
         VALUES ('tag_preview', $1, $2, 'zzk preview', 2) RETURNING id`,
        [JSON.stringify({ proposalId, tag: T }), fx.adminId],
      )
    ).rows[0].id;
    const job = await fx.claim(jobId);
    const claimed = (
      await query("UPDATE jobs SET claim_seq = claim_seq + 1 WHERE id = $1 RETURNING *", [job.id])
    ).rows[0];
    await runWithClaim(claimed as never, () => runTagPreviewJob(claimed as never));
    await withOwnerClient((c) =>
      c.query("SELECT public.record_tag_crosscheck($1, 'CODEX1', 'approve', 'fixture review')", [proposalId]),
    );
    rev = await approveProposal(proposalId, fx.adminId);
    fx.revisions[T] = rev;

    await stageRevision(T, rev);
    for (const c of await seedFrameReferences(T, rev)) refs.add(c);
    const design = await designSimulation(T, rev);
    setId = (
      await createBlindTest(
        { tag: T, revisionId: rev, simulationReportId: design.reportId, gates: FIXTURE_GATES, acceptOverBudget: true },
        fx.adminId,
      )
    ).setId;
  }, 900_000);

  afterAll(async () => {
    if (setId) await cleanupEvalSets([setId]);
    await cleanupFamilyReferences(refs);
    if (viewerId) await query("DELETE FROM users WHERE id = $1", [viewerId]);
    await fx.asOwner("DELETE FROM tag_preview_design WHERE tag = $1", [T]);
    await fx.cleanup();
  }, 600_000);

  it("only listed taxa, only admins, never an empty list — and a refusal writes nothing", async () => {
    await expect(confirm([{ rank: "family", value: "Procellariidae" }])).rejects.toThrow(
      /only taxa the revision lists/,
    );
    await expect(confirm([{ rank: "genus", value: "Fixtureidae" }])).rejects.toThrow(
      /only taxa the revision lists/,
    );
    await expect(confirm([])).rejects.toThrow(/no taxa/);
    await expect(confirm([{ rank: "family", value: "Fixtureidae" }], viewerId)).rejects.toThrow(/not an admin/);
    expect((await items()).every((r) => r.label === null)).toBe(true);
  });

  it("a confirmed family's unanswered pages become Yes (basis recorded); its page answered on its own and every other family are untouched", async () => {
    const fixture = (await items()).filter((r) => r.family === "Fixtureidae");
    expect(fixture.length).toBe(3);
    await label(fixture[0].id, "no");
    const n = (await confirm([{ rank: "family", value: "Fixtureidae" }])).rows[0].n;
    expect(n).toBe(2);
    for (const r of await items()) {
      if (r.code === fixture[0].code) expect([r.label, r.basis]).toEqual(["no", "page"]);
      else if (r.family === "Fixtureidae") expect([r.label, r.basis]).toEqual(["yes", "taxon:family:Fixtureidae"]);
      else expect(r.label).toBeNull();
    }
    expect((await confirm([{ rank: "family", value: "Fixtureidae" }])).rows[0].n).toBe(0);
  });

  it("the gate report counts answers by how they were given; a frozen set refuses confirmations", async () => {
    for (const r of (await items()).filter((x) => x.label === null)) await label(r.id, "yes");
    await query("SELECT public.freeze_tag_eval_set($1, $2)", [setId, fx.adminId]);
    await expect(confirm([{ rank: "family", value: "Otheridae" }])).rejects.toThrow(/not labelling/);
    const { reportId } = await recordGateReport(setId);
    const body = (
      await query<{ body: { labelBasis: Record<string, number> } }>("SELECT body FROM tag_report WHERE id = $1", [
        reportId,
      ])
    ).rows[0].body;
    const all = await items();
    expect(body.labelBasis).toEqual({
      page: all.filter((r) => r.basis === "page").length,
      "taxon:family:Fixtureidae": 2,
    });
  });
});

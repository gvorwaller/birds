/**
 * td-894144 (0075–0077): whole-taxon confirmation in a blind test. A
 * schema-2 revision lists two fixture families whole.
 *
 * - The owner confirms one; only that family's unanswered pages get the set's
 *   Yes, stored SET-LOCALLY (tag_eval_taxon_answer), never as reusable page
 *   labels. A page answered on its own keeps its answer, and a confirmed item
 *   refuses a later page label.
 * - A later set does NOT inherit the confirmation, but does reuse page labels.
 * - A set whose frame has moved refuses confirmations.
 * - The gate report counts answers by how they were given.
 * - Races (0077): a page answer and a confirmation of the same item, in two
 *   sessions, serialize on the item row; whichever commits first wins.
 * - Pages name the bird (eval text v3): a new set records its text version,
 *   nothing is masked, and the label page shows exactly the frozen page its
 *   answer is keyed to; a set the older code made never shows a page.
 *
 * Owned fixtures (zzk…) through the shared engine fixture. The Preview runs
 * over the whole test universe, so this is slow.
 */
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { query } from "$lib/db";
import { runWithClaim } from "$server/jobs";
import { approveProposal, nextLabelItem } from "$server/tag-admin";
import { createBlindTest, designSimulation } from "$server/tag-eval-jobs";
import { runTagPreviewJob } from "$server/tag-preview-job";
import { withOwnerClient } from "../tag-fixtures.test-helper";
import { stageRevision } from "./activation";
import { EVAL_TEXT_VERSION, __registerEvalDesignForTests, tagEvalDesign } from "./eval-design";
import { buildFrame } from "./eval-frame";
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
  ? await query("SELECT to_regclass('public.tag_eval_taxon_answer') IS NOT NULL AS ok").then(
      (r) => r.rows[0].ok === true,
    )
  : false;

const fx = tagEngineFixture("zzk");
const refs = new Set<string>();
const setIds: string[] = [];
let T = "";
let rev = "";
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

/** A new blind test for the revision (design + start); tracked for cleanup. */
async function newSet(): Promise<string> {
  for (const c of await seedFrameReferences(T, rev)) refs.add(c);
  const design = await designSimulation(T, rev);
  const { setId } = await createBlindTest(
    { tag: T, revisionId: rev, simulationReportId: design.reportId, gates: FIXTURE_GATES, acceptOverBudget: true },
    fx.adminId,
  );
  setIds.push(setId);
  return setId;
}

type Row = { id: string; code: string; family: string | null; label: string | null; taxon: string | null };
/** Each item of a set with its page label (global, by page key) and its set's taxon answer. */
const items = async (setId: string): Promise<Row[]> =>
  (
    await query<Row>(
      `SELECT i.id::text, i.species_code AS code, si.family_sci_name AS family, l.label, ta.taxon
         FROM tag_eval_item i
         JOIN species_tag_input si ON si.species_code = i.species_code
         LEFT JOIN tag_eval_label l
           ON l.tag = $2 AND l.species_code = i.species_code AND l.eval_text_hash = i.eval_text_hash
         LEFT JOIN tag_eval_taxon_answer ta ON ta.item_id = i.id
        WHERE i.set_id = $1 ORDER BY i.species_code`,
      [setId, T],
    )
  ).rows;
const confirm = (setId: string, taxa: unknown, user = fx.adminId) =>
  query<{ n: number }>("SELECT public.confirm_tag_eval_taxa($1, $2, $3::jsonb) AS n", [
    setId,
    user,
    JSON.stringify(taxa),
  ]);
const label = (setId: string, itemId: string, value: string) =>
  query("SELECT public.record_tag_eval_label($1, $2, $3, $4)", [setId, itemId, fx.adminId, value]);
const FIXTURE = [{ rank: "family", value: "Fixtureidae" }];
/** Fixture species "a" gets an article that names it (common and scientific name). */
const NAMED = `zzk${fx.RUN}a`;
const NAMED_TEXT = `The zzk ${NAMED} Plover (Zzkia ${NAMED}) is a shorebird of the fixture coast.`;
const OTHER = [{ rank: "family", value: "Otheridae" }];

/** A second, independent app-role session on the isolated test DB (for the race tests). */
async function appSession(): Promise<{ c: pg.Client; pid: number }> {
  const env = Object.fromEntries(
    readFileSync(new URL("../../../../.env.test", import.meta.url), "utf8")
      .split("\n")
      .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/))
      .filter((m): m is RegExpMatchArray => m != null)
      .map((m) => [m[1], m[2].replace(/^['"]|['"]$/g, "")]),
  );
  if (env.PGPORT !== "15436" || env.PGDATABASE !== "birds_test")
    throw new Error("race sessions: isolated birds_test only");
  const c = new pg.Client({
    host: env.PGHOST,
    port: Number(env.PGPORT),
    database: env.PGDATABASE,
    user: env.PGUSER,
    password: env.PGPASSWORD,
  });
  await c.connect();
  const pid = (await c.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  return { c, pid };
}
/** Wait until `pid` is blocked on a lock, proving the second session really waits. */
async function blockedOnLock(pid: number): Promise<void> {
  for (let i = 0; i < 120; i++) {
    const r = await query<{ w: string | null }>("SELECT wait_event_type AS w FROM pg_stat_activity WHERE pid = $1", [
      pid,
    ]);
    if (r.rows[0]?.w === "Lock") return;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`session ${pid} never blocked on a lock`);
}

describe.runIf(migrated).sequential("0076/0077: set-local whole-taxon confirmation in a blind test", () => {
  let A = "";
  let B = "";
  beforeAll(async () => {
    if ((await tagRepairState())?.pending)
      throw new Error("refusing to run while a repair is pending");
    await fx.setup(1);
    T = fx.tags[0];
    __registerEvalDesignForTests(T);
    for (const k of ["a", "b", "c"]) await fx.addSpecies(k, k === "a" ? { text: NAMED_TEXT } : {});
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
    // proposal → Preview (in-process) → cross-check → approve → stage.
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
    A = await newSet();
  }, 900_000);

  afterAll(async () => {
    await cleanupEvalSets(setIds);
    await cleanupFamilyReferences(refs);
    if (viewerId) await query("DELETE FROM users WHERE id = $1", [viewerId]);
    await fx.asOwner("DELETE FROM tag_preview_design WHERE tag = $1", [T]);
    await fx.cleanup();
  }, 600_000);

  it("only listed taxa, only admins, never an empty list, and a refusal writes nothing", async () => {
    await expect(confirm(A, [{ rank: "family", value: "Procellariidae" }])).rejects.toThrow(
      /only taxa the revision lists/,
    );
    await expect(confirm(A, [{ rank: "genus", value: "Fixtureidae" }])).rejects.toThrow(
      /only taxa the revision lists/,
    );
    await expect(confirm(A, [])).rejects.toThrow(/no taxa/);
    await expect(confirm(A, FIXTURE, viewerId)).rejects.toThrow(/not an admin/);
    expect((await items(A)).every((r) => r.label === null && r.taxon === null)).toBe(true);
  });

  it("a new blind test records its text version; the label page names the bird, masks nothing, and shows exactly the frozen page its answer is keyed to", async () => {
    expect(
      (await query<{ v: string | null }>("SELECT design->>'evalTextVersion' AS v FROM tag_eval_set WHERE id = $1", [A]))
        .rows[0].v,
    ).toBe(EVAL_TEXT_VERSION);
    const frozen = (
      await query<{
        id: string;
        code: string;
        article: unknown;
        family_reference: { title: string; displayLead: string } | null;
        eval_text_hash: string;
        com_name: string;
        sci_name: string;
      }>(
        `SELECT i.id::text, i.species_code AS code, i.article, i.family_reference, i.eval_text_hash,
                tc.com_name, tc.sci_name
           FROM tag_eval_item i JOIN taxonomy_cache tc ON tc.species_code = i.species_code
          WHERE i.set_id = $1`,
        [A],
      )
    ).rows;
    // Nothing is masked; the article that names its bird keeps both names.
    expect(JSON.stringify(frozen.map((r) => [r.article, r.family_reference]))).not.toMatch(/\[this bird\]|\[genus\]/);
    const named = frozen.find((r) => r.code === NAMED)!;
    expect(JSON.stringify(named.article)).toContain(named.com_name);
    expect(JSON.stringify(named.article)).toContain(named.sci_name);
    // Each frozen page is the page the current code builds, under the hash its answer is keyed to.
    const frame = await buildFrame(T, rev);
    for (const r of frozen) {
      const f = frame.rows.find((x) => x.code === r.code)!;
      expect([f.evalTextHash, f.evalText]).toEqual([r.eval_text_hash, r.article]);
    }
    // The label page shows the next frozen page exactly, under the bird's own names.
    const page = (await nextLabelItem(T, A))!;
    const shown = frozen.find((r) => r.id === page.itemId)!;
    expect(page.species).toEqual({ comName: shown.com_name, sciName: shown.sci_name });
    expect(page.sections).toEqual(shown.article);
    expect(page.familyReference).toEqual(
      shown.family_reference
        ? { title: shown.family_reference.title, displayLead: shown.family_reference.displayLead }
        : null,
    );
  });

  it("a confirmed family's unanswered pages get the set's Yes (set-local, no page label); a page answered on its own keeps its answer; a confirmed item refuses a page label", async () => {
    const fixture = (await items(A)).filter((r) => r.family === "Fixtureidae");
    expect(fixture.length).toBe(3);
    await label(A, fixture[0].id, "no");
    expect((await confirm(A, FIXTURE)).rows[0].n).toBe(2);
    for (const r of await items(A)) {
      if (r.code === fixture[0].code) expect([r.label, r.taxon]).toEqual(["no", null]);
      else if (r.family === "Fixtureidae") expect([r.label, r.taxon]).toEqual([null, "family:Fixtureidae"]);
      else expect([r.label, r.taxon]).toEqual([null, null]);
    }
    const confirmedItem = (await items(A)).find((r) => r.taxon)!;
    await expect(label(A, confirmedItem.id, "yes")).rejects.toThrow(/family confirmation/);
    expect((await confirm(A, FIXTURE)).rows[0].n).toBe(0);
  });

  it("a later blind test inherits page labels but NOT another set's family confirmation", async () => {
    await query("SELECT public.abandon_tag_eval_set($1, $2)", [A, fx.adminId]);
    B = await newSet();
    const fixture = (await items(B)).filter((r) => r.family === "Fixtureidae");
    expect(fixture.length).toBe(3);
    // The page answered on its own in A ("no") is reused; the two confirmed pages are not.
    expect(fixture.filter((r) => r.label === "no")).toHaveLength(1);
    expect(fixture.filter((r) => r.label === null && r.taxon === null)).toHaveLength(2);
  });

  it("race: a page answer in flight makes a concurrent confirmation of that item wait, then skip it", async () => {
    const other = (await items(B)).filter((r) => r.family === "Otheridae");
    expect(other.filter((r) => r.label === null && r.taxon === null)).toHaveLength(2);
    const s1 = await appSession();
    const s2 = await appSession();
    try {
      await s1.c.query("BEGIN");
      await s1.c.query("SELECT public.record_tag_eval_label($1, $2, $3, 'no')", [B, other[0].id, fx.adminId]);
      const pending = s2.c.query<{ n: number }>("SELECT public.confirm_tag_eval_taxa($1, $2, $3::jsonb) AS n", [
        B,
        fx.adminId,
        JSON.stringify(OTHER),
      ]);
      await blockedOnLock(s2.pid);
      await s1.c.query("COMMIT");
      expect((await pending).rows[0].n).toBe(1);
    } finally {
      await s1.c.end();
      await s2.c.end();
    }
    const after = await items(B);
    expect(after.filter((r) => r.id === other[0].id).map((r) => [r.label, r.taxon])).toEqual([["no", null]]);
    expect(after.filter((r) => r.id === other[1].id).map((r) => [r.label, r.taxon])).toEqual([
      [null, "family:Otheridae"],
    ]);
  }, 30_000);

  it("race: a confirmation in flight makes a concurrent page answer of one of its items wait, then refuses it", async () => {
    const fixture = (await items(B)).filter((r) => r.family === "Fixtureidae" && r.label === null && r.taxon === null);
    expect(fixture).toHaveLength(2);
    const s1 = await appSession();
    const s2 = await appSession();
    try {
      await s1.c.query("BEGIN");
      const n = (
        await s1.c.query<{ n: number }>("SELECT public.confirm_tag_eval_taxa($1, $2, $3::jsonb) AS n", [
          B,
          fx.adminId,
          JSON.stringify(FIXTURE),
        ])
      ).rows[0].n;
      expect(n).toBe(2);
      const pending = s2.c.query("SELECT public.record_tag_eval_label($1, $2, $3, 'no')", [B, fixture[0].id, fx.adminId]);
      const settled = pending.then(
        () => "labelled",
        (e: Error) => e.message,
      );
      await blockedOnLock(s2.pid);
      await s1.c.query("COMMIT");
      expect(await settled).toMatch(/family confirmation/);
    } finally {
      await s1.c.end();
      await s2.c.end();
    }
    const after = (await items(B)).filter((r) => r.id === fixture[0].id);
    expect(after.map((r) => [r.label, r.taxon])).toEqual([[null, "family:Fixtureidae"]]);
  }, 30_000);

  it("the gate report counts answers by how they were given; a frozen set refuses confirmations", async () => {
    for (const r of (await items(B)).filter((x) => x.label === null && x.taxon === null)) await label(B, r.id, "yes");
    await query("SELECT public.freeze_tag_eval_set($1, $2)", [B, fx.adminId]);
    await expect(confirm(B, FIXTURE)).rejects.toThrow(/not labelling/);
    const { reportId } = await recordGateReport(B);
    const body = (
      await query<{ body: { labelBasis: Record<string, number> } }>("SELECT body FROM tag_report WHERE id = $1", [
        reportId,
      ])
    ).rows[0].body;
    const all = await items(B);
    expect(body.labelBasis).toEqual({
      page: all.filter((r) => r.taxon === null).length,
      "taxon:family:Otheridae": 1,
      "taxon:family:Fixtureidae": 2,
    });
  });

  it("a blind test whose frame has moved refuses confirmations and writes nothing", async () => {
    const C = await newSet();
    await fx.addSpecies("late");
    await fx.settleUniverse();
    await stageRevision(T, rev);
    await expect(confirm(C, FIXTURE)).rejects.toThrow(/species data changed/);
    expect((await items(C)).every((r) => r.taxon === null)).toBe(true);
  }, 300_000);

  it("a blind test the older code made (no recorded text version) never shows a page", async () => {
    // As the older code made it: the open set C copied without its text
    // version (C is abandoned first: one open set per revision).
    const C = setIds[setIds.length - 1];
    await query("SELECT public.abandon_tag_eval_set($1, $2)", [C, fx.adminId]);
    const old = await withOwnerClient(async (c) => {
      const id = (
        await c.query<{ id: string }>(
          `INSERT INTO tag_eval_set (tag, revision_id, design, frame_hash, gates, gates_sha256, gates_confirmed_by)
           SELECT tag, revision_id, design - 'evalTextVersion', frame_hash, gates, gates_sha256, gates_confirmed_by
             FROM tag_eval_set WHERE id = $1 RETURNING id::text`,
          [C],
        )
      ).rows[0].id;
      await c.query(
        `INSERT INTO tag_eval_item (set_id, species_code, stratum, rules_yes, legacy_yes, rules_status, marine,
                                    inclusion_prob, display_position, input_hash, eval_text_hash, article, family_reference)
         SELECT $2, species_code, stratum, rules_yes, legacy_yes, rules_status, marine,
                inclusion_prob, display_position, input_hash, eval_text_hash, article, family_reference
           FROM tag_eval_item WHERE set_id = $1`,
        [C, id],
      );
      return id;
    });
    setIds.push(old);
    // It has unanswered pages, yet the label page gets none of them.
    expect((await items(old)).some((r) => r.label === null && r.taxon === null)).toBe(true);
    expect(await nextLabelItem(T, old)).toBeNull();
    expect(await nextLabelItem(T, setIds[0])).toBeNull(); // abandoned: closed, as before
  });
});

/**
 * td-894144 (0078, owner 2026-10-04): the owner may activate a revision whose
 * blind test did not pass, by accepting that result. Against real birds_test
 * SQL, the switch definer:
 *
 * - refuses a failed gate without the acceptance, exactly as before;
 * - refuses to accept a failed gate that tags a must-not bird;
 * - refuses an acceptance requested by a non-admin;
 * - with an admin's acceptance, activates and records it on tag_activation;
 *   every other check (frozen set, gates hash, frame, benchmark) still runs.
 *
 * Owned fixtures (zzq…) through the shared engine fixture; all removed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { query } from "$lib/db";
import { activateRevision, stageRevision } from "./activation";
import { __registerEvalDesignForTests } from "./eval-design";
import {
  censusGate,
  cleanupEvalSets,
  cleanupFamilyReferences,
  tagEngineFixture,
} from "./engine-fixture.test-helper";
import { tagRepairState } from "./repair";

const dbUp = await query("SELECT 1")
  .then(() => true)
  .catch(() => false);
const migrated = dbUp
  ? await query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = 'tag_activation' AND column_name = 'gate_accepted_failed') AS ok`,
    ).then((r) => r.rows[0].ok === true)
  : false;

const fx = tagEngineFixture("zzq");
const sets = { setIds: new Set<string>(), refs: new Set<string>() };
let T = "";
let T2 = "";
let rev = "";
let viewerId = 0;
const allNo = () => "no" as const;
/** The census gate every page of which was answered No (precision 0): it did not pass. */
let failed = { gate: "", bench: "" };

const owner = async () =>
  (await query<{ activation_id: string }>("SELECT activation_id::text FROM tag_ownership WHERE tag = $1", [T])).rows[0]
    ?.activation_id ?? null;

describe.runIf(migrated).sequential("0078: accepting a blind test that did not pass", () => {
  beforeAll(async () => {
    if ((await tagRepairState())?.pending) throw new Error("refusing to run while a repair is pending");
    await fx.setup(2);
    [T, T2] = fx.tags;
    __registerEvalDesignForTests(T);
    __registerEvalDesignForTests(T2);
    for (const k of ["a", "b", "c"]) await fx.addSpecies(k);
    await fx.settleUniverse();
    rev = await fx.approve(T);
    await stageRevision(T, rev);
    viewerId = (
      await query<{ id: number }>(
        `INSERT INTO users (username, display_name, password_hash, role)
         VALUES ($1, 'Gate viewer', '!unset', 'viewer') RETURNING id`,
        [`zzq-viewer-${fx.RUN}`],
      )
    ).rows[0].id;
  }, 240_000);

  afterAll(async () => {
    await cleanupEvalSets(sets.setIds);
    await cleanupFamilyReferences(sets.refs);
    await fx.cleanup();
    if (viewerId) await query("DELETE FROM users WHERE id = $1", [viewerId]);
  }, 240_000);

  it("a failed gate that tags a must-not bird is refused, with or without the acceptance", async () => {
    // Every page answered No: precision 0, no must-not violation.
    const g = await censusGate(T, rev, fx.adminId, sets, { label: allNo, allowFail: true });
    expect(g.passed).toBe(false);
    failed = { gate: g.gate, bench: g.bench };
    expect(
      (await query<{ v: unknown }>("SELECT body->'namedCaseViolations' AS v FROM tag_report WHERE id = $1", [g.gate]))
        .rows[0].v,
    ).toEqual([]);
    // The same report as if a must-not bird were tagged. (Fixture codes are
    // too long for gate JSON, so the violation is written into a copy of the
    // body: what is under test is the definer reading it.)
    const tainted = (
      await query<{ id: string }>(
        `SELECT record_tag_report('gate', $1, $2, body || '{"namedCaseViolations": ["amekes"]}'::jsonb)::text AS id
           FROM tag_report WHERE id = $3`,
        [T, rev, g.gate],
      )
    ).rows[0].id;
    const activate = (accept: boolean) =>
      activateRevision({
        tag: T,
        revisionId: rev,
        gateReportId: tainted,
        benchmarkReportId: g.bench,
        acceptFailedGate: accept,
        userId: fx.adminId,
      });
    await expect(activate(false)).rejects.toThrow(/no passing gate report/);
    await expect(activate(true)).rejects.toThrow(/cannot be accepted/);
    expect(await owner()).toBeNull();
  }, 120_000);

  it("a failed gate with no must-not violation: refused without the acceptance and for a non-admin; an admin's acceptance activates and is recorded", async () => {
    const g = failed;
    expect(g.gate).not.toBe("");
    const activate = (accept: boolean, userId: number) =>
      activateRevision({
        tag: T,
        revisionId: rev,
        gateReportId: g.gate,
        benchmarkReportId: g.bench,
        acceptFailedGate: accept,
        userId,
      });
    await expect(activate(false, fx.adminId)).rejects.toThrow(/no passing gate report/);
    await expect(activate(true, viewerId)).rejects.toThrow(/not an admin/);
    expect(await owner()).toBeNull();

    const id = await activate(true, fx.adminId);
    expect(id).not.toBeNull();
    fx.activationIds.add(Number(id));
    expect(await owner()).toBe(id);
    const row = (
      await query<{ gate: string; bench: string; accepted: boolean; by: number }>(
        `SELECT gate_report_id::text AS gate, benchmark_report_id::text AS bench,
                gate_accepted_failed AS accepted, activated_by AS by
           FROM tag_activation WHERE id = $1`,
        [id],
      )
    ).rows[0];
    expect(row).toEqual({ gate: g.gate, bench: g.bench, accepted: true, by: fx.adminId });
  }, 120_000);

  it("a passing gate never records an acceptance, even when one is offered", async () => {
    // A second fixture tag: its pages carry no answers yet, so the census gate
    // labelled by the rules passes.
    const rev2 = await fx.approve(T2);
    await stageRevision(T2, rev2);
    const g = await censusGate(T2, rev2, fx.adminId, sets);
    expect(g.passed).toBe(true);
    const id = await activateRevision({
      tag: T2,
      revisionId: rev2,
      gateReportId: g.gate,
      benchmarkReportId: g.bench,
      acceptFailedGate: true,
      userId: fx.adminId,
    });
    expect(id).not.toBeNull();
    fx.activationIds.add(Number(id));
    expect(
      (await query<{ accepted: boolean }>("SELECT gate_accepted_failed AS accepted FROM tag_activation WHERE id = $1", [id]))
        .rows[0].accepted,
    ).toBe(false);
  }, 120_000);
});

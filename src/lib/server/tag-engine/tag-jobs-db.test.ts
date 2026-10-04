/**
 * td-894144 Release B3 — the owner-operation jobs (tag_stage, tag_benchmark,
 * tag_activate, tag_rollback, tag_retire): payload validation, execution-time
 * admin recheck, cancel only before the engine lock, and the reports they
 * record. Owned fixtures (zzj…) through the shared engine fixture.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { query } from "$lib/db";
import { requestCancel } from "$server/jobs";
import { parseTagOpPayload, runTagOpJob } from "../tag-jobs";
import { tagEngineFixture } from "./engine-fixture.test-helper";
import { tagRepairState } from "./repair";

const dbUp = await query("SELECT 1")
  .then(() => true)
  .catch(() => false);
const migrated = dbUp
  ? await query(
      `SELECT to_regclass('public.tag_legacy_baseline') IS NOT NULL AS ok`,
    ).then((r) => r.rows[0].ok === true)
  : false;

describe("parseTagOpPayload", () => {
  it("accepts only vocabulary tags and positive integer ids, per type", () => {
    expect(
      parseTagOpPayload("tag_retire", { tag: "habitat:open-ocean" }),
    ).toEqual({ tag: "habitat:open-ocean" });
    expect(
      parseTagOpPayload("tag_retire", { tag: "habitat:nowhere" }),
    ).toBeNull();
    expect(
      parseTagOpPayload("tag_stage", {
        tag: "habitat:open-ocean",
        revisionId: "12",
      }),
    ).toEqual({
      tag: "habitat:open-ocean",
      revisionId: "12",
    });
    expect(
      parseTagOpPayload("tag_stage", {
        tag: "habitat:open-ocean",
        revisionId: 12,
      }),
    ).toBeNull();
    expect(
      parseTagOpPayload("tag_stage", {
        tag: "habitat:open-ocean",
        revisionId: "0",
      }),
    ).toBeNull();
    expect(
      parseTagOpPayload("tag_activate", {
        tag: "habitat:open-ocean",
        revisionId: "1",
        gateReportId: "2",
      }),
    ).toBeNull();
    expect(
      parseTagOpPayload("tag_activate", {
        tag: "habitat:open-ocean",
        revisionId: "1",
        gateReportId: "2",
        benchmarkReportId: "3",
      }),
    ).toMatchObject({ benchmarkReportId: "3" });
    expect(
      parseTagOpPayload("tag_consistency", { tag: "habitat:open-ocean" }),
    ).toBeNull();
  });

  it("tag_activate carries the owner's acceptance of a failed gate only as literal true (0078)", () => {
    const base = {
      tag: "habitat:open-ocean",
      revisionId: "1",
      gateReportId: "2",
      benchmarkReportId: "3",
    };
    expect(parseTagOpPayload("tag_activate", base)).toEqual(base);
    expect(
      parseTagOpPayload("tag_activate", { ...base, acceptFailedGate: true }),
    ).toEqual({ ...base, acceptFailedGate: true });
    for (const bad of ["yes", "true", 1, false, null])
      expect(
        parseTagOpPayload("tag_activate", { ...base, acceptFailedGate: bad }),
      ).toBeNull();
  });
});

const fx = tagEngineFixture("zzj");
const S: Record<string, string> = {};

async function op(type: string, payload: Record<string, unknown>) {
  const id = (
    await query<{ id: number }>(
      `INSERT INTO jobs (type, payload, dedup_key, requested_by, label) VALUES ($1, $2, $3, $4, 'fixture') RETURNING id`,
      [
        type,
        JSON.stringify(payload),
        `${type}:fixture-${fx.RUN}-${Math.random().toString(36).slice(2)}`,
        fx.adminId,
      ],
    )
  ).rows[0].id;
  fx.jobIds.add(id);
  return id;
}

async function runOp(type: string, payload: Record<string, unknown>) {
  const id = await op(type, payload);
  await runTagOpJob(await fx.claim(id));
  const row = await fx.jobRow(id);
  const act = row.result?.activationId;
  if (typeof act === "string") fx.activationIds.add(Number(act));
  return row;
}

const owned = async (tag: string) =>
  (
    await query<{ revision_id: string | null }>(
      `SELECT a.revision_id::text FROM tag_ownership o JOIN tag_activation a ON a.id = o.activation_id WHERE o.tag = $1`,
      [tag],
    )
  ).rows[0] ?? null;

describe.runIf(migrated).sequential("tag operation jobs (0068)", () => {
  let T = "";
  let rev = "";
  beforeAll(async () => {
    if ((await tagRepairState())?.pending)
      throw new Error("refusing to run while a repair is pending");
    await fx.setup(1);
    T = fx.tags[0];
    for (const k of ["a", "b"]) S[k] = await fx.addSpecies(k);
    S.quiet = await fx.addSpecies("quiet", {
      text: "A quiet fixture shorebird.",
    });
    await fx.settleUniverse();
    // Approve (fixture helper) then retire straight away, so the revision
    // and its passing reports exist but the tag is unowned for the ops.
    await fx.approveAndActivate(T);
    await fx.retire(T);
    rev = fx.revisions[T];
    expect(await owned(T)).toBeNull();
  }, 240_000);

  afterAll(async () => {
    await fx.cleanup();
  }, 240_000);

  it("tag_stage records a stage report: counts, would-add samples with evidence, would-remove", async () => {
    const row = await runOp("tag_stage", { tag: T, revisionId: rev });
    expect(row.status).toBe("succeeded");
    const report = (
      await query<{
        kind: string;
        body: {
          counts: Record<string, number>;
          samples: { adds: { code: string }[] };
        };
      }>("SELECT kind, body FROM tag_report WHERE id = $1", [
        row.result!.reportId,
      ])
    ).rows[0];
    expect(report.kind).toBe("stage");
    expect(report.body.counts.assigned).toBeGreaterThanOrEqual(2);
    expect(report.body.counts.would_remove).toBe(fx.realCarriersBefore.length);
    expect(report.body.samples.adds.map((a) => a.code)).toEqual(
      expect.arrayContaining([S.a, S.b]),
    );
  }, 120_000);

  it("tag_benchmark dry-runs the real switch: passing report with timing and WAL, nothing persisted", async () => {
    const reportsBefore = Number(
      (
        await query<{ n: string }>(
          "SELECT count(*)::text AS n FROM tag_report WHERE revision_id = $1",
          [rev],
        )
      ).rows[0].n,
    );
    const row = await runOp("tag_benchmark", { tag: T, revisionId: rev });
    expect(row.status).toBe("succeeded");
    expect(row.result).toMatchObject({ passed: true });
    expect(row.result!.walBytes as number).toBeGreaterThan(0);
    expect(row.result!.totalMs as number).toBeGreaterThanOrEqual(
      (row.result!.inputsMs as number) +
        (row.result!.driftMs as number) +
        (row.result!.switchMs as number),
    );
    expect(await owned(T)).toBeNull();
    // Only the benchmark report itself survives — the provisional ones rolled back.
    const kinds = (
      await query<{ kind: string; provisional: string | null }>(
        `SELECT kind, body->>'provisional' AS provisional FROM tag_report WHERE revision_id = $1 ORDER BY id DESC LIMIT 1`,
        [rev],
      )
    ).rows;
    expect(kinds).toEqual([{ kind: "benchmark", provisional: null }]);
    expect(
      Number(
        (
          await query<{ n: string }>(
            "SELECT count(*)::text AS n FROM tag_report WHERE revision_id = $1",
            [rev],
          )
        ).rows[0].n,
      ),
    ).toBe(reportsBefore + 1);
  }, 120_000);

  it("a non-admin requester is refused at execution time; a malformed payload fails terminally", async () => {
    await query(`UPDATE users SET role = 'user' WHERE id = $1`, [fx.adminId]);
    try {
      const row = await runOp("tag_retire", { tag: T });
      expect(row).toMatchObject({ status: "failed" });
      expect(row.error).toMatch(/no longer an admin/);
    } finally {
      await query(`UPDATE users SET role = 'admin' WHERE id = $1`, [
        fx.adminId,
      ]);
    }
    const bad = await runOp("tag_stage", { tag: T, revisionId: "x" });
    expect(bad).toMatchObject({ status: "failed" });
    expect(bad.error).toMatch(/malformed payload/);
  }, 60_000);

  it("cancel is honoured before the lock: a flagged activation never switches", async () => {
    const id = await op("tag_activate", {
      tag: T,
      revisionId: rev,
      gateReportId: fx.reports[T].gate,
      benchmarkReportId: fx.reports[T].bench,
    });
    const job = await fx.claim(id);
    expect(await requestCancel(id, fx.adminId)).toBe("flagged");
    await runTagOpJob(job);
    expect((await fx.jobRow(id)).status).toBe("cancelled");
    expect(await owned(T)).toBeNull();
  }, 60_000);

  it("activate → rollback (to legacy) → activate → retire, each through its job", async () => {
    const reports = {
      gateReportId: fx.reports[T].gate,
      benchmarkReportId: fx.reports[T].bench,
    };
    expect(
      await runOp("tag_activate", { tag: T, revisionId: rev, ...reports }),
    ).toMatchObject({ status: "succeeded" });
    expect(await owned(T)).toEqual({ revision_id: rev });
    expect(await fx.tagsOf(S.a)).toContain(T);
    expect(await fx.tagsOf(S.quiet)).not.toContain(T);

    expect(await runOp("tag_rollback", { tag: T })).toMatchObject({
      status: "succeeded",
    });
    expect(await owned(T)).toBeNull();

    expect(
      await runOp("tag_activate", { tag: T, revisionId: rev, ...reports }),
    ).toMatchObject({ status: "succeeded" });
    expect(await runOp("tag_retire", { tag: T })).toMatchObject({
      status: "succeeded",
    });
    expect(await owned(T)).toBeNull();
    expect(await fx.realCarriers()).toEqual(fx.realCarriersBefore);
  }, 180_000);
});

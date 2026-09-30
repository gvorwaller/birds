/**
 * td-894144 Release B3 — the nightly tag consistency job (plan "Nightly tag
 * consistency job"; migration 0068). Owned fixtures (zzc…) through the shared
 * engine fixture: two real vocabulary tags are owned for the life of the file,
 * every affected real row is restored exactly in cleanup.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { query } from "$lib/db";
import { requestCancel } from "$server/jobs";
import { runTagRepairJob } from "../job-handlers";
import { upsertWikiOk } from "../species-enrichment";
import { runTagConsistencyJob } from "../tag-jobs";
import { msUntilQuietHour, runTagConsistency } from "./consistency";
import { hex, tagEngineFixture } from "./engine-fixture.test-helper";
import { lexiconFor } from "./materialize";
import { beginTagRepair, tagRepairState } from "./repair";
import { withTagWriteTx } from "./runtime";

const dbUp = await query("SELECT 1")
  .then(() => true)
  .catch(() => false);
const migrated = dbUp
  ? await query(
      `SELECT to_regclass('public.tag_legacy_baseline') IS NOT NULL AS ok`,
    ).then((r) => r.rows[0].ok === true)
  : false;

describe("msUntilQuietHour", () => {
  it("is the next 08:30 UTC, strictly in the future", () => {
    expect(msUntilQuietHour(new Date("2026-09-29T08:00:00Z"))).toBe(
      30 * 60_000,
    );
    expect(msUntilQuietHour(new Date("2026-09-29T08:30:00Z"))).toBe(
      24 * 3_600_000,
    );
    expect(msUntilQuietHour(new Date("2026-09-29T20:30:00Z"))).toBe(
      12 * 3_600_000,
    );
  });
});

const fx = tagEngineFixture("zzc");
const S: Record<string, string> = {};
const runIds = new Set<string>();

async function runConsistency(opts: Parameters<typeof runTagConsistency>[0]) {
  const result = await runTagConsistency(opts);
  runIds.add(result.runId);
  return result;
}

describe.runIf(migrated).sequential("tag consistency (0068)", () => {
  beforeAll(async () => {
    const failure = await query(
      "SELECT 1 FROM tag_materialization_failure WHERE key = $1 AND cleared_at IS NULL",
      ["global:consistency"],
    );
    if (failure.rows.length)
      throw new Error(
        "consistency fixture refuses to run over an uncleared global:consistency failure",
      );
    if ((await tagRepairState())?.pending)
      throw new Error(
        "consistency fixture refuses to run while a repair is pending",
      );
    await fx.setup(2);
    for (const k of [
      "text",
      "order",
      "family",
      "focal",
      "scanner",
      "lexicon",
      "missing",
      "state",
      "drift",
      "wiki",
      "clean",
    ])
      S[k] = await fx.addSpecies(k);
    S.nonmember = await fx.addSpecies("nonmember", { member: false });
    await fx.settleUniverse();
    await fx.approveAndActivate(fx.tags[0]);
    await fx.approveAndActivate(fx.tags[1]);
    expect(await fx.tagsOf(S.drift)).toEqual(expect.arrayContaining(fx.tags));
  }, 240_000);

  afterAll(async () => {
    try {
      if (runIds.size)
        await fx.asOwner(
          "DELETE FROM tag_consistency_run WHERE id = ANY($1::bigint[])",
          [[...runIds]],
        );
    } finally {
      await fx.cleanup();
    }
  }, 240_000);

  const scope = () => Object.values(S);

  it("a consistent database reports clean with nothing fixed", async () => {
    const r = await runConsistency({ requesterId: fx.adminId, scope: scope() });
    expect(r).toMatchObject({
      status: "clean",
      fixed: {},
      failures: [],
      checked: scope().length,
    });
    const row = (
      await query<{ status: string; checked: number; duration_ms: number }>(
        "SELECT status, checked, duration_ms FROM tag_consistency_run WHERE id = $1",
        [r.runId],
      )
    ).rows[0];
    expect(row.status).toBe("clean");
    expect(row.checked).toBe(scope().length);
    expect(row.duration_ms).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it("detects and fixes one planted drift per input field, pointer, state and effective tag — then is idempotent", async () => {
    const [T1] = fx.tags;
    await fx.plant(async (exec) => {
      await fx.repoint(exec, S.text, { text: hex(`drift-text-${fx.RUN}`) });
      await fx.repoint(exec, S.order, { order: "Passeriformes" });
      await fx.repoint(exec, S.family, { family: "Driftidae" });
      await fx.repoint(exec, S.focal, { focal: hex(`drift-focal-${fx.RUN}`) });
      await fx.repoint(exec, S.scanner, { scanner: "engine-0+stale" });
      await fx.repoint(exec, S.lexicon, {
        lexicon: hex(`drift-lexicon-${fx.RUN}`),
      });
      await exec("SELECT public.delete_tag_input($1)", [S.missing]);
      await fx.repoint(exec, S.nonmember, {
        text: hex(`drift-nonmember-${fx.RUN}`),
      });
    });
    // A current pointer missing one owned state, and effective tags that
    // lost an owned assignment (owner fixture escape, birds_test only).
    await fx.asOwner(
      `DELETE FROM species_tag_state s USING species_tag_input i
			  WHERE s.species_code = $1 AND s.tag = $2 AND i.species_code = s.species_code AND i.input_hash = s.input_hash`,
      [S.state, T1],
    );
    await fx.asOwner(
      "UPDATE species_enrichment SET tags = array_remove(tags, $2) WHERE species_code = $1",
      [S.drift, T1],
    );

    const r = await runConsistency({ requesterId: fx.adminId, scope: scope() });
    expect(r.status).toBe("fixed");
    expect(r.fixed).toEqual({
      input_text: 1,
      input_order: 1,
      input_family: 1,
      input_focal: 1,
      input_scanner: 1,
      input_lexicon: 1,
      input_missing: 1,
      pointer_non_member: 1,
      state_missing: 1,
      effective_drift: 1,
    });
    expect(await fx.inputOf(S.nonmember)).toBeNull();
    expect(await fx.tagsOf(S.drift)).toContain(T1);

    const again = await runConsistency({
      requesterId: fx.adminId,
      scope: scope(),
    });
    expect(again).toMatchObject({ status: "clean", fixed: {} });
  }, 60_000);

  it("integrity: a legacy baseline created after the cutover is a failure", async () => {
    await fx.asOwner(
      "UPDATE species_enrichment SET legacy_tags = $2 WHERE species_code = $1",
      [S.clean, [fx.tags[0]]],
    );
    try {
      const r = await runConsistency({
        requesterId: fx.adminId,
        scope: [S.clean],
      });
      expect(r.status).toBe("failed");
      expect(r.failures).toContainEqual({
        kind: "legacy_created_after_cutover",
        detail: S.clean,
      });
    } finally {
      await fx.asOwner(
        "UPDATE species_enrichment SET legacy_tags = NULL WHERE species_code = $1",
        [S.clean],
      );
    }
    expect(
      (await query("SELECT * FROM tag_integrity_violations()")).rows,
    ).toEqual([]);
  }, 60_000);

  it("a pending repair defers the pass and re-enqueues its job; the job then converges", async () => {
    const opened = await withTagWriteTx(
      "exclusive",
      `global:test-consistency-open-zzc${fx.RUN}`,
      "test",
      async (tx) => beginTagRepair(tx, (await lexiconFor(tx)).hash, fx.adminId),
    );
    fx.jobIds.add(opened.jobId!);
    const r = await runConsistency({ requesterId: fx.adminId, scope: scope() });
    expect(r.status).toBe("deferred");
    expect(r.checked).toBe(0);
    expect(r.details.repairPending).toMatchObject({
      generation: opened.generation.toString(),
      jobId: opened.jobId,
      deduped: true,
    });
    await runTagRepairJob(await fx.claim(opened.jobId!));
    expect((await tagRepairState())!.pending).toBe(false);
  }, 60_000);

  it("a wiki save racing a batch waits for it, then commits its newer input (never overwritten)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let inBatch!: () => void;
    const entered = new Promise<void>((r) => (inBatch = r));
    const pass = runConsistency({
      requesterId: fx.adminId,
      scope: [S.wiki],
      onBatch: async () => {
        inBatch();
        await gate;
      },
    });
    await entered;
    let saved = false;
    const wiki = upsertWikiOk(S.wiki, {
      title: `zzc ${fx.RUN}`,
      revId: 2,
      extract: `A rewritten shorebird with a ${fx.signal} habit.`,
      sections: [],
    }).then(() => (saved = true));
    await new Promise((r) => setTimeout(r, 400));
    expect(saved).toBe(false); // blocked on the shared lock behind the batch
    release();
    const r = await pass;
    await wiki;
    expect(r.status).toBe("clean");
    const after = (await fx.inputOf(S.wiki))!;
    const recheck = await runConsistency({
      requesterId: fx.adminId,
      scope: [S.wiki],
    });
    expect(recheck).toMatchObject({ status: "clean", fixed: {} }); // the newer input stands
    expect((await fx.inputOf(S.wiki))!.input_hash).toBe(after.input_hash);
  }, 60_000);

  it("an out-of-band lexicon change (and a stale pending target) opens a fresh generation and defers", async () => {
    const stale = await withTagWriteTx(
      "exclusive",
      `global:test-consistency-stale-zzc${fx.RUN}`,
      "test",
      async (tx) => beginTagRepair(tx, (await lexiconFor(tx)).hash, fx.adminId),
    );
    fx.jobIds.add(stale.jobId!);
    await query(
      "UPDATE taxonomy_cache SET com_name = $2 WHERE species_code = $1",
      [S.clean, `Zzc Renamed ${fx.RUN} Plover`],
    );
    const r = await runConsistency({ requesterId: fx.adminId, scope: scope() });
    expect(r.status).toBe("deferred");
    expect(r.fixed).toEqual({ lexicon_drift: 1, repair_target_stale: 1 });
    const drift = r.details.lexiconDrift as {
      generation: string;
      jobId: number;
    };
    fx.jobIds.add(drift.jobId);
    expect(BigInt(drift.generation)).toBe(stale.generation + 1n);
    await runTagRepairJob(await fx.claim(drift.jobId)); // full-universe repair
    expect((await fx.jobRow(drift.jobId)).result).toMatchObject({
      outcome: "converged",
    });
    await runTagRepairJob(await fx.claim(stale.jobId!));
    expect((await fx.jobRow(stale.jobId!)).result).toMatchObject({
      outcome: "already",
    });
    expect((await tagRepairState())!.pending).toBe(false);
  }, 180_000);

  it("the recurring job: full pass, run row, next run at the quiet hour; cancel is a no-op", async () => {
    const job = (
      await query<{ id: number }>(
        `INSERT INTO jobs (type, payload, dedup_key, requested_by, label)
				 VALUES ('tag_consistency', '{}', $1, $2, 'fixture') RETURNING id`,
        [`tag_consistency:fixture-${fx.RUN}`, fx.adminId],
      )
    ).rows[0].id;
    const claimed = await fx.claim(job);
    expect(await requestCancel(job, fx.adminId)).toBe("noop");
    await runTagConsistencyJob(claimed);
    const row = await fx.jobRow(job);
    expect(row.status).toBe("succeeded");
    expect(row.result).toMatchObject({ status: "clean" });
    runIds.add(row.result!.runId as string);
    const successor = (
      await query<{ id: number; wait: number }>(
        `SELECT id, EXTRACT(EPOCH FROM next_retry_at - now())::int AS wait
				   FROM jobs WHERE type = 'tag_consistency' AND status = 'pending' AND id > $1 ORDER BY id DESC LIMIT 1`,
        [job],
      )
    ).rows[0];
    expect(successor).toBeDefined();
    fx.jobIds.add(successor.id);
    expect(Math.abs(successor.wait * 1000 - msUntilQuietHour())).toBeLessThan(
      120_000,
    );
  }, 240_000);

  it("records a failed run before rethrowing an execution failure for retry", async () => {
    const marker = `fixture execution failure ${fx.RUN}`;
    await expect(
      runTagConsistency({
        requesterId: fx.adminId,
        scope: [S.clean],
        onBatch: async () => {
          throw new Error(marker);
        },
      }),
    ).rejects.toThrow(marker);
    const row = (
      await query<{
        id: string;
        status: string;
        failures: { kind: string; detail: string }[];
      }>(
        `SELECT id::text, status, failures FROM tag_consistency_run
				  WHERE failures @> $1::jsonb ORDER BY id DESC LIMIT 1`,
        [JSON.stringify([{ kind: "execution", detail: marker }])],
      )
    ).rows[0];
    expect(row).toMatchObject({
      status: "failed",
      failures: [{ kind: "execution", detail: marker }],
    });
    runIds.add(row.id);
    await fx.asOwner(
      `DELETE FROM tag_materialization_failure
			  WHERE key = 'global:consistency' AND error = $1 AND cleared_at IS NULL`,
      [marker],
    );
  }, 60_000);

  it("integrity reports deletion of a species present in the legacy baseline", async () => {
    const code = await fx.addSpecies("baselinegone", { member: false });
    await fx.asOwner(
      "UPDATE species_enrichment SET legacy_tags = $2 WHERE species_code = $1",
      [code, [fx.tags[0]]],
    );
    await fx.asOwner(
      "INSERT INTO tag_legacy_baseline (species_code, legacy_sha256) VALUES ($1, public.tag_legacy_sha256($2))",
      [code, [fx.tags[0]]],
    );
    try {
      await query("DELETE FROM species_enrichment WHERE species_code = $1", [
        code,
      ]);
      const result = await runConsistency({
        requesterId: fx.adminId,
        scope: [code],
      });
      expect(result.status).toBe("failed");
      expect(result.failures).toContainEqual({
        kind: "legacy_missing",
        detail: code,
      });
    } finally {
      await fx.asOwner(
        "DELETE FROM tag_legacy_baseline WHERE species_code = $1",
        [code],
      );
    }
  }, 60_000);
});

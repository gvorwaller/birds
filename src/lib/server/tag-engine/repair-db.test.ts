/**
 * td-894144 Release B, plan rev 21 — generation-keyed batched repair
 * (migration 0067, tag-engine/repair.ts, the tag_repair job).
 *
 * Owned fixtures (zzr…). Ownership accepts only the controlled vocabulary, so
 * the suite chooses the two unowned tags with the fewest snapshot carriers,
 * records every affected carrier exactly, and restores those exact rows in
 * cleanup even when an assertion fails. A dedicated fixture species supplies
 * an additional owned legacy-baseline carrier. The requester is a dedicated
 * fixture admin, and every job / activation cleanup is by its exact recorded
 * id (never a global watermark or production-shaped failure key).
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { query } from "$lib/db";
import { ALL_TAGS } from "$lib/species-tags";
import { enqueueJob, requestCancel } from "$server/jobs";
import type { JobRow } from "$server/job-policy";
import { runTagRepairJob } from "../job-handlers";
import { upsertWikiOk } from "../species-enrichment";
import { beginTaxonomyChange, finishTaxonomyChange } from "../taxonomy-sync";
import { setFixtureTags, withOwnerClient } from "../tag-fixtures.test-helper";
import {
  activateRevision,
  retireTagToLegacy,
  stageRevision,
} from "./activation";
import {
  __resetTagEngineCachesForTests,
  lexiconFor,
  materializeMany,
} from "./materialize";
import {
  beginTagRepair,
  closePendingRepairInline,
  ensureTagRepairJob,
  repairTagGeneration,
  tagRepairDedupKey,
  tagRepairState,
} from "./repair";
import { TagTxRollback, withTagWriteTx } from "./runtime";
import {
  censusGate,
  cleanupEvalSets,
  cleanupFamilyReferences,
} from "./engine-fixture.test-helper";
import { scannerRev } from "./segment";

const dbUp = await query("SELECT 1")
  .then(() => true)
  .catch(() => false);
const migrated = dbUp
  ? await query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns
			                 WHERE table_name = 'tag_lexicon_state' AND column_name = 'repair_generation') AS ok`,
    ).then((r) => r.rows[0].ok === true)
  : false;

const RUN = `${process.pid.toString(36)}${Date.now().toString(36).slice(-6)}`;
const A = `zzr${RUN}a`;
const B = `zzr${RUN}b`;
const C = `zzr${RUN}c`;
const D = `zzr${RUN}d`;
const E = `zzr${RUN}e`; // leaves the universe via taxonomy (species → issf)
const L = `zzr${RUN}l`; // owned legacy-baseline carrier
const N = `zzr${RUN}n`; // article, never a taxonomy row → never a member
const MEMBERS = [A, B, C, D, E, L];
const ALL = [...MEMBERS, N];
let T1 = "";
let T2 = "";
const SIGNAL = `zzrsignal${RUN}`;
const hex = (s: string) =>
  createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
const art = (rev: number, extract: string) => ({
  title: `Zzr ${RUN}`,
  revId: rev,
  extract,
  sections: [],
});
// The real text-evidence shape (0072 validates it at the state boundary).
const EVIDENCE = [
  { section: "lead", sentence: "x", matchStart: 0, matchEnd: 1, ruleId: "s-signal" },
];

const ruleset = (tag: string) => ({
  schema: 1,
  tag,
  rev: `repair-fixture-${RUN}`,
  denySections: [],
  comparisonMarkers: [],
  support: [
    {
      id: "s-signal",
      group: "signal",
      match: { type: "literal", phrase: SIGNAL },
      note: "fixture signal",
    },
  ],
  exclude: [],
  taxon: [],
});

let adminId = 0;
const revisions: Record<string, string> = {};
const reports: Record<string, { gate: string; bench: string }> = {};
const proposals: string[] = [];
const activationIds = new Set<number>();
const jobIds = new Set<number>();
const evalSets = { setIds: new Set<string>(), refs: new Set<string>() };
let legacyCarrierBefore: { species_code: string; tags: string[] }[] = [];
let realCarriersBefore: {
  species_code: string;
  tags: string[];
  legacy_tags: string[] | null;
}[] = [];

async function asOwner<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return withOwnerClient(async (c) => {
    await c.query("BEGIN");
    try {
      await c.query(`SELECT set_config('birds.tag_fixture', 'on', true)`);
      await c.query(`SELECT set_config('birds.legacy_fixture', 'on', true)`);
      const r = await c.query(sql, params);
      await c.query("COMMIT");
      return r.rows as T[];
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    }
  });
}

const legacyCarrier = async () =>
  (
    await query<{ species_code: string; tags: string[] }>(
      "SELECT species_code, tags FROM species_enrichment WHERE species_code = $1",
      [L],
    )
  ).rows;

const realCarriers = async () =>
  (
    await query<{
      species_code: string;
      tags: string[];
      legacy_tags: string[] | null;
    }>(
      `SELECT species_code, tags, legacy_tags FROM species_enrichment
        WHERE species_code NOT LIKE 'zz%'
          AND ($1 = ANY(tags) OR $2 = ANY(tags)
            OR $1 = ANY(coalesce(legacy_tags, '{}')) OR $2 = ANY(coalesce(legacy_tags, '{}')))
        ORDER BY species_code`,
      [T1, T2],
    )
  ).rows;

const tagsOf = async (code: string) =>
  (
    await query<{ tags: string[] }>(
      "SELECT tags FROM species_enrichment WHERE species_code = $1",
      [code],
    )
  ).rows[0]?.tags ?? null;

const inputOf = async (code: string) =>
  (
    await query<{
      input_hash: string;
      text_hash: string;
      order_name: string | null;
      family_sci_name: string | null;
      lexicon_hash: string;
      focal_exempt_hash: string;
      scanner_rev: string;
    }>("SELECT * FROM species_tag_input WHERE species_code = $1", [code])
  ).rows[0] ?? null;

/** Re-derive the whole universe for the current taxonomy; close any pending generation. */
async function settleUniverse() {
  __resetTagEngineCachesForTests();
  await withTagWriteTx(
    "exclusive",
    `global:test-repair-settle-zzr${RUN}`,
    "test",
    async (tx) => {
      const lex = await lexiconFor(tx, { rebuild: true });
      await materializeMany(tx, null);
      await closePendingRepairInline(tx, lex.hash);
    },
  );
}

/** Open a generation on the CURRENT lexicon (workset = only what a test plants). */
async function openGeneration(): Promise<{
  generation: bigint;
  jobId: number;
}> {
  return withTagWriteTx(
    "exclusive",
    `global:test-repair-open-zzr${RUN}`,
    "test",
    async (tx) => {
      const lex = await lexiconFor(tx);
      const r = await beginTagRepair(tx, lex.hash, adminId);
      expect(r.jobId).not.toBeNull();
      jobIds.add(r.jobId!);
      return { generation: r.generation, jobId: r.jobId! };
    },
  );
}

/** Claim OUR job row the way claimNextJob would (never another file's row). */
async function claim(jobId: number): Promise<JobRow> {
  const r = await query<JobRow>(
    `UPDATE jobs SET status = 'running', attempts = attempts + 1, started_at = now(), heartbeat_at = now()
		  WHERE id = $1 AND status = 'pending' RETURNING *`,
    [jobId],
  );
  expect(r.rows[0], `job ${jobId} claimable`).toBeDefined();
  return r.rows[0];
}

const jobRow = async (id: number) =>
  (
    await query<{
      status: string;
      result: { outcome?: string; repaired?: number } | null;
    }>("SELECT status, result FROM jobs WHERE id = $1", [id])
  ).rows[0];

async function plant(
  fn: (exec: (sql: string, p?: unknown[]) => Promise<unknown>) => Promise<void>,
) {
  await withTagWriteTx(
    "exclusive",
    `global:test-repair-plant-zzr${RUN}`,
    "test",
    async (tx) => {
      await fn((sql, p) => tx.exec(sql, p));
    },
  );
}

async function clearFixtureFailure(key: string): Promise<void> {
  const row = (
    await query<{ n: string }>(
      "SELECT public.begin_tag_attempt()::text AS n WHERE EXISTS (SELECT 1 FROM tag_materialization_failure WHERE key = $1 AND cleared_at IS NULL)",
      [key],
    )
  ).rows[0];
  if (row)
    await query("SELECT public.clear_materialization_failure($1, $2)", [
      key,
      row.n,
    ]);
}

/** Point `code` at a synthetic input: same fields as now, with overrides. */
async function repoint(
  exec: (sql: string, p?: unknown[]) => Promise<unknown>,
  code: string,
  o: { text?: string; lexicon?: string; scanner?: string } = {},
): Promise<string> {
  const i = await inputOf(code);
  const current = (await tagRepairState())!.lexiconHash;
  const r = (await exec(
    "SELECT public.record_tag_input($1, $2, $3, $4, $5, $6, $7, $8) AS h",
    [
      code,
      o.text ?? i?.text_hash ?? hex(`text-${code}`),
      i?.order_name ?? null,
      i?.family_sci_name ?? null,
      (i as { genus?: string | null } | null)?.genus ?? null,
      o.lexicon ?? i?.lexicon_hash ?? current,
      i?.focal_exempt_hash ?? hex(`focal-${code}`),
      o.scanner ?? scannerRev(),
    ],
  )) as { rows: { h: string }[] };
  return r.rows[0].h;
}

const workset = async (limit = 100) => {
  const s = await tagRepairState();
  return (
    await query<{ c: string }>(
      "SELECT c FROM tag_repair_workset($1, $2, $3) c",
      [s!.target ?? s!.lexiconHash, scannerRev(), limit],
    )
  ).rows.map((r) => r.c);
};

async function approveAndActivate(tag: string) {
  if (!revisions[tag]) {
    const p = (
      await query<{ id: string; artifact_sha256: string }>(
        `INSERT INTO tag_rule_proposal (tag, artifact, source) VALUES ($1, $2::jsonb, 'human') RETURNING id, artifact_sha256`,
        [tag, JSON.stringify(ruleset(tag))],
      )
    ).rows[0];
    proposals.push(p.id);
    await asOwner(
      `INSERT INTO tag_crosscheck (proposal_id, reviewer, verdict, text, reviewed_sha256) VALUES ($1, 'CODEX1', 'approve', 'fixture', $2)`,
      [p.id, p.artifact_sha256],
    );
    revisions[tag] = (
      await query<{ id: string }>(
        "SELECT approve_tag_proposal($1, $2)::text AS id",
        [p.id, adminId],
      )
    ).rows[0].id;
  }
  await stageRevision(tag, revisions[tag]);
  // A real frozen census blind-test set + gate (plan rev 25: activation
  // verifies gate → frozen set → frame hash inside the switch).
  reports[tag] = await censusGate(tag, revisions[tag], adminId, evalSets);
  const activationId = await activateRevision({
    tag,
    revisionId: revisions[tag],
    gateReportId: reports[tag].gate,
    benchmarkReportId: reports[tag].bench,
    userId: adminId,
  });
  expect(activationId).not.toBeNull();
  activationIds.add(Number(activationId));
}

async function retireFixtureTag(tag: string): Promise<void> {
  activationIds.add(Number(await retireTagToLegacy(tag, adminId)));
}

async function cleanup() {
  for (const tag of [T1, T2]) {
    if (!tag) continue;
    const owned =
      (await query("SELECT 1 FROM tag_ownership WHERE tag = $1", [tag])).rows
        .length > 0;
    if (owned && adminId) await retireFixtureTag(tag);
  }
  await query("DELETE FROM species_enrichment WHERE species_code = ANY($1)", [
    ALL,
  ]);
  await query("DELETE FROM taxonomy_cache WHERE species_code = ANY($1)", [ALL]);
  await settleUniverse();
  for (const row of realCarriersBefore)
    await asOwner(
      "UPDATE species_enrichment SET tags = $2, legacy_tags = $3 WHERE species_code = $1",
      [row.species_code, row.tags, row.legacy_tags],
    );
  if (jobIds.size)
    await query("DELETE FROM jobs WHERE id = ANY($1::bigint[])", [[...jobIds]]);
  const revs = Object.values(revisions);
  await cleanupEvalSets(evalSets.setIds);
  await cleanupFamilyReferences(evalSets.refs);
  if (revs.length)
    await asOwner(
      "DELETE FROM species_tag_state WHERE revision_id = ANY($1::bigint[])",
      [revs],
    );
  if (activationIds.size)
    await asOwner("DELETE FROM tag_activation WHERE id = ANY($1::bigint[])", [
      [...activationIds],
    ]);
  if (revs.length) {
    await asOwner(
      "DELETE FROM tag_report WHERE revision_id = ANY($1::bigint[])",
      [revs],
    );
    await asOwner("DELETE FROM tag_revision WHERE id = ANY($1::bigint[])", [
      revs,
    ]);
  }
  if (proposals.length) {
    await asOwner(
      "DELETE FROM tag_crosscheck WHERE proposal_id = ANY($1::uuid[])",
      [proposals],
    );
    await asOwner("DELETE FROM tag_rule_proposal WHERE id = ANY($1::uuid[])", [
      proposals,
    ]);
  }
  if (adminId) await query("DELETE FROM users WHERE id = $1", [adminId]);
}

describe
  .runIf(migrated)
  .sequential("rev 21 generation-keyed repair (0067)", () => {
    beforeAll(async () => {
      const globalRepairFailure = await query(
        "SELECT 1 FROM tag_materialization_failure WHERE key = $1 AND cleared_at IS NULL",
        ["global:repair"],
      );
      if (globalRepairFailure.rows.length)
        throw new Error(
          "repair fixture refuses to clear an existing global:repair failure",
        );
      const safeTags = (
        await query<{ tag: string; carriers: string }>(
          `SELECT candidate.tag, count(se.species_code)::text AS carriers
             FROM unnest($1::text[]) WITH ORDINALITY candidate(tag, ord)
             LEFT JOIN species_enrichment se
               ON se.species_code NOT LIKE 'zz%'
              AND (candidate.tag = ANY(se.tags) OR candidate.tag = ANY(coalesce(se.legacy_tags, '{}')))
            WHERE NOT EXISTS (SELECT 1 FROM tag_ownership o WHERE o.tag = candidate.tag)
            GROUP BY candidate.tag, candidate.ord
            ORDER BY count(se.species_code), candidate.ord LIMIT 2`,
          [[...ALL_TAGS]],
        )
      ).rows.map((r) => r.tag);
      if (safeTags.length < 2)
        throw new Error("repair fixture needs two unowned vocabulary tags");
      [T1, T2] = safeTags;
      realCarriersBefore = await realCarriers();
      adminId = (
        await query<{ id: number }>(
          `INSERT INTO users(username, display_name, password_hash, role)
				 VALUES ($1, 'Tag repair fixture', '!unset', 'admin') RETURNING id`,
          [`tag-repair-${RUN}`],
        )
      ).rows[0].id;
      for (const code of MEMBERS)
        await query(
          `INSERT INTO taxonomy_cache (species_code, com_name, sci_name, category, family, order_name, family_sci_name, family_code)
				 VALUES ($1, $2, $3, 'species', 'Zzr family', $4, $5, $6)`,
          [
            code,
            `Zzr ${code} Plover`,
            `Zzria ${code}`,
            code === A ? "ZzrOrder" : "Charadriiformes",
            code === A ? null : "Zzridae",
            // A family code (for the blind-test family reference, B5 §4).
            code === A ? "zzr-fam-a" : "zzr-fam",
          ],
        );
      for (const code of ALL)
        await upsertWikiOk(
          code,
          art(
            1,
            code === L
              ? "A quiet fixture shorebird."
              : `A shorebird with a ${SIGNAL} habit.`,
          ),
        );
      await setFixtureTags(L, [T1, T2]);
      legacyCarrierBefore = await legacyCarrier();
      await settleUniverse();
      await approveAndActivate(T1);
      await approveAndActivate(T2);
      expect(await tagsOf(A)).toEqual(expect.arrayContaining([T1, T2]));
    }, 240_000);

    afterAll(async () => {
      await cleanup();
    }, 240_000);

    it("taxonomy snapshots preserve null field positions when deciding which species to re-derive", async () => {
      const beforeInput = (await inputOf(A))!.input_hash;
      const result = await withTagWriteTx(
        "exclusive",
        `global:test-repair-null-snapshot-zzr${RUN}`,
        "test",
        async (tx) => {
          const before = await beginTaxonomyChange(tx);
          await tx.exec(
            "UPDATE taxonomy_cache SET order_name = NULL, family_sci_name = $2 WHERE species_code = $1",
            [A, "ZzrOrder"],
          );
          return finishTaxonomyChange(tx, before, adminId);
        },
      );
      expect(result).toEqual({ mode: "changed", changed: 1 });
      expect((await inputOf(A))!.input_hash).not.toBe(beforeInput);
    }, 60_000);

    it("test 1 — a lexicon change opens generation + job + event atomically, re-derives nothing inline; a rollback leaves none", async () => {
      const s0 = (await tagRepairState())!;
      expect(s0.pending).toBe(false);
      const next = s0.repairGeneration + 1n;
      const renamed = `Zzr Renamed ${RUN} Plover`;
      const change = (rollback: boolean) =>
        withTagWriteTx(
          "exclusive",
          `global:test-repair-tax-zzr${RUN}`,
          "test",
          async (tx) => {
            const before = await beginTaxonomyChange(tx);
            await tx.exec(
              "UPDATE taxonomy_cache SET com_name = $2 WHERE species_code = $1",
              [A, renamed],
            );
            const r = await finishTaxonomyChange(tx, before, adminId);
            if (rollback) throw new TagTxRollback();
            return r;
          },
        );

      await expect(change(true)).rejects.toBeInstanceOf(TagTxRollback);
      expect((await tagRepairState())!.repairGeneration).toBe(
        s0.repairGeneration,
      );
      expect(
        (
          await query("SELECT 1 FROM jobs WHERE dedup_key = $1", [
            tagRepairDedupKey(next),
          ])
        ).rows,
      ).toHaveLength(0);

      const inputBefore = (await inputOf(A))!;
      const r = await change(false);
      expect(r).toMatchObject({ mode: "repair", generation: next.toString() });
      // td-861855: nothing is re-derived inside the exclusive transaction —
      // not even the renamed species; the batched repair owns all of it.
      const inputAfter = (await inputOf(A))!;
      expect(inputAfter.input_hash).toBe(inputBefore.input_hash);
      expect(inputAfter.lexicon_hash).toBe(inputBefore.lexicon_hash);
      const target = (await tagRepairState())!.target!;
      expect(target).not.toBe(inputBefore.lexicon_hash);
      const jobId = (r as { jobId: number }).jobId;
      jobIds.add(jobId);
      const job = (
        await query<{
          type: string;
          status: string;
          requested_by: number;
          dedup_key: string;
          payload: unknown;
        }>(
          "SELECT type, status, requested_by, dedup_key, payload FROM jobs WHERE id = $1",
          [jobId],
        )
      ).rows[0];
      expect(job).toEqual({
        type: "tag_repair",
        status: "pending",
        requested_by: adminId,
        dedup_key: tagRepairDedupKey(next),
        payload: { repairGeneration: Number(next) },
      });
      const ev = await query(
        `SELECT 1 FROM job_events WHERE job_id = $1 AND action = 'enqueued'`,
        [jobId],
      );
      expect(ev.rows).toHaveLength(1);
      expect((await tagRepairState())!.pending).toBe(true);

      // Activation is refused while pending (the real activation path)…
      await expect(
        activateRevision({
          tag: T1,
          revisionId: revisions[T1],
          gateReportId: reports[T1].gate,
          benchmarkReportId: reports[T1].bench,
          userId: adminId,
        }),
      ).rejects.toThrow(/repair generation \d+ is pending/);
      await clearFixtureFailure(`global:activate:${T1}`);
      // …and so is a revision rollback (the guard is on the activation row).
      await expect(
        withOwnerClient(async (c) => {
          await c.query("BEGIN");
          try {
            await c.query(
              `INSERT INTO tag_activation (tag, revision_id, action, activated_by) VALUES ($1, $2, 'rollback', $3)`,
              [T1, revisions[T1], adminId],
            );
          } finally {
            await c.query("ROLLBACK");
          }
        }),
      ).rejects.toThrow(/is pending/);

      // The whole universe is stale for the new lexicon: repair it in batches
      // of 100, timing the gap between batches (≈ one exclusive hold each).
      const stamps: number[] = [performance.now()];
      const res = await repairTagGeneration(next, {
        shouldStop: async () => {
          stamps.push(performance.now());
          return false;
        },
      });
      expect(res.outcome).toBe("converged");
      expect(res.batches).toBeGreaterThan(10);
      const gaps = stamps.slice(1).map((t, i) => t - stamps[i]);
      const maxGap = Math.max(...gaps);
      console.info(
        `[repair-db] ${res.repaired} codes in ${res.batches} batches; max batch ${maxGap.toFixed(0)} ms`,
      );
      expect(maxGap).toBeLessThan(1000); // plan rev 21: each exclusive hold < 1 s
      expect(await workset()).toEqual([]);
      expect((await tagRepairState())!.pending).toBe(false);
      expect((await inputOf(A))!.lexicon_hash).toBe(target);
      expect((await inputOf(A))!.input_hash).not.toBe(inputBefore.input_hash);
      expect(await tagsOf(A)).toEqual(expect.arrayContaining([T1, T2]));

      // The job row, claimed after the repair converged, completes as 'already'.
      await runTagRepairJob(await claim(jobId));
      expect(await jobRow(jobId)).toMatchObject({
        status: "succeeded",
        result: { outcome: "already" },
      });
    }, 180_000);

    it("test 1b — a taxonomy change that moves a member out of the universe (species → issf) drops its input through the repair, not inline", async () => {
      expect(await inputOf(E)).not.toBeNull();
      const inWorkset = async (code: string) =>
        (
          await query(
            "SELECT 1 FROM tag_repair_workset($1, $2, 2147483647) c WHERE c = $3",
            [(await tagRepairState())!.target, scannerRev(), code],
          )
        ).rows.length > 0;
      const r = await withTagWriteTx(
        "exclusive",
        `global:test-repair-issf-zzr${RUN}`,
        "test",
        async (tx) => {
          const before = await beginTaxonomyChange(tx);
          await tx.exec(
            "UPDATE taxonomy_cache SET category = 'issf' WHERE species_code = $1",
            [E],
          );
          return finishTaxonomyChange(tx, before, adminId);
        },
      );
      // E's names leave the species lexicon, so the lexicon moves → repair.
      expect(r).toMatchObject({ mode: "repair", changed: 1 });
      const jobId = (r as { jobId: number }).jobId;
      jobIds.add(jobId);
      expect(await inputOf(E)).not.toBeNull(); // nothing inline
      expect(await inWorkset(E)).toBe(true); // class (d): pointer for a non-member
      await runTagRepairJob(await claim(jobId));
      expect(await jobRow(jobId)).toMatchObject({
        status: "succeeded",
        result: { outcome: "converged" },
      });
      expect(await inputOf(E)).toBeNull();
      expect(await workset()).toEqual([]);
      expect((await tagRepairState())!.pending).toBe(false);
    }, 180_000);

    it("test 2 — the finalization-window race: a new generation gets its own job, never deduped onto the finishing one", async () => {
      const g1 = await openGeneration();
      const job1 = await claim(g1.jobId);
      expect((await repairTagGeneration(g1.generation)).outcome).toBe(
        "converged",
      ); // CAS done, row still running
      const g2 = await openGeneration();
      expect(g2.generation).toBe(g1.generation + 1n);
      expect(g2.jobId).not.toBe(g1.jobId);
      // Control: the OLD key would have collapsed onto the still-running job.
      const dup = await enqueueJob({
        type: "tag_repair",
        payload: { repairGeneration: Number(g1.generation) },
        dedupKey: tagRepairDedupKey(g1.generation),
        requestedBy: adminId,
        label: "control",
      });
      expect(dup).toEqual({ jobId: g1.jobId, deduped: true });
      await runTagRepairJob(job1);
      expect(await jobRow(g1.jobId)).toMatchObject({
        status: "succeeded",
        result: { outcome: "already" },
      });
      expect((await tagRepairState())!.pending).toBe(true);
      await runTagRepairJob(await claim(g2.jobId));
      expect(await jobRow(g2.jobId)).toMatchObject({
        status: "succeeded",
        result: { outcome: "converged" },
      });
      const s = (await tagRepairState())!;
      expect(s.repairedGeneration).toBe(g2.generation);
      expect(s.pending).toBe(false);
    }, 60_000);

    it("test 3 — an older generation stops as superseded once a newer one is open", async () => {
      const g3 = await openGeneration();
      const g4 = await openGeneration();
      expect((await repairTagGeneration(g3.generation)).outcome).toBe(
        "superseded",
      );
      await runTagRepairJob(await claim(g4.jobId));
      expect(await jobRow(g4.jobId)).toMatchObject({
        status: "succeeded",
        result: { outcome: "converged" },
      });
      await runTagRepairJob(await claim(g3.jobId));
      expect(await jobRow(g3.jobId)).toMatchObject({
        status: "succeeded",
        result: { outcome: "already" },
      });
    }, 60_000);

    it("test 4 — every drift class is in the workset, blocks the CAS, and is actually repaired", async () => {
      const g = await openGeneration();
      const dInputBefore = (await inputOf(D))!.input_hash;
      await plant(async (exec) => {
        await exec("SELECT public.delete_tag_input($1)", [A]); // (a) member without a pointer
        await repoint(exec, B, { lexicon: hex(`stale-lexicon-${RUN}`) }); // (b) stale lexicon
        await repoint(exec, C, { scanner: "engine-0+stale" }); // (b′) stale scanner revision
        await repoint(exec, D, { text: hex(`unevaluated-${RUN}`) }); // (c) current pointer, no owned state
        await repoint(exec, N, { text: hex(`non-member-${RUN}`) }); // (d) pointer for a non-member
      });
      expect(await workset()).toEqual([A, B, C, D, N].sort());
      await expect(
        withTagWriteTx(
          "exclusive",
          `global:test-repair-cas-zzr${RUN}`,
          "test",
          (tx) =>
            tx.exec("SELECT public.complete_tag_repair($1, $2)", [
              g.generation.toString(),
              scannerRev(),
            ]),
        ),
      ).rejects.toThrow(/has not converged/);
      const wrong = await withTagWriteTx(
        "exclusive",
        `global:test-repair-cas-zzr${RUN}`,
        "test",
        (tx) =>
          tx.exec<{ ok: boolean }>(
            "SELECT public.complete_tag_repair($1, $2) AS ok",
            [(g.generation - 1n).toString(), scannerRev()],
          ),
      );
      expect(wrong.rows[0].ok).toBe(false);

      await runTagRepairJob(await claim(g.jobId));
      expect(await jobRow(g.jobId)).toMatchObject({
        status: "succeeded",
        result: { outcome: "converged", repaired: 5 },
      });
      expect(await workset()).toEqual([]);
      expect(await inputOf(N)).toBeNull();
      expect((await inputOf(D))!.input_hash).toBe(dInputBefore);
      for (const code of [A, B, C, D]) {
        const i = (await inputOf(code))!;
        expect(i.scanner_rev).toBe(scannerRev());
        expect(await tagsOf(code)).toEqual(expect.arrayContaining([T1, T2]));
      }
    }, 60_000);

    it("test 5 — retire-to-legacy works while pending (T1 survives; NULL-baseline row loses the retired tag)", async () => {
      await setFixtureTags(D, [T2], { legacy: false }); // never-evaluated row carrying T2 with no legacy baseline
      const g = await openGeneration();
      await retireFixtureTag(T2);
      expect((await tagRepairState())!.pending).toBe(true);
      expect(await tagsOf(A)).toContain(T1);
      expect(await tagsOf(A)).not.toContain(T2);
      expect(await tagsOf(D)).toEqual([T1]);
      expect(await tagsOf(L)).toEqual([T2]);
      await runTagRepairJob(await claim(g.jobId));
      expect((await tagRepairState())!.pending).toBe(false);
    }, 60_000);

    it("test 6 — retire before and after a repair batch keeps the surviving tag consistent", async () => {
      await approveAndActivate(T2); // re-own T2 (repair is converged)
      const g = await openGeneration();
      await plant(async (exec) => {
        await exec("SELECT public.delete_tag_input($1)", [A]); // repaired by the first batch
        // B: an old-lexicon pointer WITH its old-lexicon results, as a real
        // pre-change row has; it stays unrepaired until the second batch.
        const h = await repoint(exec, B, {
          lexicon: hex(`old-lexicon-${RUN}`),
        });
        for (const tag of [T1, T2])
          await exec(
            `SELECT public.record_tag_state($1, $2::bigint, $3, $4, 'assigned', NULL, $5::jsonb, $6)`,
            [B, revisions[tag], tag, h, JSON.stringify(EVIDENCE), scannerRev()],
          );
        await exec("SELECT public.apply_effective_tags($1)", [B]);
      });
      const first = await repairTagGeneration(g.generation, {
        batch: 1,
        shouldStop: async ({ batches }) => batches >= 1,
      });
      expect(first).toMatchObject({ outcome: "stopped", repaired: 1 });
      expect(await workset()).toEqual([B]);

      await retireFixtureTag(T2); // mid-repair: A repaired, B not yet
      for (const code of [A, B]) {
        expect(await tagsOf(code)).toContain(T1);
        expect(await tagsOf(code)).not.toContain(T2);
      }
      await runTagRepairJob(await claim(g.jobId));
      expect(await jobRow(g.jobId)).toMatchObject({
        status: "succeeded",
        result: { outcome: "converged" },
      });
      expect(await tagsOf(B)).toContain(T1);
      expect(await tagsOf(B)).not.toContain(T2);
      expect((await inputOf(B))!.lexicon_hash).toBe(
        (await tagRepairState())!.lexiconHash,
      );
    }, 120_000);

    it("test 7 — a wiki save during the repair uses the new lexicon and is not overwritten by a later batch", async () => {
      const g = await openGeneration();
      await plant(async (exec) => {
        await repoint(exec, C, { lexicon: hex(`old-lexicon-c-${RUN}`) });
        await repoint(exec, D, { lexicon: hex(`old-lexicon-d-${RUN}`) });
      });
      await upsertWikiOk(
        C,
        art(2, `A rewritten shorebird with a ${SIGNAL} habit.`),
      );
      const saved = (await inputOf(C))!;
      expect(saved.lexicon_hash).toBe((await tagRepairState())!.target);
      expect(await workset()).toEqual([D]);
      await runTagRepairJob(await claim(g.jobId));
      expect((await inputOf(C))!.input_hash).toBe(saved.input_hash);
      expect(await workset()).toEqual([]);
    }, 60_000);

    it("test 8 — cancel stops between batches and leaves the generation pending; resume converges", async () => {
      const g = await openGeneration();
      await plant(async (exec) => {
        for (const code of [A, B, C])
          await repoint(exec, code, { lexicon: hex(`old-lexicon-${code}`) });
      });
      const job = await claim(g.jobId);
      expect(await requestCancel(g.jobId, adminId)).toBe("flagged");
      await runTagRepairJob(job);
      expect(await jobRow(g.jobId)).toMatchObject({
        status: "cancelled",
        result: { outcome: "stopped", repaired: 0, batches: 0 },
      });
      expect((await tagRepairState())!.pending).toBe(true);

      const resumed = await ensureTagRepairJob(adminId);
      expect(resumed).toMatchObject({
        generation: g.generation.toString(),
        deduped: false,
      });
      jobIds.add(resumed!.jobId);
      await runTagRepairJob(await claim(resumed!.jobId));
      expect(await jobRow(resumed!.jobId)).toMatchObject({
        status: "succeeded",
        result: { outcome: "converged" },
      });
      expect(await ensureTagRepairJob(adminId)).toBeNull();
      expect(await workset()).toEqual([]);
    }, 60_000);

    it("retiring both tags restores every real carrier exactly", async () => {
      await retireFixtureTag(T1);
      expect(await legacyCarrier()).toEqual(legacyCarrierBefore);
      expect(await realCarriers()).toEqual(realCarriersBefore);
    }, 60_000);
  });

/**
 * td-6093ae: taxonomy refresh runs against the real birds_test schema.
 *
 * Owns every row: an admin and a second user, L99… hotspot locations (far
 * beyond eBird's id space) with reserved zz<tag> species codes, its runs,
 * backups and jobs. Everything is deleted by those exact ids. taxonomy_cache
 * is only READ (a backup copies it); the sync boundary is replaced, so no
 * test ever rewrites the shared taxonomy, and no eBird request is made.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomInt, randomUUID } from "node:crypto";
import { query } from "$lib/db";
import type { JobRow } from "$server/job-policy";
import { requeueInterrupted, runWithClaim, StaleClaimError } from "./jobs";
import {
  compareRun as compareAny,
  dispatchRefresh,
  getRun,
  hasEbirdLogin,
  refreshProgress,
  runTaxonomyRun,
  startOrResumeRun,
  taxonomyPanel,
  TaxonomyRunError,
  type RunDeps,
  type TaxonRow,
} from "./taxonomy-refresh";

/** Always confined to this file's runs: never carries over or supersedes history it does not own. */
const compareRun = (runId: number, matcher: { match(name: string): { code: string } | null }) =>
  compareAny(runId, matcher, [...runIds]);

const dbUp = await query("SELECT 1")
  .then(() => true)
  .catch(() => false);

const tag = randomUUID().replaceAll("-", "").slice(0, 6).toLowerCase();
const sp = (n: string) => `zz${tag}${n}`;
const LABEL = `TAXREFTEST ${tag}`;
const base = 990_000_000_000 + randomInt(0, 9_000_000) * 1_000;
const locIds: string[] = [];
const newLoc = () => {
  const id = `L${base + locIds.length}`;
  locIds.push(id);
  return id;
};
const runIds: number[] = [];
const jobIds: number[] = [];
let adminId = 0;
let otherUserId = 0;

const taxon = (code: string, over: Partial<TaxonRow> = {}): TaxonRow => ({
  species_code: code,
  com_name: `Fixture ${code}`,
  sci_name: `Avis ${code}`,
  category: "species",
  family: null,
  taxon_order: null,
  order_name: null,
  family_code: null,
  family_sci_name: null,
  banding_codes: null,
  report_as: null,
  extinct: null,
  ...over,
});

/** A stored frequency location holding `species`, with optional unmatched names. */
async function location(
  opts: { species?: string[]; unmatched?: string[]; fetchedAt?: string } = {},
): Promise<string> {
  const loc = newLoc();
  await query(
    `INSERT INTO frequency_fetch (loc_code, loc_kind, loc_name, begin_year, end_year, sample_sizes, n_species,
                                  region_code, n_unmatched, unmatched_names, fetched_at)
     VALUES ($1, 'hotspot', $2, 2016, 2025, $3, $4, $5, $6, $7, $8)`,
    [
      loc,
      `Taxonomy fixture ${loc}`,
      Array(48).fill(10),
      opts.species?.length ?? 0,
      `ZZ-T${tag.toUpperCase()}-001`,
      opts.unmatched?.length ?? 0,
      opts.unmatched ?? [],
      opts.fetchedAt ?? "2020-01-01T00:00:00Z",
    ],
  );
  for (const code of opts.species ?? []) {
    await query(`INSERT INTO species_frequency (loc_code, species_code, week, freq) VALUES ($1, $2, 20, 0.5)`, [loc, code]);
  }
  return loc;
}

/** A run with hand-made backups, ready to compare (stage after_backed_up). */
async function runReadyToCompare(before: TaxonRow[], after: TaxonRow[], sourceFetchedAt = "2999-01-01T00:00:00Z") {
  const run = await query<{ id: string }>(
    `INSERT INTO taxonomy_runs (requested_by, actor_label, stage, applied_at)
     VALUES ($1, $2, 'after_backed_up', clock_timestamp()) RETURNING id`,
    [adminId, LABEL],
  );
  const id = Number(run.rows[0].id);
  runIds.push(id);
  const backup = async (kind: string, rows: TaxonRow[]) => {
    const b = await query<{ id: string }>(
      `INSERT INTO taxonomy_backups (run_id, kind, taxa, source_fetched_at) VALUES ($1, $2, $3, $4) RETURNING id`,
      [id, kind, rows.length, kind === "before_sync" ? sourceFetchedAt : null],
    );
    for (const t of rows) {
      await query(
        `INSERT INTO taxonomy_backup_rows (backup_id, species_code, com_name, sci_name, category, report_as, family)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [b.rows[0].id, t.species_code, t.com_name, t.sci_name, t.category, t.report_as, t.family],
      );
    }
    return Number(b.rows[0].id);
  };
  const beforeId = await backup("before_sync", before);
  const afterId = await backup("after_sync", after);
  await query(`UPDATE taxonomy_runs SET before_id = $2, after_id = $3 WHERE id = $1`, [id, beforeId, afterId]);
  return id;
}

/** The fake bar-chart matcher: only this file's fixture names. */
const fixtureMatcher = (names: Record<string, string>) => ({
  match: (name: string) => (names[name] ? { code: names[name] } : null),
});

async function locationRows(runId: number) {
  return (
    await query<{ loc_code: string; reasons: string[]; species_codes: string[] }>(
      `SELECT loc_code, reasons, species_codes FROM taxonomy_refresh_locations WHERE run_id = $1 ORDER BY loc_code`,
      [runId],
    )
  ).rows;
}

async function cleanRuns() {
  if (!runIds.length) return;
  await query(`UPDATE taxonomy_runs SET superseded_by = NULL, before_id = NULL, after_id = NULL WHERE id = ANY($1)`, [runIds]);
  await query(`DELETE FROM taxonomy_refresh_locations WHERE run_id = ANY($1)`, [runIds]);
  await query(`DELETE FROM taxonomy_refresh_batches WHERE run_id = ANY($1)`, [runIds]);
  await query(`DELETE FROM taxonomy_changes WHERE run_id = ANY($1)`, [runIds]);
  await query(`DELETE FROM taxonomy_backups WHERE run_id = ANY($1)`, [runIds]);
  await query(`DELETE FROM taxonomy_runs WHERE id = ANY($1)`, [runIds]);
  runIds.length = 0;
}

async function cleanJobs() {
  const owned = await query<{ id: number }>(
    `SELECT id FROM jobs WHERE id = ANY($1) OR label = $2 OR (requested_by = $3)`,
    [jobIds, LABEL, adminId],
  );
  const ids = owned.rows.map((r) => r.id);
  await query(`DELETE FROM job_events WHERE job_id = ANY($1)`, [ids]);
  await query(`DELETE FROM jobs WHERE id = ANY($1)`, [ids]);
  jobIds.length = 0;
}

/**
 * startOrResumeRun adopts any run still to finish (before comparison, or
 * compared but not finished). Before a test lets it, no such run may exist
 * that this file does not own: adopting one would rewrite its job and let
 * cleanup delete someone else's history.
 */
async function assertNoForeignOpenRun() {
  const foreign = await query<{ id: string }>(
    `SELECT id FROM taxonomy_runs
      WHERE stage IN ('started','backed_up','applied','after_backed_up','compared')
        AND NOT (id = ANY($1::bigint[]))`,
    [runIds],
  );
  if (foreign.rowCount) {
    throw new Error(`birds_test has a taxonomy run this test does not own (${foreign.rows.map((r) => r.id).join(", ")}); not touching it.`);
  }
}

/** startOrResumeRun, only ever on runs this file owns; the run it returns is checked before cleanup may touch it. */
async function startOwned(userId: number) {
  await assertNoForeignOpenRun();
  const r = await startOrResumeRun(userId, LABEL);
  const run = await getRun(r.runId);
  if (!run || run.actor_label !== LABEL || !runIds.includes(r.runId) && run.requested_by !== userId) {
    throw new Error(`startOrResumeRun returned run ${r.runId}, which this test does not own.`);
  }
  if (!runIds.includes(r.runId)) runIds.push(r.runId);
  if (r.jobId) jobIds.push(r.jobId);
  return r;
}

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

describe.skipIf(!dbUp)("taxonomy refresh (td-6093ae)", () => {
  beforeAll(async () => {
    // Nothing start/resume could adopt: not before comparison, nor compared but unfinished.
    const open = await query(
      `SELECT 1 FROM taxonomy_runs WHERE stage IN ('started','backed_up','applied','after_backed_up','compared')`,
    );
    expect(open.rowCount, "no unfinished taxonomy run on birds_test before this file").toBe(0);
    adminId = (
      await query<{ id: number }>(
        `INSERT INTO users (username, display_name, password_hash, role)
         VALUES ($1, 'Taxonomy fixture', '!unset', 'admin') RETURNING id`,
        [`taxreftest-${tag}`],
      )
    ).rows[0].id;
    otherUserId = (
      await query<{ id: number }>(
        `INSERT INTO users (username, display_name, password_hash, role)
         VALUES ($1, 'Taxonomy fixture 2', '!unset', 'admin') RETURNING id`,
        [`taxreftest2-${tag}`],
      )
    ).rows[0].id;
  });

  afterEach(async () => {
    await cleanRuns();
    await cleanJobs();
    await query("DELETE FROM frequency_fetch_attempts WHERE loc_code = ANY($1)", [locIds]);
    await query("DELETE FROM frequency_fetch WHERE loc_code = ANY($1)", [locIds]);
  });

  afterAll(async () => {
    await cleanRuns();
    await cleanJobs();
    await query("DELETE FROM frequency_fetch WHERE loc_code = ANY($1)", [locIds]);
    await query("DELETE FROM user_ebird WHERE user_id = ANY($1)", [[adminId, otherUserId]]);
    await query("DELETE FROM users WHERE id = ANY($1)", [[adminId, otherUserId]]);
    const left = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM frequency_fetch WHERE loc_code = ANY($1)`,
      [locIds],
    );
    expect(left.rows[0].n).toBe(0);
  });

  it("compares two backups into changes and one row per location with every reason", async () => {
    const renamed = sp("a"); // a split that keeps its code: only the name changes
    const same = sp("b");
    const removed = sp("c");
    const added = sp("d");
    const detail = sp("h"); // only its family changed: counted, never reloaded
    const both = await location({ species: [renamed, same], unmatched: [`New ${tag}`, "Some hybrid"] });
    const untouched = await location({ species: [same, detail] });
    const gone = await location({ species: [removed] });
    const late = await location({ species: [same], fetchedAt: "3000-01-01T00:00:00Z" });
    const runId = await runReadyToCompare(
      [taxon(renamed), taxon(same), taxon(removed), taxon(detail)],
      [taxon(renamed, { com_name: `Western ${tag}` }), taxon(same), taxon(added), taxon(detail, { family: "Other family" })],
    );
    const matcher = fixtureMatcher({ [`New ${tag}`]: added });

    const counts = await compareRun(runId, matcher);
    expect(counts.changes).toMatchObject({ removed: 1, added: 1, common: 1, category: 0, other: 1 });
    expect(await locationRows(runId)).toEqual([
      { loc_code: both, reasons: ["changed_species", "now_matches"], species_codes: [renamed, added].sort() },
      { loc_code: gone, reasons: ["changed_species"], species_codes: [removed] },
      { loc_code: late, reasons: ["loaded_since_sync"], species_codes: [] },
    ].sort((x, y) => (x.loc_code < y.loc_code ? -1 : 1)));
    expect((await locationRows(runId)).map((r) => r.loc_code)).not.toContain(untouched);
    expect(counts.locations).toEqual({ total: 3, regions: 0, hotspots: 3 });
    expect(counts.reasons).toMatchObject({ changed_species: 2, now_matches: 1, loaded_since_sync: 1, carried_over: 0 });

    const changes = await query<{ taxon_code: string; kinds: string[]; affects: boolean; locations: number }>(
      `SELECT taxon_code, kinds, affects, locations FROM taxonomy_changes WHERE run_id = $1 ORDER BY taxon_code`,
      [runId],
    );
    expect(changes.rows).toEqual([
      { taxon_code: renamed, kinds: ["common"], affects: true, locations: 1 },
      { taxon_code: removed, kinds: ["removed"], affects: true, locations: 1 },
      { taxon_code: added, kinds: ["added"], affects: false, locations: 0 },
      { taxon_code: detail, kinds: ["other"], affects: false, locations: 1 },
    ]);
    const run = await getRun(runId);
    expect(run?.stage).toBe("compared");

    // A rerun rewrites the same rows (idempotent).
    await query(`UPDATE taxonomy_runs SET stage = 'after_backed_up' WHERE id = $1`, [runId]);
    await compareRun(runId, matcher);
    expect((await locationRows(runId)).length).toBe(3);
    expect((await query(`SELECT 1 FROM taxonomy_changes WHERE run_id = $1`, [runId])).rowCount).toBe(4);
  });

  it("carries an earlier run's unreloaded locations over and supersedes that run, only within its scope", async () => {
    const changed = sp("e");
    const stale = await location({ species: [changed] });
    const first = await runReadyToCompare([taxon(changed)], [taxon(changed, { sci_name: "Avis nova" })]);
    await compareRun(first, fixtureMatcher({}));
    // Stands for history this test does not own: outside the scope, untouched.
    const outside = await runReadyToCompare([taxon(changed)], [taxon(changed, { sci_name: "Avis alia" })]);
    await compareAny(outside, fixtureMatcher({}), [first]);
    await query(`UPDATE taxonomy_runs SET superseded_by = NULL WHERE id = $1`, [first]);
    const second = await runReadyToCompare([taxon(sp("f"))], [taxon(sp("f"))]);
    const counts = await compareAny(second, fixtureMatcher({}), [first]);
    expect((await getRun(outside))?.superseded_by).toBeNull();

    expect(await locationRows(second)).toEqual([{ loc_code: stale, reasons: ["carried_over"], species_codes: [changed] }]);
    expect(counts.reasons.carried_over).toBe(1);
    expect((await getRun(first))?.superseded_by).toBe(second);
    await expect(dispatchRefresh(first, adminId, "new")).rejects.toThrow(TaxonomyRunError);
  });

  it("queues fixed batches once, derives each location's state, and retries only what is unfinished", async () => {
    const changed = sp("g");
    const locs: string[] = [];
    for (let i = 0; i < 201; i++) locs.push(await location({ species: [changed] }));
    const runId = await runReadyToCompare([taxon(changed)], [taxon(changed, { category: "slash" })]);
    await compareRun(runId, fixtureMatcher({}));
    expect((await refreshProgress(runId)).counts.not_queued).toBe(201);

    const first = await dispatchRefresh(runId, adminId, "new");
    expect(first).toEqual({ batches: 2, locations: 201 });
    // A double click finds nothing left to queue.
    expect(await dispatchRefresh(runId, adminId, "new")).toEqual({ batches: 0, locations: 0 });
    const batches = await query<{ batch_no: number; job_id: number; dedup_key: string; payload: { locs: unknown[]; force: boolean } }>(
      `SELECT b.batch_no, b.job_id, j.dedup_key, j.payload FROM taxonomy_refresh_batches b JOIN jobs j ON j.id = b.job_id
        WHERE b.run_id = $1 ORDER BY b.batch_no`,
      [runId],
    );
    jobIds.push(...batches.rows.map((b) => b.job_id));
    expect(batches.rows.map((b) => [b.batch_no, b.dedup_key, b.payload.locs.length, b.payload.force])).toEqual([
      [1, `taxonomy_refresh:${runId}:1`, 200, true],
      [2, `taxonomy_refresh:${runId}:2`, 1, true],
    ]);
    expect((await refreshProgress(runId)).counts.queued).toBe(201);

    // Batch 1 ends with a failed attempt at one location and a reload at
    // another; the job stopped (e.g. a bad login) before reaching the rest.
    const [failedLoc, reloadedLoc] = locs;
    await query(`UPDATE jobs SET status = 'failed', error = 'eBird login rejected', finished_at = NOW() WHERE id = $1`, [
      batches.rows[0].job_id,
    ]);
    await query(
      `INSERT INTO frequency_fetch_attempts (loc_code, status, error, last_attempt_at) VALUES ($1, 'error', 'HTTP 500', clock_timestamp())`,
      [failedLoc],
    );
    await query(`UPDATE frequency_fetch SET fetched_at = clock_timestamp() WHERE loc_code = $1`, [reloadedLoc]);
    const progress = await refreshProgress(runId);
    expect(progress.counts).toMatchObject({ reloaded: 1, failed: 1, unfinished: 198, queued: 1 });
    expect(progress.batchError).toBe("eBird login rejected");
    expect(progress.problems.find((p) => p.loc_code === failedLoc)).toMatchObject({ state: "failed", error: "HTTP 500" });

    const retry = await dispatchRefresh(runId, adminId, "unfinished");
    expect(retry).toEqual({ batches: 1, locations: 199 });
    jobIds.push(
      ...(await query<{ job_id: number }>(`SELECT job_id FROM taxonomy_refresh_batches WHERE run_id = $1 AND batch_no = 3`, [runId])).rows.map(
        (r) => r.job_id,
      ),
    );
    // The last failure stays visible until a newer outcome.
    const kept = await query<{ last_error: string }>(
      `SELECT last_error FROM taxonomy_refresh_locations WHERE run_id = $1 AND loc_code = $2`,
      [runId, failedLoc],
    );
    expect(kept.rows[0].last_error).toBe("HTTP 500");
    expect((await refreshProgress(runId)).counts).toMatchObject({ reloaded: 1, queued: 200 });

    // Batch 2's job was pruned and batch 3's cancelled: their locations are unfinished, not lost.
    await query(`DELETE FROM job_events WHERE job_id = $1`, [batches.rows[1].job_id]);
    await query(`DELETE FROM jobs WHERE id = $1`, [batches.rows[1].job_id]);
    const third = jobIds.at(-1)!;
    await query(`UPDATE jobs SET status = 'cancelled', error = 'Cancelled by an admin', finished_at = NOW() WHERE id = $1`, [third]);
    expect((await refreshProgress(runId)).counts).toMatchObject({ reloaded: 1, unfinished: 200 });

    // Once every location is reloaded, no stopped batch is shown as something to fix.
    await query(`UPDATE frequency_fetch SET fetched_at = clock_timestamp() WHERE loc_code = ANY($1)`, [locs]);
    const done = await refreshProgress(runId);
    expect(done.counts).toMatchObject({ reloaded: 201 });
    expect(done.batchError).toBeNull();
    expect(done.problems).toEqual([]);
  });

  it("checks for the eBird account login a reload needs", async () => {
    expect(await hasEbirdLogin(adminId)).toBe(false);
    await query(
      `INSERT INTO user_ebird (user_id, login_username_enc, login_password_enc) VALUES ($1, 'x.y.z', 'x.y.z')
       ON CONFLICT (user_id) DO UPDATE SET login_username_enc = 'x.y.z', login_password_enc = 'x.y.z'`,
      [adminId],
    );
    expect(await hasEbirdLogin(adminId)).toBe(true);
  });

  describe("a run, stage by stage (sync boundary replaced)", () => {
    /** The current taxonomy_cache as eBird would send it. */
    async function currentAsEbird() {
      const r = await query<{
        species_code: string;
        com_name: string;
        sci_name: string;
        category: string;
        family: string | null;
        taxon_order: string | null;
        order_name: string | null;
        family_code: string | null;
        family_sci_name: string | null;
        banding_codes: string[] | null;
        report_as: string | null;
        extinct: boolean | null;
      }>(`SELECT species_code, com_name, sci_name, category, family, taxon_order::text, order_name, family_code,
                 family_sci_name, banding_codes, report_as, extinct FROM taxonomy_cache`);
      return r.rows.map((t) => ({
        speciesCode: t.species_code,
        comName: t.com_name,
        sciName: t.sci_name,
        category: t.category,
        familyComName: t.family,
        taxonOrder: t.taxon_order == null ? null : Number(t.taxon_order),
        order: t.order_name,
        familyCode: t.family_code,
        familySciName: t.family_sci_name,
        bandingCodes: t.banding_codes,
        reportAs: t.report_as,
        extinct: t.extinct,
      }));
    }

    function deps(over: Partial<RunDeps> = {}) {
      const calls = { fetch: 0, replace: 0, finish: 0, versions: [] as (string | null)[] };
      const d: RunDeps = {
        apiKey: async () => "fixture-key",
        fetchTaxonomy: async (_key, version) => {
          calls.fetch++;
          calls.versions.push(version);
          return currentAsEbird();
        },
        latestVersion: async () => "2099",
        // Never rewrites taxonomy_cache: only records "applied", as the real
        // replacement does inside its own transaction.
        replace: async (_payload, _req, onApplied) => {
          calls.replace++;
          await onApplied({ exec: (text: string, params: unknown[]) => query(text, params) } as never);
          return 0;
        },
        finish: async () => {
          calls.finish++;
          return { finished: true };
        },
        matcher: async () => fixtureMatcher({}),
        earlierRuns: runIds,
        ...over,
      };
      return { d, calls };
    }

    async function newRun() {
      const r = await query<{ id: string }>(
        `INSERT INTO taxonomy_runs (requested_by, actor_label) VALUES ($1, $2) RETURNING id`,
        [adminId, LABEL],
      );
      const id = Number(r.rows[0].id);
      runIds.push(id);
      return { id, job: { id: 0, requested_by: adminId, payload: { runId: id } } as unknown as JobRow };
    }

    it("backs up, applies, backs up, compares and finishes, recording the version", async () => {
      const { id, job } = await newRun();
      const { d, calls } = deps();
      const result = await runTaxonomyRun(job, d);
      const run = await getRun(id);
      expect(run).toMatchObject({ stage: "done", failed_stage: null, error: null, target_version: "2099" });
      expect(result).toMatchObject({ runId: id, stage: "done", finished: true });
      // The taxonomy is fetched AT the version the run records.
      expect(calls).toEqual({ fetch: 1, replace: 1, finish: 1, versions: ["2099"] });
      const backups = await query<{ kind: string; taxa: number }>(
        `SELECT kind, taxa FROM taxonomy_backups WHERE run_id = $1 ORDER BY kind DESC`,
        [id],
      );
      const taxa = (await query<{ n: number }>(`SELECT count(*)::int AS n FROM taxonomy_cache`)).rows[0].n;
      expect(backups.rows).toEqual([
        { kind: "before_sync", taxa },
        { kind: "after_sync", taxa },
      ]);
      expect(run?.counts?.changes).toMatchObject({ removed: 0, added: 0, common: 0 });
    });

    it("resumes after a failure without fetching or replacing again once applied", async () => {
      const { id, job } = await newRun();
      const failing = deps({
        finish: async () => {
          throw new Error("photo re-match failed");
        },
      });
      await expect(runTaxonomyRun(job, failing.d)).rejects.toThrow("photo re-match failed");
      expect(await getRun(id)).toMatchObject({ stage: "compared", failed_stage: "done", error: "photo re-match failed" });

      // eBird has changed meanwhile: a resumed run must not fetch it.
      const resumed = deps({
        fetchTaxonomy: async () => {
          throw new Error("must not refetch");
        },
      });
      await runTaxonomyRun(job, resumed.d);
      expect(await getRun(id)).toMatchObject({ stage: "done", failed_stage: null, error: null });
      expect(resumed.calls).toMatchObject({ replace: 0, finish: 1 });
    });

    it("keeps the first backup when the fetch fails, then resumes from it", async () => {
      const { id, job } = await newRun();
      const failing = deps({
        fetchTaxonomy: async () => {
          throw new Error("eBird unreachable");
        },
      });
      await expect(runTaxonomyRun(job, failing.d)).rejects.toThrow("eBird unreachable");
      const halfway = await getRun(id);
      expect(halfway).toMatchObject({ stage: "backed_up", failed_stage: "applied" });
      await runTaxonomyRun(job, deps().d);
      const done = await getRun(id);
      expect(done?.stage).toBe("done");
      expect(done?.before_id).toBe(halfway?.before_id);
    });

    it("resumes after the taxonomy was applied but before its second backup", async () => {
      const { id, job } = await newRun();
      const failing = deps({
        replace: async (_payload, _req, onApplied) => {
          await onApplied({ exec: (text: string, params: unknown[]) => query(text, params) } as never);
          throw new Error("worker stopped right after the replacement committed");
        },
      });
      await expect(runTaxonomyRun(job, failing.d)).rejects.toThrow(/worker stopped/);
      expect(await getRun(id)).toMatchObject({ stage: "applied", failed_stage: "after_backed_up" });
      const resumed = deps({
        fetchTaxonomy: async () => {
          throw new Error("must not refetch");
        },
      });
      await runTaxonomyRun(job, resumed.d);
      expect(await getRun(id)).toMatchObject({ stage: "done", failed_stage: null });
      expect(resumed.calls).toMatchObject({ fetch: 0, replace: 0, finish: 1 });
    });

    it("resumes after the second backup when the comparison failed", async () => {
      const { id, job } = await newRun();
      const failing = deps({
        matcher: async () => {
          throw new Error("matcher unavailable");
        },
      });
      await expect(runTaxonomyRun(job, failing.d)).rejects.toThrow("matcher unavailable");
      const halfway = await getRun(id);
      expect(halfway).toMatchObject({ stage: "after_backed_up", failed_stage: "compared" });
      const resumed = deps();
      await runTaxonomyRun(job, resumed.d);
      const done = await getRun(id);
      expect(done).toMatchObject({ stage: "done", failed_stage: null });
      expect(done?.after_id).toBe(halfway?.after_id);
      expect(resumed.calls).toMatchObject({ fetch: 0, replace: 0, finish: 1 });
    });

    it("refuses an after-backup that is not the taxonomy the run applied", async () => {
      const { id, job } = await newRun();
      const changed = deps({
        fetchTaxonomy: async () => {
          const rows = await currentAsEbird();
          rows[0] = { ...rows[0], comName: `${rows[0].comName} (changed)` };
          return rows;
        },
      });
      await expect(runTaxonomyRun(job, changed.d)).rejects.toThrow(/not the one this run applied/);
      expect(await getRun(id)).toMatchObject({ stage: "applied", failed_stage: "after_backed_up" });
    });

    it("writes nothing for a stale execution", async () => {
      const { id } = await newRun();
      const jobId = (
        await query<{ id: number }>(
          `INSERT INTO jobs (type, payload, requested_by, label, max_attempts)
           VALUES ('tag_preview', $1, $2, $3, 3) RETURNING id`,
          [JSON.stringify({ runId: id }), adminId, LABEL],
        )
      ).rows[0].id;
      jobIds.push(jobId);
      const a = await claim(jobId);
      await runWithClaim(a, () => requeueInterrupted(jobId, a.attempts));
      await claim(jobId);
      await expect(runWithClaim(a, () => runTaxonomyRun(a, deps().d))).rejects.toThrow(StaleClaimError);
      expect(await getRun(id)).toMatchObject({ stage: "started", before_id: null });
    });
  });

  it("Try again resumes a run whose finishing failed, through the action path, instead of starting another", async () => {
    const changed = sp("j");
    const runId = await runReadyToCompare([taxon(changed)], [taxon(changed)]);
    await compareRun(runId, fixtureMatcher({}));
    await query(`UPDATE taxonomy_runs SET failed_stage = 'done', error = 'photo re-match failed' WHERE id = $1`, [runId]);
    const pending = await query(`SELECT 1 FROM jobs WHERE dedup_key = 'sync_taxonomy:global' AND status IN ('pending','running')`);
    expect(pending.rowCount, "no sync_taxonomy job active on birds_test").toBe(0);
    const resumed = await startOwned(adminId);
    expect(resumed).toMatchObject({ runId, resumed: true, alreadyRunning: false });
    const job = await query<{ payload: { runId: number } }>(`SELECT payload FROM jobs WHERE id = $1`, [resumed.jobId]);
    expect(job.rows[0].payload).toEqual({ runId });
  });

  it("never adopts an unfinished run it does not own", async () => {
    // Stands for a real unfinished run already on birds_test. Created here
    // (so its own cleanup is safe), but deliberately NOT registered as owned.
    const foreign = Number(
      (
        await query<{ id: string }>(
          `INSERT INTO taxonomy_runs (requested_by, actor_label, stage, applied_at, compared_at, failed_stage, error, job_id)
           VALUES (NULL, 'Someone else', 'compared', NOW(), NOW(), 'done', 'photo re-match failed', 424242) RETURNING id`,
        )
      ).rows[0].id,
    );
    try {
      await expect(startOwned(adminId)).rejects.toThrow(/does not own/);
      const after = await getRun(foreign);
      expect(after).toMatchObject({ stage: "compared", job_id: 424242, failed_stage: "done", actor_label: "Someone else" });
      expect(runIds).not.toContain(foreign);
    } finally {
      await query(`DELETE FROM taxonomy_runs WHERE id = $1 AND actor_label = 'Someone else'`, [foreign]);
    }
  });

  it("writes nothing when comparing under a stale claim", async () => {
    const changed = sp("k");
    const runId = await runReadyToCompare([taxon(changed)], [taxon(changed, { com_name: "Renamed" })]);
    const jobId = (
      await query<{ id: number }>(
        `INSERT INTO jobs (type, payload, requested_by, label, max_attempts) VALUES ('tag_preview', '{}', $1, $2, 3) RETURNING id`,
        [adminId, LABEL],
      )
    ).rows[0].id;
    jobIds.push(jobId);
    const a = await claim(jobId);
    await runWithClaim(a, () => requeueInterrupted(jobId, a.attempts));
    await claim(jobId);
    await expect(runWithClaim(a, () => compareRun(runId, fixtureMatcher({})))).rejects.toThrow(StaleClaimError);
    expect((await getRun(runId))?.stage).toBe("after_backed_up");
    expect((await query(`SELECT 1 FROM taxonomy_changes WHERE run_id = $1`, [runId])).rowCount).toBe(0);
  });

  it("says the life-list count is unavailable rather than zero when it fails", async () => {
    const panel = await taxonomyPanel({
      runId: null,
      latest: async () => null,
      canSync: true,
      canRefresh: true,
      orphans: async () => {
        throw new Error("database busy");
      },
    });
    expect(panel.orphans).toBeNull();
  });

  it("lets the app role use every new table", async () => {
    const r = await query<{ t: string; ok: boolean }>(
      `SELECT t, has_table_privilege('birds_app', t, 'SELECT,INSERT,UPDATE,DELETE') AS ok
         FROM unnest(ARRAY['taxonomy_runs','taxonomy_backups','taxonomy_backup_rows','taxonomy_changes',
                           'taxonomy_refresh_batches','taxonomy_refresh_locations']) t`,
    );
    expect(r.rows.filter((x) => !x.ok)).toEqual([]);
  });

  it("starts one run at a time, resumes a stopped one, and keeps history when its requester is deleted", async () => {
    const pending = await query(`SELECT 1 FROM jobs WHERE dedup_key = 'sync_taxonomy:global' AND status IN ('pending','running')`);
    expect(pending.rowCount, "no sync_taxonomy job active on birds_test").toBe(0);
    const started = await startOwned(otherUserId);
    expect(started).toMatchObject({ resumed: false, alreadyRunning: false });
    expect(typeof started.jobId).toBe("number");
    const job = await query<{ type: string; payload: { runId: number } }>(`SELECT type, payload FROM jobs WHERE id = $1`, [started.jobId]);
    expect(job.rows[0]).toEqual({ type: "sync_taxonomy", payload: { runId: started.runId } });

    expect(await startOwned(otherUserId)).toMatchObject({ runId: started.runId, alreadyRunning: true });

    await query(`UPDATE jobs SET status = 'failed', finished_at = NOW() WHERE id = $1`, [started.jobId]);
    const resumed = await startOwned(otherUserId);
    expect(resumed).toMatchObject({ runId: started.runId, resumed: true });
    expect(resumed.jobId).not.toBe(started.jobId);

    await query(`DELETE FROM job_events WHERE job_id = ANY($1)`, [jobIds]);
    await query(`DELETE FROM jobs WHERE id = ANY($1)`, [jobIds]);
    await query(`DELETE FROM users WHERE id = $1`, [otherUserId]);
    expect((await getRun(started.runId))?.requested_by).toBeNull();
  });
});

/**
 * Admin → Taxonomy refresh (td-6093ae; plan docs/2026-10-30-taxonomy-refresh-plan-CC.md).
 *
 * A RUN backs the eBird taxonomy up, syncs it, backs it up again, compares the
 * two backups and lists the stored frequency locations to reload; the admin
 * then dispatches those reloads as fixed batches of refresh_loc jobs.
 *
 * Stages (taxonomy_runs.stage = the last stage completed):
 *   started → backed_up → applied → after_backed_up → compared → done
 * Every stage commits on its own, claim-fenced; a retry resumes after the
 * recorded stage. "applied" is written inside the replacement transaction
 * with the hash of the taxonomy installed, so a retry never fetches or
 * replaces again once the new taxonomy is in, and never compares one
 * taxonomy while another is installed.
 */
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { query, withTransaction } from '$lib/db';
import { withClaimTx, isStaleClaim } from '$server/job-claim';
import { insertJobOn } from '$server/jobs';
import { dedupKeys, type JobRow } from '$server/job-policy';
import { parseTaxonomy, replaceTaxonomy, type TaxonomyEntry } from '$server/taxonomy-sync';
import type { TagWriteTx } from '$server/tag-engine/runtime';

// ── taxa and their changes (pure) ──────────────────────────────────────────

/** One taxon, every business column of taxonomy_cache (0001 + 0057). */
export interface TaxonRow {
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
}

export const CHANGE_KINDS = ['removed', 'added', 'category', 'scientific', 'common', 'report_as', 'other'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export interface TaxonChange {
	code: string;
	kinds: ChangeKind[];
	before: TaxonRow | null;
	after: TaxonRow | null;
	/** Its stored frequency rows need a reload. */
	affects: boolean;
}

const ORDERED_FIELDS = ['family', 'order_name', 'family_code', 'family_sci_name', 'extinct'] as const;

/** One canonical form, so a taxon read back from Postgres equals the one parsed from eBird. */
export function normalizeTaxon(t: TaxonRow): TaxonRow {
	const order = t.taxon_order == null || t.taxon_order === '' ? null : String(Number(t.taxon_order));
	const banding = t.banding_codes == null ? null : [...new Set(t.banding_codes.map((b) => b.toUpperCase()))].sort();
	return {
		species_code: t.species_code,
		com_name: t.com_name,
		sci_name: t.sci_name,
		category: t.category,
		family: t.family ?? null,
		taxon_order: order,
		order_name: t.order_name ?? null,
		family_code: t.family_code ?? null,
		family_sci_name: t.family_sci_name ?? null,
		banding_codes: banding,
		report_as: t.report_as ?? null,
		extinct: t.extinct ?? null
	};
}

/** The taxon writeTaxonomy stores for one parsed eBird entry. */
export function taxonFromEntry(e: TaxonomyEntry): TaxonRow {
	return normalizeTaxon({
		species_code: e.speciesCode,
		com_name: e.comName,
		sci_name: e.sciName,
		category: e.category,
		family: e.familyComName,
		taxon_order: e.taxonOrder == null ? null : String(e.taxonOrder),
		order_name: e.order,
		family_code: e.familyCode,
		family_sci_name: e.familySciName,
		banding_codes: e.bandingCodes,
		report_as: e.reportAs,
		extinct: e.extinct
	});
}

/** Order-independent hash of a whole taxonomy, comparable across eBird and Postgres. */
export function taxonomyHash(taxa: readonly TaxonRow[]): string {
	const rows = taxa.map((t) => normalizeTaxon(t)).sort((a, b) => (a.species_code < b.species_code ? -1 : 1));
	const h = createHash('sha256');
	for (const r of rows) h.update(JSON.stringify(r) + '\n');
	return h.digest('hex');
}

/**
 * Every difference between two taxonomies, by code, and the species whose
 * stored frequencies need a reload:
 *  - a code that WAS a species and was removed, left the species category,
 *    or changed scientific or common name. A common-name-only change counts:
 *    a split that keeps the old code for one daughter shows up only as a new
 *    name (Marsh Wren → Western Marsh Wren), yet that species' range shrank.
 *  - the old and new reporting parents of any report_as change (an issf or
 *    form now reported as a different species: a sign of a split or lump).
 * Limits: a code reused for a new concept with identical fields cannot be
 * seen in two snapshots; an added species is reached only through its
 * parent's change, or through the "loaded since the last sync" locations.
 */
export function classifyChanges(
	before: readonly TaxonRow[],
	after: readonly TaxonRow[]
): { changes: TaxonChange[]; affecting: Set<string> } {
	const was = new Map(before.map((t) => [t.species_code, normalizeTaxon(t)]));
	const now = new Map(after.map((t) => [t.species_code, normalizeTaxon(t)]));
	const changes: TaxonChange[] = [];
	const affecting = new Set<string>();
	const codes = [...new Set([...was.keys(), ...now.keys()])].sort();
	for (const code of codes) {
		const b = was.get(code) ?? null;
		const a = now.get(code) ?? null;
		const kinds: ChangeKind[] = [];
		if (b && !a) kinds.push('removed');
		else if (!b && a) kinds.push('added');
		else if (b && a) {
			if (b.category !== a.category) kinds.push('category');
			if (b.sci_name !== a.sci_name) kinds.push('scientific');
			if (b.com_name !== a.com_name) kinds.push('common');
			if (b.report_as !== a.report_as) kinds.push('report_as');
			const other =
				ORDERED_FIELDS.some((f) => b[f] !== a[f]) ||
				b.taxon_order !== a.taxon_order ||
				JSON.stringify(b.banding_codes) !== JSON.stringify(a.banding_codes);
			if (other) kinds.push('other');
		}
		if (!kinds.length) continue;
		const affects =
			b?.category === 'species' && kinds.some((k) => k === 'removed' || k === 'category' || k === 'scientific' || k === 'common');
		if (affects) affecting.add(code);
		if (kinds.includes('report_as')) {
			if (b?.report_as) affecting.add(b.report_as);
			if (a?.report_as) affecting.add(a.report_as);
		}
		changes.push({ code, kinds, before: b, after: a, affects });
	}
	for (const c of changes) if (affecting.has(c.code)) c.affects = true;
	return { changes, affecting };
}

// ── runs ───────────────────────────────────────────────────────────────────

export const RUN_STAGES = ['started', 'backed_up', 'applied', 'after_backed_up', 'compared', 'done'] as const;
export type RunStage = (typeof RUN_STAGES)[number];

export interface TaxonomyRun {
	id: number;
	requested_by: number | null;
	actor_label: string | null;
	job_id: number | null;
	stage: RunStage;
	failed_stage: string | null;
	error: string | null;
	before_id: number | null;
	after_id: number | null;
	target_hash: string | null;
	target_version: string | null;
	applied_at: string | null;
	compared_at: string | null;
	counts: RunCounts | null;
	superseded_by: number | null;
	created_at: string;
}

export interface RunCounts {
	changes: Record<ChangeKind, number>;
	locations: { total: number; regions: number; hotspots: number };
	reasons: Record<RefreshReason, number>;
	taxaBefore: number;
	taxaAfter: number;
}

export const REFRESH_REASONS = ['changed_species', 'now_matches', 'loaded_since_sync', 'carried_over'] as const;
export type RefreshReason = (typeof REFRESH_REASONS)[number];

const RUN_COLUMNS = `id, requested_by, actor_label, job_id, stage, failed_stage, error, before_id, after_id,
	target_hash, target_version, applied_at::text, compared_at::text, counts, superseded_by, created_at::text`;

/** BIGINT ids arrive from pg as strings. */
const idOrNull = (v: unknown): number | null => (v == null ? null : Number(v));

function toRun(row: TaxonomyRun): TaxonomyRun {
	return {
		...row,
		id: Number(row.id),
		job_id: idOrNull(row.job_id),
		before_id: idOrNull(row.before_id),
		after_id: idOrNull(row.after_id),
		superseded_by: idOrNull(row.superseded_by)
	};
}

export async function getRun(id: number): Promise<TaxonomyRun | null> {
	const r = await query<TaxonomyRun>(`SELECT ${RUN_COLUMNS} FROM taxonomy_runs WHERE id = $1`, [id]);
	return r.rows[0] ? toRun(r.rows[0]) : null;
}

export class TaxonomyRunError extends Error {}

/**
 * The run still to finish, if any: one not yet compared (failed or not; at
 * most one, by index), or a compared run whose finishing never completed
 * (photo matches, families). Either is resumed, never replaced.
 */
async function openRun(c: pg.PoolClient): Promise<{ id: number; job_id: number | null } | null> {
	const r = await c.query<{ id: string; job_id: string | null }>(
		`SELECT id, job_id FROM taxonomy_runs
		  WHERE stage IN ('started','backed_up','applied','after_backed_up','compared')
		  ORDER BY id DESC LIMIT 1 FOR UPDATE`
	);
	const row = r.rows[0];
	return row ? { id: Number(row.id), job_id: idOrNull(row.job_id) } : null;
}

const SYNC_LABEL = 'eBird taxonomy: back up, sync and compare';

/**
 * Start a run, or resume the open one ("Try again"), and queue its job, in
 * one transaction. A new run is refused while one is open: it would back up
 * a taxonomy the open run may already have replaced.
 */
export async function startOrResumeRun(
	adminId: number,
	actorLabel: string
): Promise<{ runId: number; jobId: number | null; resumed: boolean; alreadyRunning: boolean }> {
	return withTransaction(async (c) => {
		const open = await openRun(c);
		if (open) {
			const active = open.job_id
				? await c.query(`SELECT 1 FROM jobs WHERE id = $1 AND status IN ('pending','running')`, [open.job_id])
				: { rowCount: 0 };
			if (active.rowCount) return { runId: open.id, jobId: open.job_id, resumed: false, alreadyRunning: true };
			const jobId = idOrNull(await insertJobOn(c, {
				type: 'sync_taxonomy',
				payload: { runId: open.id },
				dedupKey: dedupKeys.syncTaxonomy(),
				requestedBy: adminId,
				label: SYNC_LABEL
			}));
			if (jobId == null) return { runId: open.id, jobId: null, resumed: false, alreadyRunning: true };
			await c.query(`UPDATE taxonomy_runs SET job_id = $2 WHERE id = $1`, [open.id, jobId]);
			return { runId: open.id, jobId, resumed: true, alreadyRunning: false };
		}
		const run = await c.query<{ id: number }>(
			`INSERT INTO taxonomy_runs (requested_by, actor_label) VALUES ($1, $2) RETURNING id`,
			[adminId, actorLabel]
		);
		const runId = Number(run.rows[0].id);
		const jobId = idOrNull(await insertJobOn(c, {
			type: 'sync_taxonomy',
			payload: { runId },
			dedupKey: dedupKeys.syncTaxonomy(),
			requestedBy: adminId,
			label: SYNC_LABEL
		}));
		if (jobId == null) throw new TaxonomyRunError('A taxonomy sync is already queued.');
		await c.query(`UPDATE taxonomy_runs SET job_id = $2 WHERE id = $1`, [runId, jobId]);
		return { runId, jobId, resumed: false, alreadyRunning: false };
	});
}

// ── the job: one run, stage by stage ───────────────────────────────────────

/** What the job does outside this module; tests replace it. */
export interface RunDeps {
	apiKey: () => Promise<string>;
	/** The taxonomy of `version`, or eBird's current one when the version is unknown. */
	fetchTaxonomy: (apiKey: string, version: string | null) => Promise<unknown>;
	/** eBird's latest version, asked fresh (never a cached answer): the run records it. */
	latestVersion: (apiKey: string) => Promise<string | null>;
	replace: (payload: unknown, requesterId: number, onApplied: (tx: TagWriteTx) => Promise<void>) => Promise<number>;
	/** The existing after-sync steps: photo re-match, summary, family enrichment, orphans. */
	finish: () => Promise<Record<string, unknown>>;
	matcher: () => Promise<{ match(name: string): { code: string } | null }>;
	/** Earlier runs a comparison may carry over and supersede; default all. Tests scope it. */
	earlierRuns?: number[];
}

export const defaultReplace: RunDeps['replace'] = (payload, requesterId, onApplied) =>
	replaceTaxonomy(payload, requesterId, { onApplied });

async function backupRows(c: pg.PoolClient, backupId: number): Promise<TaxonRow[]> {
	const r = await c.query<TaxonRow>(
		`SELECT species_code, com_name, sci_name, category, family, taxon_order::text, order_name, family_code,
		        family_sci_name, banding_codes, report_as, extinct
		   FROM taxonomy_backup_rows WHERE backup_id = $1`,
		[backupId]
	);
	return r.rows;
}

/** Back up taxonomy_cache for a run, once per kind; a retry reuses it. */
async function takeBackup(runId: number, kind: 'before_sync' | 'after_sync', version: string | null): Promise<number> {
	return withClaimTx(
		async (c) => {
			const existing = await c.query<{ id: string }>(
				`SELECT id FROM taxonomy_backups WHERE run_id = $1 AND kind = $2`,
				[runId, kind]
			);
			let id = existing.rows[0] ? Number(existing.rows[0].id) : null;
			if (id == null) {
				const b = await c.query<{ id: string }>(
					`INSERT INTO taxonomy_backups (run_id, kind, taxa, source_fetched_at, ebird_version)
					 SELECT $1, $2, count(*), max(fetched_at), $3 FROM taxonomy_cache RETURNING id`,
					[runId, kind, version]
				);
				id = Number(b.rows[0].id);
				await c.query(
					`INSERT INTO taxonomy_backup_rows (backup_id, species_code, com_name, sci_name, category, family,
					        taxon_order, order_name, family_code, family_sci_name, banding_codes, report_as, extinct)
					 SELECT $1, species_code, com_name, sci_name, category, family, taxon_order, order_name,
					        family_code, family_sci_name, banding_codes, report_as, extinct
					   FROM taxonomy_cache`,
					[id]
				);
			}
			const column = kind === 'before_sync' ? 'before_id' : 'after_id';
			const next = kind === 'before_sync' ? 'backed_up' : 'after_backed_up';
			if (kind === 'after_sync') {
				const run = await c.query<{ target_hash: string | null }>(`SELECT target_hash FROM taxonomy_runs WHERE id = $1`, [runId]);
				const installed = taxonomyHash(await backupRows(c, id));
				if (run.rows[0]?.target_hash && installed !== run.rows[0].target_hash) {
					throw new TaxonomyRunError(
						'The installed taxonomy is not the one this run applied (it changed underneath the run).'
					);
				}
			}
			await c.query(
				`UPDATE taxonomy_runs SET ${column} = $2, stage = $3, failed_stage = NULL, error = NULL WHERE id = $1`,
				[runId, id, next]
			);
			return id;
		},
		{ where: `taxonomy backup (${kind})` }
	);
}

/**
 * Run (or resume) one taxonomy refresh run. Returns the job result: compact
 * counts, never rows. Throws to let runSyncJob classify and retry; the
 * failing stage and error are kept on the run for the card.
 */
export async function runTaxonomyRun(job: JobRow, deps: RunDeps): Promise<Record<string, unknown>> {
	const runId = Number((job.payload as { runId?: unknown } | null)?.runId);
	if (!Number.isSafeInteger(runId) || runId <= 0) throw new TaxonomyRunError('This sync has no taxonomy run.');
	let run = await getRun(runId);
	if (!run) throw new TaxonomyRunError('Taxonomy run not found.');
	try {
		if (run.stage === 'started') {
			await takeBackup(runId, 'before_sync', null);
			run = (await getRun(runId))!;
		}
		if (run.stage === 'backed_up') {
			const apiKey = await deps.apiKey();
			// The version is asked fresh, then the taxonomy fetched AT that
			// version, so what the run records is what it installed. Unknown
			// version: eBird's current taxonomy, recorded as unknown.
			const version = await deps.latestVersion(apiKey).catch(() => null);
			const payload = await deps.fetchTaxonomy(apiKey, version);
			const hash = taxonomyHash(parseTaxonomy(payload).map(taxonFromEntry));
			await deps.replace(payload, job.requested_by, async (tx) => {
				await tx.exec(
					`UPDATE taxonomy_runs SET stage = 'applied', target_hash = $2, target_version = $3,
					        applied_at = clock_timestamp(), failed_stage = NULL, error = NULL
					  WHERE id = $1`,
					[runId, hash, version]
				);
			});
			run = (await getRun(runId))!;
		}
		if (run.stage === 'applied') {
			await takeBackup(runId, 'after_sync', run.target_version);
			run = (await getRun(runId))!;
		}
		if (run.stage === 'after_backed_up') {
			const matcher = await deps.matcher();
			await compareRun(runId, matcher, deps.earlierRuns);
			run = (await getRun(runId))!;
		}
		let finished: Record<string, unknown> = {};
		if (run.stage === 'compared') {
			finished = await deps.finish();
			await withClaimTx(
				(c) => c.query(`UPDATE taxonomy_runs SET stage = 'done', failed_stage = NULL, error = NULL WHERE id = $1`, [runId]),
				{ where: 'taxonomy run done' }
			);
			run = (await getRun(runId))!;
		}
		return { runId, stage: run.stage, version: run.target_version, ...(run.counts ?? {}), ...finished };
	} catch (err) {
		if (isStaleClaim(err)) throw err;
		const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
		const current = await getRun(runId);
		const failed = current ? nextStage(current.stage) : null;
		await withClaimTx(
			(c) => c.query(`UPDATE taxonomy_runs SET failed_stage = $2, error = $3 WHERE id = $1`, [runId, failed, message]),
			{ where: 'taxonomy run failure' }
		);
		throw err;
	}
}

/** The stage a run was working on when it failed. */
function nextStage(stage: RunStage): RunStage | null {
	const i = RUN_STAGES.indexOf(stage);
	return i >= 0 && i < RUN_STAGES.length - 1 ? RUN_STAGES[i + 1] : null;
}

// ── comparison and the locations to reload ─────────────────────────────────

interface LocationReason {
	loc_code: string;
	reason: RefreshReason;
	species: string[];
}

/**
 * Compare a run's two backups and write its changes and its locations to
 * reload, in one transaction. Idempotent: a rerun replaces both. Earlier
 * runs' unfinished locations are carried over and those runs superseded.
 * `matcher` must be built from the NEW taxonomy (after the sync), called the
 * way barchart.ts calls it: with the bar-chart name only.
 */
export async function compareRun(
	runId: number,
	matcher: { match(name: string): { code: string } | null },
	earlierRuns?: number[]
): Promise<RunCounts> {
	// null = every earlier run (production); a list confines carry-over and
	// superseding to those runs (tests never touch history they don't own).
	const scope = earlierRuns ?? null;
	return withClaimTx(
		async (c) => {
			const run = await c.query<{ before_id: string; after_id: string; applied_at: string | null }>(
				`SELECT before_id, after_id, applied_at FROM taxonomy_runs WHERE id = $1 FOR UPDATE`,
				[runId]
			);
			const r = run.rows[0];
			if (!r?.before_id || !r?.after_id) throw new TaxonomyRunError('This run has no backups to compare.');
			const beforeId = Number(r.before_id);
			const afterId = Number(r.after_id);
			const before = await backupRows(c, beforeId);
			const after = await backupRows(c, afterId);
			const { changes, affecting } = classifyChanges(before, after);

			await c.query(`DELETE FROM taxonomy_refresh_locations WHERE run_id = $1 AND batch_no IS NULL`, [runId]);
			await c.query(`DELETE FROM taxonomy_changes WHERE run_id = $1`, [runId]);

			const reasons: LocationReason[] = [];
			// 1. Locations holding a changed species.
			const changed = await c.query<{ loc_code: string; codes: string[] }>(
				`SELECT loc_code, array_agg(DISTINCT species_code ORDER BY species_code) AS codes
				   FROM species_frequency WHERE species_code = ANY($1::text[]) GROUP BY loc_code`,
				[[...affecting]]
			);
			for (const row of changed.rows) reasons.push({ loc_code: row.loc_code, reason: 'changed_species', species: row.codes });
			// 2. Stored unmatched names that now match a species. The stored list
			//    is a sample (at most 20 names): positive evidence only.
			const unmatched = await c.query<{ loc_code: string; names: string[] }>(
				`SELECT loc_code, unmatched_names AS names FROM frequency_fetch WHERE cardinality(unmatched_names) > 0`
			);
			for (const row of unmatched.rows) {
				const codes = [...new Set(row.names.map((n) => matcher.match(n)?.code).filter((x): x is string => !!x))].sort();
				if (codes.length) reasons.push({ loc_code: row.loc_code, reason: 'now_matches', species: codes });
			}
			// 3. Loaded since the taxonomy before this run was fetched: eBird may
			//    already have renamed species those loads could not match.
			const since = await c.query<{ loc_code: string }>(
				`SELECT f.loc_code FROM frequency_fetch f, taxonomy_backups b
				  WHERE b.id = $1 AND b.source_fetched_at IS NOT NULL AND f.fetched_at > b.source_fetched_at`,
				[beforeId]
			);
			for (const row of since.rows) reasons.push({ loc_code: row.loc_code, reason: 'loaded_since_sync', species: [] });
			// 4. Earlier runs' locations not reloaded since their taxonomy was applied.
			const carried = await c.query<{ loc_code: string; species: string[] }>(
				`SELECT l.loc_code, array_agg(DISTINCT s ORDER BY s) FILTER (WHERE s IS NOT NULL) AS species
				   FROM taxonomy_refresh_locations l
				   JOIN taxonomy_runs p ON p.id = l.run_id
				   LEFT JOIN frequency_fetch f ON f.loc_code = l.loc_code
				   LEFT JOIN LATERAL unnest(l.species_codes) s ON TRUE
				  WHERE p.id <> $1 AND (p.superseded_by IS NULL OR p.superseded_by = $1)
				    AND p.stage IN ('compared','done')
				    AND ($2::bigint[] IS NULL OR p.id = ANY($2::bigint[]))
				    AND f.loc_code IS NOT NULL AND f.fetched_at <= p.applied_at
				  GROUP BY l.loc_code`,
				[runId, scope]
			);
			for (const row of carried.rows) reasons.push({ loc_code: row.loc_code, reason: 'carried_over', species: row.species ?? [] });
			await c.query(
				`UPDATE taxonomy_runs SET superseded_by = $1
				  WHERE id <> $1 AND superseded_by IS NULL AND stage IN ('compared','done')
				    AND ($2::bigint[] IS NULL OR id = ANY($2::bigint[]))`,
				[runId, scope]
			);

			// One row per location: its reasons and species aggregated.
			const byLoc = new Map<string, { reasons: Set<RefreshReason>; species: Set<string> }>();
			for (const x of reasons) {
				const e = byLoc.get(x.loc_code) ?? { reasons: new Set(), species: new Set() };
				e.reasons.add(x.reason);
				for (const s of x.species) e.species.add(s);
				byLoc.set(x.loc_code, e);
			}
			// Rows already dispatched (kept above) are left as they are.
			const kept = new Set(
				(await c.query<{ loc_code: string }>(`SELECT loc_code FROM taxonomy_refresh_locations WHERE run_id = $1`, [runId])).rows.map(
					(x) => x.loc_code
				)
			);
			const codes = [...byLoc.keys()].filter((code) => !kept.has(code)).sort();
			for (let i = 0; i < codes.length; i += 500) {
				const slice = codes.slice(i, i + 500);
				await c.query(
					`INSERT INTO taxonomy_refresh_locations (run_id, loc_code, loc_kind, loc_name, region_code, reasons, species_codes)
					 SELECT $1, f.loc_code, f.loc_kind, f.loc_name, f.region_code, x.reasons, x.species
					   FROM jsonb_to_recordset($2::jsonb) AS x(loc_code text, reasons text[], species text[])
					   JOIN frequency_fetch f ON f.loc_code = x.loc_code`,
					[
						runId,
						JSON.stringify(
							slice.map((code) => ({
								loc_code: code,
								reasons: [...byLoc.get(code)!.reasons].sort(),
								species: [...byLoc.get(code)!.species].sort()
							}))
						)
					]
				);
			}

			// The changes, with how many stored locations hold each one (any
			// change, not only those that need a reload).
			const held = await c.query<{ species_code: string; n: number }>(
				`SELECT species_code, count(DISTINCT loc_code)::int AS n FROM species_frequency
				  WHERE species_code = ANY($1::text[]) GROUP BY species_code`,
				[changes.map((ch) => ch.code)]
			);
			const perCode = new Map(held.rows.map((row) => [row.species_code, row.n]));
			for (let i = 0; i < changes.length; i += 500) {
				await c.query(
					`INSERT INTO taxonomy_changes (run_id, taxon_code, kinds, old_com_name, new_com_name, old_sci_name, new_sci_name,
					        old_category, new_category, old_report_as, new_report_as, affects, locations)
					 SELECT $1, x.code, x.kinds, x.oc, x.nc, x.os, x.ns, x.ocat, x.ncat, x.ora, x.nra, x.affects, x.locations
					   FROM jsonb_to_recordset($2::jsonb) AS x(code text, kinds text[], oc text, nc text, os text, ns text,
					        ocat text, ncat text, ora text, nra text, affects boolean, locations int)`,
					[
						runId,
						JSON.stringify(
							changes.slice(i, i + 500).map((ch) => ({
								code: ch.code,
								kinds: ch.kinds,
								oc: ch.before?.com_name ?? null,
								nc: ch.after?.com_name ?? null,
								os: ch.before?.sci_name ?? null,
								ns: ch.after?.sci_name ?? null,
								ocat: ch.before?.category ?? null,
								ncat: ch.after?.category ?? null,
								ora: ch.before?.report_as ?? null,
								nra: ch.after?.report_as ?? null,
								affects: ch.affects,
								locations: perCode.get(ch.code) ?? 0
							}))
						)
					]
				);
			}

			const totals = await c.query<{ total: number; regions: number; hotspots: number }>(
				`SELECT count(*)::int AS total, count(*) FILTER (WHERE loc_kind = 'region')::int AS regions,
				        count(*) FILTER (WHERE loc_kind = 'hotspot')::int AS hotspots
				   FROM taxonomy_refresh_locations WHERE run_id = $1`,
				[runId]
			);
			const reasonCounts = await c.query<{ reason: RefreshReason; n: number }>(
				`SELECT reason, count(*)::int AS n FROM taxonomy_refresh_locations, unnest(reasons) reason
				  WHERE run_id = $1 GROUP BY reason`,
				[runId]
			);
			const counts: RunCounts = {
				changes: Object.fromEntries(CHANGE_KINDS.map((k) => [k, changes.filter((ch) => ch.kinds.includes(k)).length])) as Record<
					ChangeKind,
					number
				>,
				locations: totals.rows[0],
				reasons: Object.fromEntries(REFRESH_REASONS.map((k) => [k, reasonCounts.rows.find((x) => x.reason === k)?.n ?? 0])) as Record<
					RefreshReason,
					number
				>,
				taxaBefore: before.length,
				taxaAfter: after.length
			};
			await c.query(
				`UPDATE taxonomy_runs SET stage = 'compared', compared_at = clock_timestamp(), counts = $2,
				        failed_stage = NULL, error = NULL WHERE id = $1`,
				[runId, JSON.stringify(counts)]
			);
			return counts;
		},
		{ where: 'taxonomy compare' }
	);
}

// ── refreshing the locations ───────────────────────────────────────────────

export const LOCATION_STATES = ['reloaded', 'queued', 'failed', 'unfinished', 'not_queued', 'removed'] as const;
export type LocationState = (typeof LOCATION_STATES)[number];

/**
 * A location's state, by precedence:
 *   removed     its stored data was deleted (nothing to reload)
 *   reloaded    loaded since the new taxonomy was applied
 *   queued      its batch job is pending or running
 *   failed      its last attempt since dispatch failed
 *   unfinished  dispatched, but its job ended without reaching it
 *   not_queued  never dispatched
 */
const STATE_SQL = `
	CASE
	  WHEN f.loc_code IS NULL THEN 'removed'
	  WHEN f.fetched_at > r.applied_at THEN 'reloaded'
	  WHEN l.dispatched_at IS NOT NULL AND j.status IN ('pending','running') THEN 'queued'
	  WHEN l.dispatched_at IS NOT NULL AND a.status = 'error' AND a.last_attempt_at > l.dispatched_at THEN 'failed'
	  WHEN l.dispatched_at IS NOT NULL THEN 'unfinished'
	  ELSE 'not_queued'
	END`;

const STATE_FROM = `
	  FROM taxonomy_refresh_locations l
	  JOIN taxonomy_runs r ON r.id = l.run_id
	  LEFT JOIN frequency_fetch f ON f.loc_code = l.loc_code
	  LEFT JOIN frequency_fetch_attempts a ON a.loc_code = l.loc_code
	  LEFT JOIN taxonomy_refresh_batches b ON b.run_id = l.run_id AND b.batch_no = l.batch_no
	  LEFT JOIN jobs j ON j.id = b.job_id`;

export interface RefreshProgress {
	counts: Record<LocationState, number>;
	total: number;
	/** Failed or unfinished, at most 50, with the last error. */
	problems: { loc_code: string; loc_name: string; state: LocationState; error: string | null }[];
	/** The newest failed batch job's error (a bad login stops a whole batch). */
	batchError: string | null;
}

export async function refreshProgress(runId: number): Promise<RefreshProgress> {
	const counts = await query<{ state: LocationState; n: number }>(
		`SELECT ${STATE_SQL} AS state, count(*)::int AS n ${STATE_FROM} WHERE l.run_id = $1 GROUP BY 1`,
		[runId]
	);
	const problems = await query<{ loc_code: string; loc_name: string; state: LocationState; error: string | null }>(
		`SELECT l.loc_code, l.loc_name, ${STATE_SQL} AS state,
		        CASE WHEN a.status = 'error' AND a.last_attempt_at > l.dispatched_at THEN a.error ELSE l.last_error END AS error
		   ${STATE_FROM}
		  WHERE l.run_id = $1 AND (${STATE_SQL}) IN ('failed','unfinished')
		  ORDER BY l.loc_code LIMIT 50`,
		[runId]
	);
	// Only a stopped batch that still holds locations to finish: once its
	// locations are queued again (a newer batch) or reloaded, it is history.
	const batch = await query<{ error: string | null }>(
		`SELECT j.error ${STATE_FROM}
		  WHERE l.run_id = $1 AND j.status IN ('failed','cancelled') AND j.error IS NOT NULL
		    AND (${STATE_SQL}) IN ('failed','unfinished')
		  ORDER BY j.finished_at DESC NULLS LAST LIMIT 1`,
		[runId]
	);
	const byState = Object.fromEntries(LOCATION_STATES.map((s) => [s, 0])) as Record<LocationState, number>;
	for (const row of counts.rows) byState[row.state] = row.n;
	return {
		counts: byState,
		total: counts.rows.reduce((n, row) => n + row.n, 0),
		problems: problems.rows,
		batchError: batch.rows[0]?.error ?? null
	};
}

export const REFRESH_BATCH_SIZE = 200;

/** Cut sorted locations into fixed batches. */
export function cutBatches<T>(items: readonly T[], size = REFRESH_BATCH_SIZE): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

/** The eBird account login the bar-chart reload uses (an API key alone is not enough). */
export async function hasEbirdLogin(userId: number): Promise<boolean> {
	const r = await query<{ ok: boolean }>(
		`SELECT (login_username_enc IS NOT NULL AND login_password_enc IS NOT NULL) AS ok FROM user_ebird WHERE user_id = $1`,
		[userId]
	);
	return r.rows[0]?.ok === true;
}

/**
 * Queue reloads for a run's locations: 'new' = never dispatched; 'unfinished'
 * = failed or unfinished with no active job. One transaction holding the run
 * row: each fixed batch is a refresh_loc job (force) plus its batch row and
 * its locations' dispatch, so a double click or a failure part way can never
 * queue a location twice or leave one half queued. The clicking admin is the
 * requester: their eBird login does the reloads.
 */
export async function dispatchRefresh(
	runId: number,
	adminId: number,
	mode: 'new' | 'unfinished'
): Promise<{ batches: number; locations: number }> {
	return withTransaction(async (c) => {
		const run = await c.query<{ stage: RunStage; superseded_by: number | null }>(
			`SELECT stage, superseded_by FROM taxonomy_runs WHERE id = $1 FOR UPDATE`,
			[runId]
		);
		const r = run.rows[0];
		if (!r) throw new TaxonomyRunError('Taxonomy run not found.');
		if (r.stage !== 'compared' && r.stage !== 'done') throw new TaxonomyRunError('This run has not finished comparing yet.');
		if (r.superseded_by) throw new TaxonomyRunError('A newer run carried these locations over; refresh from that run.');
		const want = mode === 'new' ? `('not_queued')` : `('failed','unfinished')`;
		const picked = await c.query<{ loc_code: string; loc_kind: string; loc_name: string; region_code: string | null; error: string | null }>(
			`SELECT l.loc_code, l.loc_kind, l.loc_name, l.region_code,
			        CASE WHEN a.status = 'error' THEN a.error ELSE l.last_error END AS error
			   ${STATE_FROM}
			  WHERE l.run_id = $1 AND (${STATE_SQL}) IN ${want}
			  ORDER BY l.loc_kind, l.loc_code`,
			[runId]
		);
		if (!picked.rows.length) return { batches: 0, locations: 0 };
		const last = await c.query<{ n: number | null }>(`SELECT max(batch_no) AS n FROM taxonomy_refresh_batches WHERE run_id = $1`, [runId]);
		let batchNo = Number(last.rows[0]?.n ?? 0);
		const batches = cutBatches(picked.rows);
		for (const batch of batches) {
			batchNo += 1;
			const jobId = await insertJobOn(c, {
				type: 'refresh_loc',
				payload: {
					locs: batch.map((l) => ({ code: l.loc_code, kind: l.loc_kind, name: l.loc_name, regionCode: l.region_code })),
					force: true
				},
				dedupKey: dedupKeys.taxonomyRefresh(runId, batchNo),
				requestedBy: adminId,
				label: `Taxonomy refresh: reload ${batch.length} locations (batch ${batchNo})`
			});
			await c.query(
				`INSERT INTO taxonomy_refresh_batches (run_id, batch_no, job_id, requested_by) VALUES ($1, $2, $3, $4)`,
				[runId, batchNo, jobId, adminId]
			);
			await c.query(
				`UPDATE taxonomy_refresh_locations AS l
				    SET batch_no = $2, dispatched_at = clock_timestamp(), last_error = x.error
				   FROM jsonb_to_recordset($3::jsonb) AS x(loc_code text, error text)
				  WHERE l.run_id = $1 AND l.loc_code = x.loc_code`,
				[runId, batchNo, JSON.stringify(batch.map((l) => ({ loc_code: l.loc_code, error: l.error })))]
			);
		}
		return { batches: batches.length, locations: picked.rows.length };
	});
}

// ── the admin card ─────────────────────────────────────────────────────────

export interface TaxonomyChangeRow {
	taxon_code: string;
	kinds: ChangeKind[];
	old_com_name: string | null;
	new_com_name: string | null;
	old_sci_name: string | null;
	new_sci_name: string | null;
	old_category: string | null;
	new_category: string | null;
	old_report_as: string | null;
	new_report_as: string | null;
	affects: boolean;
	locations: number;
}

export interface TaxonomyHistoryRow {
	id: number;
	created_at: string;
	stage: RunStage;
	failed_stage: string | null;
	target_version: string | null;
	counts: RunCounts | null;
	superseded_by: number | null;
	outstanding: number;
}

export interface TaxonomyBackupRow {
	id: number;
	taken_at: string;
	kind: 'before_sync' | 'after_sync';
	taxa: number;
	run_id: number;
	ebird_version: string | null;
}

export interface TaxonomyPanelData {
	current: { taxa: number; syncedAt: string | null; version: string | null };
	/** eBird's latest version; null when unknown. */
	latest: string | null;
	run: (TaxonomyRun & { changes: TaxonomyChangeRow[]; progress: RefreshProgress; jobActive: boolean }) | null;
	history: TaxonomyHistoryRow[];
	backups: TaxonomyBackupRow[];
	/** null when it could not be counted (never shown as zero). */
	orphans: { rows: number; users: number } | null;
	canSync: boolean;
	canRefresh: boolean;
}

/** Whether a run's job is pending or running. */
async function jobActive(jobId: number | null): Promise<boolean> {
	if (jobId == null) return false;
	const r = await query(`SELECT 1 FROM jobs WHERE id = $1 AND status IN ('pending','running')`, [jobId]);
	return (r.rowCount ?? 0) > 0;
}

/** Everything the card shows, for the chosen run (default: the newest). */
export async function taxonomyPanel(opts: {
	runId: number | null;
	latest: () => Promise<string | null>;
	canSync: boolean;
	canRefresh: boolean;
	orphans: () => Promise<{ rows: number; users: number }>;
}): Promise<TaxonomyPanelData> {
	const [current, ours, history, backups, latest, orphans] = await Promise.all([
		query<{ taxa: number; synced_at: string | null }>(
			`SELECT count(*)::int AS taxa, max(fetched_at)::text AS synced_at FROM taxonomy_cache`
		),
		query<{ v: string | null }>(
			`SELECT target_version AS v FROM taxonomy_runs WHERE stage IN ('compared','done') ORDER BY id DESC LIMIT 1`
		),
		query<TaxonomyHistoryRow>(
			`SELECT r.id, r.created_at::text, r.stage, r.failed_stage, r.target_version, r.counts, r.superseded_by,
			        (SELECT count(*)::int FROM taxonomy_refresh_locations l
			           LEFT JOIN frequency_fetch f ON f.loc_code = l.loc_code
			          WHERE l.run_id = r.id AND f.loc_code IS NOT NULL
			            AND (r.applied_at IS NULL OR f.fetched_at <= r.applied_at)) AS outstanding
			   FROM taxonomy_runs r ORDER BY r.id DESC`
		),
		query<TaxonomyBackupRow>(
			`SELECT id, taken_at::text, kind, taxa, run_id, ebird_version FROM taxonomy_backups ORDER BY taken_at DESC`
		),
		opts.latest().catch(() => null),
		opts.orphans().catch((err) => {
			console.error(`[taxonomy] life-list orphan count failed: ${err instanceof Error ? err.message : String(err)}`);
			return null;
		})
	]);
	const rows = history.rows.map((h) => ({ ...h, id: Number(h.id), superseded_by: idOrNull(h.superseded_by) }));
	const chosen = opts.runId ?? rows[0]?.id ?? null;
	let run: TaxonomyPanelData['run'] = null;
	const base = chosen == null ? null : await getRun(chosen);
	if (base) {
		const changes = await query<TaxonomyChangeRow>(
			`SELECT taxon_code, kinds, old_com_name, new_com_name, old_sci_name, new_sci_name, old_category, new_category,
			        old_report_as, new_report_as, affects, locations
			   FROM taxonomy_changes WHERE run_id = $1
			  ORDER BY affects DESC, locations DESC, coalesce(new_com_name, old_com_name), taxon_code`,
			[base.id]
		);
		run = { ...base, changes: changes.rows, progress: await refreshProgress(base.id), jobActive: await jobActive(base.job_id) };
	}
	return {
		current: { taxa: current.rows[0].taxa, syncedAt: current.rows[0].synced_at, version: ours.rows[0]?.v ?? null },
		latest,
		run,
		history: rows,
		backups: backups.rows.map((b) => ({ ...b, id: Number(b.id), run_id: Number(b.run_id) })),
		orphans,
		canSync: opts.canSync,
		canRefresh: opts.canRefresh
	};
}

/** What the card polls while a run or its reloads are under way. */
export async function taxonomyLiveStatus(runId: number): Promise<{
	stage: RunStage;
	failed_stage: string | null;
	error: string | null;
	jobActive: boolean;
	progress: RefreshProgress;
} | null> {
	const run = await getRun(runId);
	if (!run) return null;
	return {
		stage: run.stage,
		failed_stage: run.failed_stage,
		error: run.error,
		jobActive: await jobActive(run.job_id),
		progress: await refreshProgress(runId)
	};
}

/**
 * td-493c58: the taxonomy refresh re-matches external sources, against
 * birds_test.
 *
 * Fixture ownership (docs/agent-development-guide.md §3): the source
 * `xt-<tag>` (active) with its load, places, taxa, monthly rows, records and
 * recent reports; species `xt<tag><n>` in taxonomy_cache (names "Zz<tag> …",
 * which nothing real has); this file's runs, backups and jobs. Everything is
 * deleted by those exact ids. Only this file's source is ever re-matched.
 *
 * The story, eBird before → after the sync:
 *   T1 "Zz… olim"     genus move: was species A, A is now "Zz… novus"   → kept by former name
 *   T2 "Zz… alpha"    split: was B (now a slash), the name is now C      → moved B → C
 *   T7 "Zz… alpha"    the same name under another upstream id           → moved B → C
 *   T3 "Zz… gone"     its species D was removed                          → lost
 *   T4 "Zz… nuper"    unmatched before, a species has the name now (E)   → gained
 *   T5 "Zz… idem"     unchanged (F)                                      → not listed
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { query, withTransaction } from '$lib/db';
import type { JobRow } from '$server/job-policy';
import { requeueInterrupted, runWithClaim, StaleClaimError } from './jobs';
import { rematchSource } from './external-sources/admin';
import { getRun, rematchSourcesNow, runTaxonomyRun, TaxonomyRunError, type RunDeps } from './taxonomy-refresh';
import { copySourceBaselines, rematchSourcesForRun, sourceChanges, sourceSummaries } from './taxonomy-sources';

const dbUp = await query('SELECT 1')
	.then(() => true)
	.catch(() => false);

const tag = randomUUID().replaceAll('-', '').slice(0, 6).toLowerCase();
const SRC = `xt-${tag}`;
// A second source (one taxon), for a partial re-match; it sorts after SRC.
const SRC2 = `xt2-${tag}`;
const R = 'NO-18';
const code = (n: string) => `xt${tag}${n}`;
const [A, B, C, D, E, F] = ['a', 'b', 'c', 'd', 'e', 'f'].map(code);
const NAME = (w: string) => `Zz${tag} ${w}`;
const LABEL = `TAXSRCTEST ${tag}`;
const runIds: number[] = [];
const jobIds: number[] = [];
let adminId = 0;
let loadId = '';

/** The matches as they stood before the sync (what the baseline must hold). */
const BEFORE = [
	{ id: '1', name: NAME('olim'), code: A, reason: 'scientific' },
	{ id: '2', name: NAME('alpha'), code: B, reason: 'scientific' },
	{ id: '7', name: NAME('alpha'), code: B, reason: 'scientific' },
	{ id: '3', name: NAME('gone'), code: D, reason: 'scientific' },
	{ id: '4', name: NAME('nuper'), code: null, reason: 'no_match' },
	{ id: '5', name: NAME('idem'), code: F, reason: 'scientific' }
];

async function resetTaxa() {
	for (const t of BEFORE) {
		await query(
			`UPDATE external_taxa SET species_code = $3, match_reason = $4 WHERE source_id = $1 AND upstream_taxon_id = $2`,
			[SRC, t.id, t.code, t.reason]
		);
	}
}

async function taxaNow() {
	const r = await query<{ upstream_taxon_id: string; species_code: string | null; match_reason: string }>(
		`SELECT upstream_taxon_id, species_code, match_reason FROM external_taxa WHERE source_id = $1 ORDER BY upstream_taxon_id`,
		[SRC]
	);
	return Object.fromEntries(r.rows.map((t) => [t.upstream_taxon_id, [t.species_code, t.match_reason]]));
}

/** A done run whose before-sync backup holds eBird's former names. */
async function newRun(stage = 'done') {
	const run = await query<{ id: string }>(
		`INSERT INTO taxonomy_runs (requested_by, actor_label, stage) VALUES ($1, $2, $3) RETURNING id`,
		[adminId, LABEL, stage]
	);
	const id = Number(run.rows[0].id);
	runIds.push(id);
	const b = await query<{ id: string }>(
		`INSERT INTO taxonomy_backups (run_id, kind, taxa) VALUES ($1, 'before_sync', 5) RETURNING id`,
		[id]
	);
	const rows: [string, string, string, string][] = [
		[A, NAME('olim'), 'species', 'Fixture olim'],
		[B, NAME('alpha'), 'species', 'Fixture alpha'],
		[D, NAME('gone'), 'species', 'Fixture gone'],
		[F, NAME('idem'), 'species', 'Fixture idem']
	];
	for (const [c, sci, cat, com] of rows) {
		await query(
			`INSERT INTO taxonomy_backup_rows (backup_id, species_code, com_name, sci_name, category) VALUES ($1, $2, $3, $4, $5)`,
			[b.rows[0].id, c, com, sci, cat]
		);
	}
	await query(`UPDATE taxonomy_runs SET before_id = $2 WHERE id = $1`, [id, b.rows[0].id]);
	return id;
}

async function baseline(runId: number) {
	await withTransaction((c) => copySourceBaselines(c, runId, 'before_sync', [SRC]));
}

async function cleanRuns() {
	if (!runIds.length) return;
	await query(`UPDATE taxonomy_runs SET before_id = NULL, after_id = NULL WHERE id = ANY($1)`, [runIds]);
	await query(`DELETE FROM taxonomy_backups WHERE run_id = ANY($1)`, [runIds]);
	await query(`DELETE FROM taxonomy_runs WHERE id = ANY($1)`, [runIds]);
	runIds.length = 0;
}

describe.skipIf(!dbUp)('taxonomy refresh re-matches external sources (td-493c58)', () => {
	beforeAll(async () => {
		adminId = (
			await query<{ id: number }>(
				`INSERT INTO users (username, display_name, password_hash, role) VALUES ($1, 'Source fixture', '!unset', 'admin') RETURNING id`,
				[`taxsrctest-${tag}`]
			)
		).rows[0].id;
		await query(
			`INSERT INTO taxonomy_cache (species_code, com_name, sci_name, category, taxon_order) VALUES
			   ($1, 'Fixture novus', $6, 'species', -16), ($2, 'Fixture alpha/beta', $7, 'slash', -15),
			   ($3, 'Fixture alpha', $8, 'species', -14), ($4, 'Fixture nuper', $9, 'species', -13),
			   ($5, 'Fixture idem', $10, 'species', -12)`,
			[A, B, C, E, F, NAME('novus'), NAME('alpha/beta'), NAME('alpha'), NAME('nuper'), NAME('idem')]
		);
		await query(
			`INSERT INTO external_sources (id, name, publisher, license, license_url, citation, attribution, record_semantics,
			                               homepage, covers_country, geo_scheme, window_months, store_observers, active)
			 VALUES ($1, $2, 'Test publisher', 'CC BY 4.0', 'https://creativecommons.org/licenses/by/4.0/', 'Test citation',
			         'Test attribution', 'reports', 'https://example.org/', 'NO', 'TEST', 24, false, true)`,
			[SRC, `Source fixture ${tag}`]
		);
		await query(`INSERT INTO external_region_map (source_id, upstream_key, region_code) VALUES ($1, '18', $2)`, [SRC, R]);
		await query(
			`INSERT INTO external_sources (id, name, publisher, license, license_url, citation, attribution, record_semantics,
			                               homepage, covers_country, geo_scheme, window_months, store_observers, active)
			 SELECT $2, $3, publisher, license, license_url, citation, attribution, record_semantics, homepage, covers_country,
			        geo_scheme, window_months, store_observers, active FROM external_sources WHERE id = $1`,
			[SRC, SRC2, `Source fixture 2 ${tag}`]
		);
		await query(`INSERT INTO external_region_map (source_id, upstream_key, region_code) VALUES ($1, '18', $2)`, [SRC2, R]);
		loadId = (
			await query<{ id: string }>(
				`INSERT INTO external_loads (source_id, region_code, status, max_attempts, window_months, window_start, window_end,
				                             retrieved_at, finished_at)
				 VALUES ($1, $2, 'done', 3, 24, '2024-10-01', '2026-09-30', now(), now()) RETURNING id`,
				[SRC, R]
			)
		).rows[0].id;
		await query(
			`INSERT INTO external_places (source_id, region_code, place_key, name, level, parent_key, load_id)
			 VALUES ($1, $2, $2, $2, 'region', NULL, $3)`,
			[SRC, R, loadId]
		);
		for (const p of ['p1', 'p2', 'p3', 'p4']) {
			await query(
				`INSERT INTO external_places (source_id, region_code, place_key, name, level, parent_key, load_id)
				 VALUES ($1, $2, $4, $5, 'subregion', $2, $3)`,
				[SRC, R, loadId, `${R}:${p}`, p]
			);
		}
		for (const t of BEFORE) {
			await query(
				`INSERT INTO external_taxa (source_id, upstream_taxon_id, canonical_name, raw_name, rank, species_code, match_reason, load_id)
				 VALUES ($1, $2, $3, $3, 'SPECIES', $4, $5, $6)`,
				[SRC, t.id, t.name, t.code, t.reason, loadId]
			);
		}
		await query(
			`INSERT INTO external_taxa (source_id, upstream_taxon_id, canonical_name, raw_name, rank, species_code, match_reason, load_id)
			 VALUES ($1, '9', $2, $2, 'OTHER', NULL, 'not_species', $3)`,
			[SRC, `Zz${tag}`, loadId]
		);
		const load2 = (
			await query<{ id: string }>(
				`INSERT INTO external_loads (source_id, region_code, status, max_attempts, window_months, window_start, window_end,
				                             retrieved_at, finished_at)
				 VALUES ($1, $2, 'done', 3, 24, '2024-10-01', '2026-09-30', now(), now()) RETURNING id`,
				[SRC2, R]
			)
		).rows[0].id;
		await query(
			`INSERT INTO external_places (source_id, region_code, place_key, name, level, parent_key, load_id) VALUES ($1, $2, $2, $2, 'region', NULL, $3)`,
			[SRC2, R, load2]
		);
		await query(
			`INSERT INTO external_taxa (source_id, upstream_taxon_id, canonical_name, raw_name, rank, species_code, match_reason, load_id)
			 VALUES ($1, '1', $2, $2, 'SPECIES', $3, 'scientific', $4)`,
			[SRC2, NAME('olim'), A, load2]
		);
		// Monthly counts: T2 and T3 (lost) at the region row too, as a real load has; T7 nowhere monthly.
		const month = async (id: string, name: string, place: string) =>
			query(
				`INSERT INTO external_taxon_month (source_id, region_code, place_key, upstream_taxon_id, month, canonical_name, raw_name, reports, load_id)
				 VALUES ($1, $2, $3, $4, 6, $5, $5, 3, $6)`,
				[SRC, R, place, id, name, loadId]
			);
		await month('2', NAME('alpha'), R);
		await month('2', NAME('alpha'), `${R}:p1`);
		await month('2', NAME('alpha'), `${R}:p2`);
		await month('3', NAME('gone'), R);
		await month('3', NAME('gone'), `${R}:p1`);
		await month('1', NAME('olim'), `${R}:p2`);
		await month('5', NAME('idem'), `${R}:p2`);
		// Records: T2 also at p3; T7 only at p4.
		const rec = async (id: string, name: string, place: string, n: number) =>
			query(
				`INSERT INTO external_records (source_id, region_code, upstream_record_id, place_key, upstream_taxon_id, canonical_name,
				                               observed_on, locality, lat, lon, uncertainty_m, observers, behaviour, load_id)
				 VALUES ($1, $2, $3, $4, $5, $6, '2026-06-01', 'Fixture', NULL, NULL, NULL, '{}', '{}', $7)`,
				[SRC, R, `rec-${tag}-${n}`, place, id, name, loadId]
			);
		await rec('2', NAME('alpha'), `${R}:p3`, 1);
		await rec('7', NAME('alpha'), `${R}:p4`, 2);
		// A recent report of T2 at p1 (already counted) carries the old code.
		await query(
			`INSERT INTO external_recent_reports (source_id, region_code, upstream_record_id, place_key, upstream_taxon_id, canonical_name,
			                                      species_code, observed_on, locality, generalized, record_url, load_id)
			 VALUES ($1, $2, $3, $4, '2', $5, $6, '2026-10-20', 'Fixture', false, 'https://example.org/r', $7)`,
			[SRC, R, `recent-${tag}`, `${R}:p1`, NAME('alpha'), B, loadId]
		);
	});

	afterEach(async () => {
		await cleanRuns();
		await resetTaxa();
		await query(`UPDATE external_taxa SET species_code = $2, match_reason = 'scientific' WHERE source_id = $1`, [SRC2, A]);
		if (jobIds.length) {
			await query(`DELETE FROM job_events WHERE job_id = ANY($1)`, [jobIds]);
			await query(`DELETE FROM jobs WHERE id = ANY($1)`, [jobIds]);
			jobIds.length = 0;
		}
	});

	afterAll(async () => {
		await cleanRuns();
		for (const t of [
			'external_recent_reports',
			'external_records',
			'external_place_month_species',
			'external_taxon_month',
			'external_unmatched',
			'external_taxa',
			'external_places',
			'external_loads',
			'external_region_map'
		]) {
			await query(`DELETE FROM ${t} WHERE source_id = ANY($1::text[])`, [[SRC, SRC2]]);
		}
		await query(`DELETE FROM external_sources WHERE id = ANY($1::text[])`, [[SRC, SRC2]]);
		await query(`DELETE FROM taxonomy_cache WHERE species_code = ANY($1::text[])`, [[A, B, C, D, E, F]]);
		await query(`DELETE FROM users WHERE id = $1`, [adminId]);
		const left = await query<{ n: number }>(
			`SELECT (SELECT count(*) FROM external_taxa WHERE source_id = $1) + (SELECT count(*) FROM taxonomy_cache WHERE species_code = ANY($2::text[]))::int AS n`,
			[SRC, [A, B, C, D, E, F]]
		);
		expect(Number(left.rows[0].n)).toBe(0);
	});

	it('re-matches against the baseline: moved, lost, gained and kept by former name, with each pair’s own places', async () => {
		const runId = await newRun();
		await baseline(runId);
		const [summary] = await rematchSourcesForRun(runId, { sources: [SRC] });
		expect(summary).toMatchObject({ sourceId: SRC, baselineKind: 'before_sync', moved: 2, lost: 1, gained: 1, keptFormer: 1 });
		expect(summary.rematchedAt).not.toBeNull();
		expect(await taxaNow()).toEqual({
			'1': [A, 'former_name'],
			'2': [C, 'scientific'],
			'3': [null, 'no_match'],
			'4': [E, 'scientific'],
			'5': [F, 'scientific'],
			'7': [C, 'scientific'],
			'9': [null, 'not_species']
		});
		const changes = (await sourceChanges(runId)).map((c) => [c.upstream_taxon_id, c.old_code, c.new_code, c.places]);
		// Lost first, then moved (by places), then the rest; places never count the region row or another taxon's.
		expect(changes).toEqual([
			['3', D, null, 1],
			['2', B, C, 3],
			['7', B, C, 1],
			['4', null, E, 0],
			['1', A, A, 1]
		]);
		// Names: the old one from the run's before-sync backup, the new one from today.
		const moved = (await sourceChanges(runId)).find((c) => c.upstream_taxon_id === '2')!;
		expect([moved.old_com_name, moved.new_com_name]).toEqual(['Fixture alpha', 'Fixture alpha']);
		const lost = (await sourceChanges(runId)).find((c) => c.upstream_taxon_id === '3')!;
		expect(lost.old_com_name).toBe('Fixture gone');
		// The derived rows follow: monthly species rows and the recent report's code.
		const derived = await query<{ species_code: string; n: number }>(
			`SELECT species_code, count(*)::int AS n FROM external_place_month_species WHERE source_id = $1 GROUP BY 1 ORDER BY 1`,
			[SRC]
		);
		expect(derived.rows.map((r) => r.species_code)).toEqual([A, C, F].sort());
		const recent = await query<{ species_code: string }>(`SELECT species_code FROM external_recent_reports WHERE source_id = $1`, [SRC]);
		expect(recent.rows).toEqual([{ species_code: C }]);
		const unmatched = await query<{ upstream_taxon_id: string; reason: string }>(
			`SELECT upstream_taxon_id, reason FROM external_unmatched WHERE source_id = $1`,
			[SRC]
		);
		expect(unmatched.rows).toEqual([{ upstream_taxon_id: '3', reason: 'no_match' }]);
	});

	it('records the same diff on a replay, and when a Sources-tab re-match got there first', async () => {
		const runId = await newRun();
		await baseline(runId);
		// Admin → Sources "Re-match species" (or a connector publish) lands before the run's finish.
		await rematchSource(SRC);
		const first = await rematchSourcesForRun(runId, { sources: [SRC] });
		const rows = await sourceChanges(runId);
		const again = await rematchSourcesForRun(runId, { sources: [SRC] });
		expect(first[0]).toMatchObject({ moved: 2, lost: 1, gained: 1, keptFormer: 1 });
		expect(again[0]).toMatchObject({ moved: 2, lost: 1, gained: 1, keptFormer: 1 });
		expect(await sourceChanges(runId)).toEqual(rows);
	});

	it('takes the baseline just before the re-match when a run has none, and says so', async () => {
		const runId = await newRun();
		const [s] = await rematchSourcesForRun(runId, { sources: [SRC] });
		// Taken from the pre-sync matches still in place, so the changes show; the card names the baseline.
		expect(s).toMatchObject({ baselineKind: 'before_rematch', moved: 2, lost: 1, gained: 1, keptFormer: 1 });
		// A second run after that re-match: its own fresh baseline already holds today's matches.
		await query(`UPDATE taxonomy_runs SET stage = 'done' WHERE id = $1`, [runId]);
		const later = await newRun();
		const [t] = await rematchSourcesForRun(later, { sources: [SRC] });
		expect(t).toMatchObject({ baselineKind: 'before_rematch', moved: 0, lost: 0, gained: 0, keptFormer: 0 });
		expect(await sourceChanges(later)).toEqual([]);
	});

	it('Re-match sources: only the newest run, once done; never an older one', async () => {
		const older = await newRun();
		const unfinished = await newRun('compared');
		await expect(rematchSourcesNow(older, [SRC])).rejects.toThrow(TaxonomyRunError);
		await expect(rematchSourcesNow(unfinished, [SRC])).rejects.toThrow(/has not finished/);
		await query(`UPDATE taxonomy_runs SET stage = 'done' WHERE id = $1`, [unfinished]);
		await expect(rematchSourcesNow(older, [SRC])).rejects.toThrow(/newer taxonomy run/);
		const [s] = await rematchSourcesNow(unfinished, [SRC]);
		expect(s).toMatchObject({ sourceId: SRC, moved: 2 });
		// The refused run recorded nothing and changed nothing.
		expect(await sourceSummaries(older)).toEqual([]);
	});

	it('the run copies the baseline with its before-sync backup and re-matches before it is done', async () => {
		const run = await query<{ id: string }>(
			`INSERT INTO taxonomy_runs (requested_by, actor_label) VALUES ($1, $2) RETURNING id`,
			[adminId, LABEL]
		);
		const id = Number(run.rows[0].id);
		runIds.push(id);
		const job = { id: 0, requested_by: adminId, payload: { runId: id } } as unknown as JobRow;
		const deps = (over: Partial<RunDeps> = {}): RunDeps => ({
			apiKey: async () => {
				throw new Error('stop after the backup');
			},
			fetchTaxonomy: async () => [],
			latestVersion: async () => null,
			replace: async () => 0,
			finish: async () => ({ finished: true }),
			matcher: async () => ({ match: () => null }),
			earlierRuns: [id],
			sources: [SRC],
			...over
		});
		await expect(runTaxonomyRun(job, deps())).rejects.toThrow(/stop after the backup/);
		expect(await getRun(id)).toMatchObject({ stage: 'backed_up' });
		const base = await query<{ upstream_taxon_id: string; species_code: string | null }>(
			`SELECT upstream_taxon_id, species_code FROM taxonomy_source_baseline WHERE run_id = $1 ORDER BY upstream_taxon_id`,
			[id]
		);
		// Species-level taxa only (the genus is never matched), as they were before the sync.
		expect(base.rows).toEqual(BEFORE.map((t) => ({ upstream_taxon_id: t.id, species_code: t.code })).sort((x, y) => x.upstream_taxon_id.localeCompare(y.upstream_taxon_id)));
		// The run's backup copied today's fixture taxonomy; make it the "before" this story needs
		// (A under its former name, B still a species, D not yet removed). Only this run's own backup is touched.
		const before = (await getRun(id))!.before_id!;
		await query(`UPDATE taxonomy_backup_rows SET sci_name = $3 WHERE backup_id = $1 AND species_code = $2`, [before, A, NAME('olim')]);
		await query(`UPDATE taxonomy_backup_rows SET category = 'species', sci_name = $3 WHERE backup_id = $1 AND species_code = $2`, [
			before,
			B,
			NAME('alpha')
		]);
		await query(
			`INSERT INTO taxonomy_backup_rows (backup_id, species_code, com_name, sci_name, category) VALUES ($1, $2, 'Fixture gone', $3, 'species')`,
			[before, D, NAME('gone')]
		);
		// Skip ahead to compared: the rest of the run is taxonomy-refresh-db.test.ts's.
		await query(`UPDATE taxonomy_runs SET stage = 'compared', failed_stage = NULL, error = NULL WHERE id = $1`, [id]);
		const order: string[] = [];
		const result = await runTaxonomyRun(
			job,
			deps({
				finish: async () => {
					const [s] = await sourceSummaries(id);
					order.push(s?.rematchedAt ? 'finish after re-match' : 'finish before re-match');
					return { finished: true };
				}
			})
		);
		expect(order).toEqual(['finish after re-match']);
		expect(result).toMatchObject({ stage: 'done', finished: true, sources: { [SRC]: { moved: 2, lost: 1, gained: 1, keptFormer: 1 } } });
		expect(await sourceSummaries(id)).toMatchObject([{ baselineKind: 'before_sync' }]);
	});

	it('writes nothing for a stale execution of the finish', async () => {
		const runId = await newRun('compared');
		await baseline(runId);
		const jobId = (
			await query<{ id: number }>(
				`INSERT INTO jobs (type, payload, requested_by, label, max_attempts) VALUES ('tag_preview', $1, $2, $3, 3) RETURNING id`,
				[JSON.stringify({ runId }), adminId, LABEL]
			)
		).rows[0].id;
		jobIds.push(jobId);
		const claim = async () =>
			(
				await query<JobRow>(
					`UPDATE jobs SET status = 'running', started_at = NOW(), attempts = attempts + 1, heartbeat_at = NOW(),
					        claim_seq = claim_seq + 1 WHERE id = $1 AND status = 'pending' RETURNING *`,
					[jobId]
				)
			).rows[0];
		const a = await claim();
		await runWithClaim(a, () => requeueInterrupted(jobId, a.attempts));
		await claim();
		await expect(runWithClaim(a, () => rematchSourcesForRun(runId, { sources: [SRC] }))).rejects.toThrow(StaleClaimError);
		expect(await taxaNow()).toMatchObject({ '1': [A, 'scientific'], '2': [B, 'scientific'], '3': [D, 'scientific'] });
		expect(await sourceSummaries(runId)).toMatchObject([{ rematchedAt: null, moved: 0 }]);
		expect(await sourceChanges(runId)).toEqual([]);
	});

	it('a source that fails leaves the earlier ones recorded; a retry records them all', async () => {
		const runId = await newRun();
		await withTransaction((c) => copySourceBaselines(c, runId, 'before_sync', [SRC, SRC2]));
		let calls = 0;
		const failSecond = async () => {
			if (++calls === 2) throw new Error('second source failed');
		};
		await expect(rematchSourcesForRun(runId, { sources: [SRC, SRC2], guard: failSecond })).rejects.toThrow(/second source failed/);
		const partial = await sourceSummaries(runId);
		expect(Object.fromEntries(partial.map((s) => [s.sourceId, s.rematchedAt !== null]))).toEqual({ [SRC]: true, [SRC2]: false });
		// The failed source's rows rolled back with its transaction: still as before.
		const second = await query<{ species_code: string; match_reason: string }>(`SELECT species_code, match_reason FROM external_taxa WHERE source_id = $1`, [SRC2]);
		expect(second.rows).toEqual([{ species_code: A, match_reason: 'scientific' }]);
		const all = await rematchSourcesForRun(runId, { sources: [SRC, SRC2] });
		const by = Object.fromEntries(all.map((s) => [s.sourceId, s]));
		expect(by[SRC]).toMatchObject({ moved: 2, lost: 1, gained: 1, keptFormer: 1 });
		expect(by[SRC2]).toMatchObject({ moved: 0, lost: 0, gained: 0, keptFormer: 1 });
	});

	it('Re-match sources waits for a run being admitted, then refuses the older run', async () => {
		const older = await newRun();
		// startOrResumeRun admitting a new run: it holds the admission lock until it commits.
		let release!: () => void;
		const commit = new Promise<void>((r) => (release = r));
		let locked!: () => void;
		const holding = new Promise<void>((r) => (locked = r));
		const admitting = withTransaction(async (c) => {
			await c.query(`SELECT pg_advisory_xact_lock(hashtext('taxonomy-run-admission'))`);
			const newer = await c.query<{ id: string }>(
				`INSERT INTO taxonomy_runs (requested_by, actor_label, stage) VALUES ($1, $2, 'done') RETURNING id`,
				[adminId, LABEL]
			);
			runIds.push(Number(newer.rows[0].id));
			locked();
			await commit;
		});
		await holding;
		let settled = false;
		const attempt = rematchSourcesNow(older, [SRC]).finally(() => (settled = true));
		attempt.catch(() => {});
		await new Promise((r) => setTimeout(r, 400));
		expect(settled, 'waits while a run is being admitted').toBe(false);
		release();
		await admitting;
		await expect(attempt).rejects.toThrow(/newer taxonomy run/);
		expect(await sourceSummaries(older)).toEqual([]);
		expect(await taxaNow()).toMatchObject({ '1': [A, 'scientific'], '2': [B, 'scientific'] });
	});

	it("names a change's species as the run saw them, not as a later taxonomy does", async () => {
		const runId = await newRun();
		await baseline(runId);
		const after = await query<{ id: string }>(
			`INSERT INTO taxonomy_backups (run_id, kind, taxa) VALUES ($1, 'after_sync', 1) RETURNING id`,
			[runId]
		);
		await query(
			`INSERT INTO taxonomy_backup_rows (backup_id, species_code, com_name, sci_name, category) VALUES ($1, $2, 'Fixture alpha (as the run saw it)', $3, 'species')`,
			[after.rows[0].id, C, NAME('alpha')]
		);
		await query(`UPDATE taxonomy_runs SET after_id = $2 WHERE id = $1`, [runId, after.rows[0].id]);
		await rematchSourcesForRun(runId, { sources: [SRC] });
		const moved = (await sourceChanges(runId)).find((c) => c.upstream_taxon_id === '2')!;
		expect(moved.new_com_name).toBe('Fixture alpha (as the run saw it)');
		// A code the run's backup lacks falls back to today's name.
		const gained = (await sourceChanges(runId)).find((c) => c.upstream_taxon_id === '4')!;
		expect(gained.new_com_name).toBe('Fixture nuper');
	});

	it('cascades away with its run', async () => {
		const runId = await newRun();
		await baseline(runId);
		await rematchSourcesForRun(runId, { sources: [SRC] });
		await cleanRuns();
		const left = await query<{ n: number }>(
			`SELECT (SELECT count(*) FROM taxonomy_source_rematches WHERE run_id = $1)
			      + (SELECT count(*) FROM taxonomy_source_baseline WHERE run_id = $1)
			      + (SELECT count(*) FROM taxonomy_source_changes WHERE run_id = $1) AS n`,
			[runId]
		);
		expect(Number(left.rows[0].n)).toBe(0);
	});
});

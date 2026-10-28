/**
 * External sources, Phase 3 (td-6895f6): the read side the Norway cards use,
 * and the "Load reports" form action, against birds_test.
 *
 * Fixture ownership (docs/agent-development-guide.md §3): three sources
 * `xr-<run>` (stores observers), `xro-<run>` (does not) and `xri-<run>`
 * (switched off), their region map rows, loads and published rows, two
 * fake species codes and one user `xr-<run>`. Regions (NO-18…NO-20) are only
 * READ. Other sources (the real `artsobs`, other runs) may also cover these
 * regions, so every assertion picks this run's source by id. Cleanup deletes
 * by those exact ids.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadTestEnv, requireTestDb } from '$server/testing/test-env';
import { query, withReadSnapshot } from '$lib/db';
import {
	_readOverview,
	_readSpeciesInRegion,
	externalLoadStates,
	externalOverview,
	externalSourcesForRegion,
	externalSpeciesInRegion,
	externalSpeciesSummary
} from './reports';
import * as loadStateRoute from '../../../routes/api/external/load-state/+server';
import { queueExternalLoadAction } from './queue-action';

loadTestEnv();
await requireTestDb(query);

const RUN = `${process.pid.toString(36)}${Date.now().toString(36).slice(-5)}`;
const SRC = `xr-${RUN}`;
const SRC_OFF = `xro-${RUN}`;
const SRC_INACTIVE = `xri-${RUN}`;
const SOURCES = [SRC, SRC_OFF, SRC_INACTIVE];
const SP = `xr-${RUN}`;
const SP_NONE = `xrn-${RUN}`;
const R = 'NO-18';
const P = (name: string) => `${R}:${name}`;

let userId = 0;
const loads: Record<string, string> = {};

async function addSource(id: string, opts: { observers: boolean; active: boolean }) {
	await query(
		`INSERT INTO external_sources (id, name, publisher, license, license_url, citation, attribution, record_semantics,
		                               homepage, covers_country, geo_scheme, window_months, store_observers, active,
		                               region_link_template)
		 VALUES ($1, $2, 'Test publisher', 'CC BY 4.0', 'https://creativecommons.org/licenses/by/4.0/', 'Test citation',
		         'Test attribution', 'reports', 'https://example.org/', 'NO', 'TEST', 24, $3, $4,
		         'https://example.org/area/{upstream_key}')`,
		[id, `Test ${id}`, opts.observers, opts.active]
	);
}

async function addLoad(source: string, region: string, status: string, extra: { failedAgo?: string } = {}) {
	const r = await query<{ id: string }>(
		`INSERT INTO external_loads (source_id, region_code, requested_by, status, max_attempts, window_months,
		                             window_start, window_end, retrieved_at, finished_at, error, progress,
		                             lease_token, lease_expires_at)
		 VALUES ($1, $2, $3, $4, 3, 24,
		         CASE WHEN $4 = 'done' THEN DATE '2024-10-01' END, CASE WHEN $4 = 'done' THEN DATE '2026-09-30' END,
		         CASE WHEN $4 = 'done' THEN now() - interval '1 hour' END,
		         CASE WHEN $4 = 'done' THEN now() - interval '1 hour'
		              WHEN $4 = 'failed' THEN now() - $5::interval END,
		         CASE WHEN $4 = 'failed' THEN 'Artskart answered 503' END,
		         CASE WHEN $4 = 'leased' THEN '{"phase":"fetching","done":4,"total":30}'::jsonb END,
		         CASE WHEN $4 = 'leased' THEN gen_random_uuid() END,
		         CASE WHEN $4 = 'leased' THEN now() + interval '10 minutes' END)
		 RETURNING id`,
		[source, region, userId, status, extra.failedAgo ?? '0 minutes']
	);
	return r.rows[0].id;
}

async function publish(source: string, load: string) {
	await query(
		`INSERT INTO external_places (source_id, region_code, place_key, name, level, parent_key, load_id) VALUES
		   ($1, $3, $3, 'Nordland', 'region', NULL, $2),
		   ($1, $3, $4, 'Bodø', 'subregion', $3, $2),
		   ($1, $3, $5, 'Nesna', 'subregion', $3, $2),
		   ($1, $3, $6, 'Vefsn', 'subregion', $3, $2)`,
		[source, load, R, P('Bodø'), P('Nesna'), P('Vefsn')]
	);
	// All birds in the county: 2,000 in May, 1,000 in June, nothing in January.
	await query(
		`INSERT INTO external_place_month_totals (source_id, region_code, place_key, month, reports, unkeyed, load_id)
		 VALUES ($1, $3, $3, 5, 2000, 3, $2), ($1, $3, $3, 6, 1000, 1, $2)`,
		[source, load, R]
	);
	// The species: 80 in May (all Vefsn), 50 in June (Bodø 30, Nesna 20).
	await query(
		`INSERT INTO external_place_month_species (source_id, region_code, place_key, species_code, month, reports, load_id) VALUES
		   ($1, $3, $3, $4, 5, 80, $2), ($1, $3, $3, $4, 6, 50, $2),
		   ($1, $3, $5, $4, 5, 80, $2), ($1, $3, $6, $4, 6, 30, $2), ($1, $3, $7, $4, 6, 20, $2),
		   ($1, $3, $3, $8, 7, 0, $2),
		   ($1, $3, $3, $4, 8, 7, $2)`,
		[source, load, R, SP, P('Vefsn'), P('Bodø'), P('Nesna'), SP_NONE]
	);
	await query(
		`INSERT INTO external_recent_reports (source_id, region_code, upstream_record_id, place_key, upstream_taxon_id,
		                                      canonical_name, species_code, observed_on, count, locality, lat, lon,
		                                      uncertainty_m, generalized, record_url, observer, load_id) VALUES
		   ($1, $3, 'r1', $4, 't1', 'Testus testus', $5, DATE '2026-10-20', 3, 'Skogsøy', 66.2, 13.0, 100, false,
		    'https://example.org/sighting/1', 'Observer A, Observer B', $2),
		   ($1, $3, 'r2', $4, 't1', 'Testus testus', $5, DATE '2026-10-22', NULL, 'Hidden place', 66.3, 13.1, 100, true,
		    'https://example.org/sighting/2', 'Observer A', $2),
		   ($1, $3, 'r3', $3, 't1', 'Testus testus', $5, DATE '2026-10-21', 1, 'Far fjell', 66.4, 13.2, 5000, false,
		    'https://example.org/sighting/3', NULL, $2)`,
		[source, load, R, P('Bodø'), SP]
	);
	await query(
		`INSERT INTO external_top_observers (source_id, region_code, place_key, rank, observer, days, species, localities, reports, load_id)
		 VALUES ($1, $3, $3, 1, 'Observer A', 300, 200, 40, 9000, $2), ($1, $3, $3, 2, 'Observer B', 120, 150, 12, 2500, $2)`,
		[source, load, R]
	);
}

async function cleanup() {
	for (const table of [
		'external_top_observers',
		'external_recent_reports',
		'external_top_localities',
		'external_place_month_species',
		'external_taxon_month',
		'external_place_month_totals',
		'external_unmatched',
		'external_places'
	]) {
		await query(`DELETE FROM ${table} WHERE source_id = ANY($1::text[])`, [SOURCES]);
	}
	await query(`DELETE FROM external_loads WHERE source_id = ANY($1::text[])`, [SOURCES]);
	await query(`DELETE FROM external_region_map WHERE source_id = ANY($1::text[])`, [SOURCES]);
	await query(`DELETE FROM external_sources WHERE id = ANY($1::text[])`, [SOURCES]);
}

beforeAll(async () => {
	userId = (
		await query<{ id: number }>(
			`INSERT INTO users (username, display_name, password_hash, role) VALUES ($1, $2, 'x', 'user') RETURNING id`,
			[`xr-${RUN}`, `XR ${RUN}`]
		)
	).rows[0].id;
	await addSource(SRC, { observers: true, active: true });
	await addSource(SRC_OFF, { observers: false, active: true });
	await addSource(SRC_INACTIVE, { observers: true, active: false });
	for (const s of SOURCES) {
		await query(
			`INSERT INTO external_region_map (source_id, upstream_key, region_code)
			 VALUES ($1, '18', 'NO-18'), ($1, '19', 'NO-19'), ($1, '20', 'NO-20')`,
			[s]
		);
	}
	loads.src = await addLoad(SRC, R, 'done');
	await publish(SRC, loads.src);
	loads.off = await addLoad(SRC_OFF, R, 'done');
	await publish(SRC_OFF, loads.off);
	loads.inactive = await addLoad(SRC_INACTIVE, R, 'done');
	await publish(SRC_INACTIVE, loads.inactive);
	// SRC: a failed load in Troms, one running in Finnmark, and an old failure
	// in Nordland that the newer published data supersedes.
	loads.failed = await addLoad(SRC, 'NO-19', 'failed');
	loads.running = await addLoad(SRC, 'NO-20', 'leased');
	loads.oldFailure = await addLoad(SRC, R, 'failed', { failedAgo: '3 days' });
});

afterAll(async () => {
	await cleanup();
	await query(`DELETE FROM users WHERE id = $1`, [userId]);
	const left = await query<{ n: string }>(
		`SELECT (SELECT COUNT(*) FROM external_sources WHERE id = ANY($1::text[]))
		      + (SELECT COUNT(*) FROM external_loads WHERE source_id = ANY($1::text[]))
		      + (SELECT COUNT(*) FROM external_places WHERE source_id = ANY($1::text[])) AS n`,
		[SOURCES]
	);
	expect(Number(left.rows[0].n)).toBe(0);
});

describe('externalOverview (Hotspots & data card)', () => {
	it('lists every region an active source covers, with status, totals and birders', async () => {
		const all = await externalOverview();
		expect(all.some((s) => s.source.id === SRC_INACTIVE)).toBe(false);
		const s = all.find((x) => x.source.id === SRC)!;
		expect(s.country).toEqual({ code: 'NO', name: 'Norway' });
		expect(s.regions.map((r) => r.code).sort()).toEqual(['NO-18', 'NO-19', 'NO-20']);

		const nordland = s.regions.find((r) => r.code === 'NO-18')!;
		expect(nordland.published).toMatchObject({
			loadId: loads.src,
			windowStart: '2024-10-01',
			windowEnd: '2026-09-30',
			reports: 3000,
			species: 1,
			places: 3
		});
		expect(nordland.published!.monthTotals).toEqual([0, 0, 0, 0, 2000, 1000, 0, 0, 0, 0, 0, 0]);
		// The 3-day-old failure is older than the published data, so it isn't shown.
		expect(nordland.failed).toBeNull();
		expect(nordland.active).toBeNull();
		expect(nordland.observers.map((o) => [o.rank, o.observer, o.days])).toEqual([
			[1, 'Observer A', 300],
			[2, 'Observer B', 120]
		]);

		const troms = s.regions.find((r) => r.code === 'NO-19')!;
		expect(troms.published).toBeNull();
		expect(troms.failed?.error).toBe('Artskart answered 503');

		const finnmark = s.regions.find((r) => r.code === 'NO-20')!;
		expect(finnmark.active).toEqual({ status: 'running', done: 4, total: 30, phase: 'fetching' });
		expect(s.source.regionLink).toBeNull();
		expect(finnmark.link).toBe('https://example.org/area/20');
		expect(nordland.link).toBe('https://example.org/area/18');
	});

	it('never shows observers for a source that does not store them', async () => {
		const off = (await externalOverview()).find((x) => x.source.id === SRC_OFF)!;
		const nordland = off.regions.find((r) => r.code === 'NO-18')!;
		expect(nordland.published?.reports).toBe(3000);
		expect(nordland.observers).toEqual([]);
	});
});

describe('externalSourcesForRegion', () => {
	it('fills the region link template and leaves out switched-off sources', async () => {
		const states = await externalSourcesForRegion(R);
		expect(states.some((s) => s.source.id === SRC_INACTIVE)).toBe(false);
		const mine = states.find((s) => s.source.id === SRC)!;
		expect(mine.source.regionLink).toBe('https://example.org/area/18');
		expect(mine.source.countryName).toBe('Norway');
		expect(mine.published?.loadId).toBe(loads.src);
	});
});

describe('externalSpeciesInRegion (species forecast card)', () => {
	it('opens on the busiest month when the page has none, with that month’s places', async () => {
		const { month, cards } = await externalSpeciesInRegion(R, SP, null, 1);
		expect(month).toBe(5);
		const c = cards.find((x) => x.source.id === SRC)!;
		expect(c.months).toEqual([0, 0, 0, 0, 80, 50, 0, 7, 0, 0, 0, 0]);
		expect(c.monthTotals![4]).toBe(2000);
		expect(c.placesScope).toBe('month');
		expect(c.places).toEqual([{ name: 'Vefsn', reports: 80 }]);
	});

	it('keeps the page’s month and ranks its places by reports', async () => {
		const { month, cards } = await externalSpeciesInRegion(R, SP, 6, 1);
		expect(month).toBe(6);
		const c = cards.find((x) => x.source.id === SRC)!;
		expect(c.places).toEqual([
			{ name: 'Bodø', reports: 30 },
			{ name: 'Nesna', reports: 20 }
		]);
	});

	it('falls back to the whole window when the month has no reports', async () => {
		const c = (await externalSpeciesInRegion(R, SP, 1, 1)).cards.find((x) => x.source.id === SRC)!;
		expect(c.placesScope).toBe('window');
		expect(c.places.map((p) => p.name)).toEqual(['Vefsn', 'Bodø', 'Nesna']);
	});

	it('keeps the month when its reports are placed only at county level (CODEX1 F4)', async () => {
		const c = (await externalSpeciesInRegion(R, SP, 8, 1)).cards.find((x) => x.source.id === SRC)!;
		expect(c.months![7]).toBe(7);
		expect(c.placesScope).toBe('month');
		expect(c.places).toEqual([]);
	});

	it('gives coordinates only for precise, non-generalized reports, newest first', async () => {
		const c = (await externalSpeciesInRegion(R, SP, 6, 1)).cards.find((x) => x.source.id === SRC)!;
		expect(c.latest.map((r) => r.id)).toEqual(['r2', 'r3', 'r1']);
		const byId = Object.fromEntries(c.latest.map((r) => [r.id, r]));
		expect([byId.r1.lat, byId.r1.lon]).toEqual([66.2, 13.0]);
		expect(byId.r1.place).toBe('Bodø');
		expect(byId.r1.observer).toBe('Observer A, Observer B');
		// Generalized by the source, and 5 km uncertain: name only.
		expect([byId.r2.lat, byId.r3.lat]).toEqual([null, null]);
		// Reported at county level: no municipality.
		expect(byId.r3.place).toBeNull();
	});

	it('drops observer names when the source does not store them', async () => {
		const c = (await externalSpeciesInRegion(R, SP, 6, 1)).cards.find((x) => x.source.id === SRC_OFF)!;
		expect(c.latest.length).toBe(3);
		expect(c.latest.every((r) => r.observer === null)).toBe(true);
	});

	it('shows a region with no load yet as unloaded, with the page’s month', async () => {
		const { month, cards } = await externalSpeciesInRegion('NO-19', SP, null, 7);
		const c = cards.find((x) => x.source.id === SRC)!;
		expect(c.published).toBeNull();
		expect(c.months).toBeNull();
		expect(c.failed?.error).toBe('Artskart answered 503');
		// Nothing published anywhere in Troms by this run: the current month.
		if (cards.every((x) => !x.published)) expect(month).toBe(7);
	});

	it('reads zero months for a species without reports', async () => {
		const c = (await externalSpeciesInRegion(R, SP_NONE, 6, 1)).cards.find((x) => x.source.id === SRC)!;
		expect(c.months!.every((n) => n === 0)).toBe(true);
		expect(c.places).toEqual([]);
		expect(c.latest).toEqual([]);
	});
});

describe('one read snapshot per response (CODEX1 F2)', () => {
	it('never lets a load published mid-read change what the reader returns', async () => {
		try {
			await withReadSnapshot(async (db) => {
				const before = await _readSpeciesInRegion(db, R, SP, 6, 1);
				const overviewBefore = await _readOverview(db);
				// Another connection publishes new numbers while the snapshot is open.
				await query(
					`UPDATE external_place_month_totals SET reports = reports + 500 WHERE source_id = $1 AND place_key = $2 AND month = 6`,
					[SRC, R]
				);
				await query(
					`UPDATE external_place_month_species SET reports = reports + 9 WHERE source_id = $1 AND place_key = $2 AND month = 6`,
					[SRC, P('Bodø')]
				);
				expect(await _readSpeciesInRegion(db, R, SP, 6, 1)).toEqual(before);
				expect(await _readOverview(db)).toEqual(overviewBefore);
			});
			const fresh = (await externalSpeciesInRegion(R, SP, 6, 1)).cards.find((x) => x.source.id === SRC)!;
			expect(fresh.monthTotals![5]).toBe(1500);
			expect(fresh.places[0]).toEqual({ name: 'Bodø', reports: 39 });
		} finally {
			await query(
				`UPDATE external_place_month_totals SET reports = 1000 WHERE source_id = $1 AND place_key = $2 AND month = 6`,
				[SRC, R]
			);
			await query(
				`UPDATE external_place_month_species SET reports = 30 WHERE source_id = $1 AND place_key = $2 AND month = 6`,
				[SRC, P('Bodø')]
			);
		}
	});
});

describe('load state (CODEX1 F3: loads other users started)', () => {
	it('reports which loads are still in progress and what each region shows', async () => {
		const states = await externalLoadStates([
			{ sourceId: SRC, regionCode: 'NO-20' },
			{ sourceId: SRC, regionCode: R }
		]);
		expect(states).toEqual([
			{ sourceId: SRC, regionCode: 'NO-20', active: true, publishedLoadId: null },
			{ sourceId: SRC, regionCode: R, active: false, publishedLoadId: loads.src }
		]);
	});

	it('answers the cards over GET, and refuses bad keys and no session', async () => {
		const call = (qs: string, scopeId: number | null = userId) =>
			loadStateRoute.GET({
				locals: { scopeId },
				url: new URL(`http://localhost/api/external/load-state?${qs}`)
			} as unknown as Parameters<typeof loadStateRoute.GET>[0]);
		const res = await call(`k=${SRC}:NO-20`);
		expect(await res.json()).toEqual({ states: [{ sourceId: SRC, regionCode: 'NO-20', active: true, publishedLoadId: null }] });
		await expect(call('k=nordland')).rejects.toMatchObject({ status: 400 });
		await expect(call('')).rejects.toMatchObject({ status: 400 });
		await expect(call(`k=${SRC}:NO-20`, null)).rejects.toMatchObject({ status: 401 });
	});
});

describe('externalSpeciesSummary (species page)', () => {
	it('lists only regions with reports, from active sources', async () => {
		const all = await externalSpeciesSummary(SP, 'NO');
		expect(all.some((s) => s.source.id === SRC_INACTIVE)).toBe(false);
		const mine = all.find((s) => s.source.id === SRC)!;
		expect(mine.regions).toEqual([
			{
				regionCode: 'NO-18',
				regionName: 'Nordland',
				reports: 137,
				months: [0, 0, 0, 0, 80, 50, 0, 7, 0, 0, 0, 0],
				windowStart: '2024-10-01',
				windowEnd: '2026-09-30'
			}
		]);
		expect((await externalSpeciesSummary(SP_NONE)).some((s) => s.source.id === SRC)).toBe(false);
		expect((await externalSpeciesSummary(SP, 'SE')).some((s) => s.source.id === SRC)).toBe(false);
	});
});

describe('queueExternalLoadAction (Load reports)', () => {
	function event(fields: Record<string, string>, role: string | null = 'user') {
		const body = new FormData();
		for (const [k, v] of Object.entries(fields)) body.set(k, v);
		return {
			locals: { user: role ? { id: userId, role } : null },
			request: new Request('http://localhost/forecast/data?/queueExternalLoad', { method: 'POST', body })
		} as unknown as Parameters<typeof queueExternalLoadAction>[0];
	}

	it('refuses viewers and malformed fields', async () => {
		const viewer = await queueExternalLoadAction(event({ source_id: SRC, region_code: 'NO-19' }, 'viewer'));
		expect(viewer).toMatchObject({ status: 403 });
		const bad = await queueExternalLoadAction(event({ source_id: SRC, region_code: 'Nordland' }));
		expect(bad).toMatchObject({ status: 400 });
		const noUser = await queueExternalLoadAction(event({ source_id: SRC, region_code: 'NO-19' }, null));
		expect(noUser).toMatchObject({ status: 403 });
	});

	it('queues once per region and returns the queued load the second time', async () => {
		const first = await queueExternalLoadAction(event({ source_id: SRC, region_code: 'NO-19' }));
		expect(first).toEqual({ externalQueued: { sourceId: SRC, regionCode: 'NO-19', created: true } });
		const again = await queueExternalLoadAction(event({ source_id: SRC, region_code: 'NO-19' }));
		expect(again).toEqual({ externalQueued: { sourceId: SRC, regionCode: 'NO-19', created: false } });
		const row = await query<{ requested_by: number; status: string }>(
			`SELECT requested_by, status FROM external_loads WHERE source_id = $1 AND region_code = 'NO-19' AND status = 'queued'`,
			[SRC]
		);
		expect(row.rows).toEqual([{ requested_by: userId, status: 'queued' }]);
	});

	it('says why a switched-off source or an unmapped region is refused', async () => {
		const off = await queueExternalLoadAction(event({ source_id: SRC_INACTIVE, region_code: 'NO-19' }));
		expect(off).toMatchObject({ status: 409, data: { externalError: 'This source is switched off.', regionCode: 'NO-19' } });
		const unmapped = await queueExternalLoadAction(event({ source_id: SRC, region_code: 'NO-11' }));
		expect(unmapped).toMatchObject({ status: 400, data: { regionCode: 'NO-11' } });
		const unknown = await queueExternalLoadAction(event({ source_id: `nope-${RUN}`, region_code: 'NO-19' }));
		expect(unknown).toMatchObject({ status: 404 });
	});
});

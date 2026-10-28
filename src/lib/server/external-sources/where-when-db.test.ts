/**
 * External sources, Phase 4 (td-b6ddfc): the "Where and when to look" reader
 * and its route load, against birds_test.
 *
 * Fixture ownership (docs/agent-development-guide.md §3): sources `xw-<run>`
 * (stores observers), `xwo-<run>` (does not), `xwi-<run>` (switched off) and
 * `xwu-<run>` (covers the region, nothing loaded); their region map rows,
 * loads and published rows; three fake species with taxonomy rows; two users
 * `xw-<run>` and `xw2-<run>` with seen rows. Regions (NO-18) are only READ.
 * Cleanup deletes by those exact ids.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadTestEnv, requireTestDb } from '$server/testing/test-env';
import { query, withReadSnapshot } from '$lib/db';
import { _readWhereWhen, externalWhereWhen } from './where-when';
import { load as routeLoad } from '../../../routes/reports/[source]/[region]/+page.server';

loadTestEnv();
await requireTestDb(query);

const RUN = `${process.pid.toString(36)}${Date.now().toString(36).slice(-5)}`;
const SRC = `xw-${RUN}`;
const SRC_OFF = `xwo-${RUN}`;
const SRC_INACTIVE = `xwi-${RUN}`;
const SRC_EMPTY = `xwu-${RUN}`;
const SOURCES = [SRC, SRC_OFF, SRC_INACTIVE, SRC_EMPTY];
// Taxonomic order: A, B, C. The user has seen A.
const SA = `xwa-${RUN}`;
const SB = `xwb-${RUN}`;
const SC = `xwc-${RUN}`;
const SPECIES = [SA, SB, SC];
const R = 'NO-18';
const P = (name: string) => `${R}:${name}`;

let userId = 0;
let otherUserId = 0;

async function addSource(id: string, opts: { observers: boolean; active: boolean }) {
	await query(
		`INSERT INTO external_sources (id, name, publisher, license, license_url, citation, attribution, record_semantics,
		                               homepage, covers_country, geo_scheme, window_months, store_observers, active)
		 VALUES ($1, $2, 'Test publisher', 'CC BY 4.0', 'https://creativecommons.org/licenses/by/4.0/', 'Test citation',
		         'Test attribution', 'reports', 'https://example.org/', 'NO', 'TEST', 24, $3, $4)`,
		[id, `Test ${id}`, opts.observers, opts.active]
	);
	await query(`INSERT INTO external_region_map (source_id, upstream_key, region_code) VALUES ($1, '18', $2)`, [id, R]);
}

async function publish(source: string) {
	const load = (
		await query<{ id: string }>(
			`INSERT INTO external_loads (source_id, region_code, status, max_attempts, window_months, window_start, window_end,
			                             retrieved_at, finished_at)
			 VALUES ($1, $2, 'done', 3, 24, DATE '2024-10-01', DATE '2026-09-30', now(), now()) RETURNING id`,
			[source, R]
		)
	).rows[0].id;
	// Øksnes sorts after Vefsn in Norwegian; Andøy first.
	await query(
		`INSERT INTO external_places (source_id, region_code, place_key, name, level, parent_key, load_id) VALUES
		   ($1, $3, $3, 'Nordland', 'region', NULL, $2),
		   ($1, $3, $4, 'Bodø', 'subregion', $3, $2),
		   ($1, $3, $5, 'Øksnes', 'subregion', $3, $2),
		   ($1, $3, $6, 'Andøy', 'subregion', $3, $2),
		   ($1, $3, $7, 'Vefsn', 'subregion', $3, $2)`,
		[source, load, R, P('Bodø'), P('Øksnes'), P('Andøy'), P('Vefsn')]
	);
	await query(
		`INSERT INTO external_place_month_totals (source_id, region_code, place_key, month, reports, unkeyed, load_id) VALUES
		   ($1, $3, $3, 5, 900, 0, $2), ($1, $3, $3, 6, 500, 0, $2),
		   ($1, $3, $4, 5, 400, 0, $2), ($1, $3, $4, 6, 300, 0, $2),
		   ($1, $3, $5, 5, 300, 0, $2), ($1, $3, $5, 6, 100, 0, $2),
		   ($1, $3, $6, 5, 200, 0, $2), ($1, $3, $6, 6, 100, 0, $2)`,
		[source, load, R, P('Bodø'), P('Øksnes'), P('Andøy')]
	);
	// June: A in Bodø 30, Øksnes 10; B in Bodø 5, Øksnes 5, Andøy 5 (a tie);
	// May: B in Andøy 50; C only in Øksnes in May (7). Vefsn has nothing.
	// A zero row must never count as a report.
	await query(
		`INSERT INTO external_place_month_species (source_id, region_code, place_key, species_code, month, reports, load_id) VALUES
		   ($1, $3, $3, $7, 6, 40, $2), ($1, $3, $3, $8, 6, 15, $2), ($1, $3, $3, $8, 5, 50, $2), ($1, $3, $3, $9, 5, 7, $2),
		   ($1, $3, $4, $7, 6, 30, $2), ($1, $3, $5, $7, 6, 10, $2),
		   ($1, $3, $4, $8, 6, 5, $2), ($1, $3, $5, $8, 6, 5, $2), ($1, $3, $6, $8, 6, 5, $2), ($1, $3, $6, $8, 5, 50, $2),
		   ($1, $3, $5, $9, 5, 7, $2),
		   ($1, $3, $3, $9, 8, 0, $2), ($1, $3, $10, $9, 8, 0, $2)`,
		[source, load, R, P('Bodø'), P('Øksnes'), P('Andøy'), SA, SB, SC, P('Vefsn')]
	);
	// Bodø's places: a pin, a pin with too wide an uncertainty, and text.
	await query(
		`INSERT INTO external_top_localities (source_id, region_code, place_key, rank, locality, reports, lat, lon,
		                                      uncertainty_m, placement, load_id) VALUES
		   ($1, $3, $4, 1, 'Kjerringøy', 120, 67.5, 14.7, 100, 'pin', $2),
		   ($1, $3, $4, 2, 'Saltstraumen', 80, 67.2, 14.6, 1500, 'pin', $2),
		   ($1, $3, $4, 3, 'Bodø sentrum', 40, NULL, NULL, 2000, 'text', $2)`,
		[source, load, R, P('Bodø')]
	);
	await query(
		`INSERT INTO external_top_observers (source_id, region_code, place_key, rank, observer, days, species, localities, reports, load_id)
		 VALUES ($1, $3, $3, 1, 'Observer A', 300, 200, 40, 9000, $2), ($1, $3, $4, 1, 'Observer B', 50, 60, 5, 400, $2)`,
		[source, load, R, P('Bodø')]
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
	await query(`DELETE FROM seen_species WHERE species_code = ANY($1::text[])`, [SPECIES]);
	await query(`DELETE FROM taxonomy_cache WHERE species_code = ANY($1::text[])`, [SPECIES]);
}

beforeAll(async () => {
	const addUser = async (name: string) =>
		(
			await query<{ id: number }>(
				`INSERT INTO users (username, display_name, password_hash, role) VALUES ($1, $1, 'x', 'user') RETURNING id`,
				[name]
			)
		).rows[0].id;
	userId = await addUser(`xw-${RUN}`);
	otherUserId = await addUser(`xw2-${RUN}`);
	await query(
		`INSERT INTO taxonomy_cache (species_code, com_name, sci_name, category, taxon_order) VALUES
		   ($1, 'Test Alpha', 'Testus alpha', 'species', -3), ($2, 'Test Beta', 'Testus beta', 'species', -2),
		   ($3, 'Test Gamma', 'Testus gamma', 'species', -1)`,
		SPECIES
	);
	await query(`INSERT INTO seen_species (user_id, species_code) VALUES ($1, $2), ($3, $4)`, [
		userId,
		SA,
		otherUserId,
		SB
	]);
	await addSource(SRC, { observers: true, active: true });
	await addSource(SRC_OFF, { observers: false, active: true });
	await addSource(SRC_INACTIVE, { observers: true, active: false });
	await addSource(SRC_EMPTY, { observers: true, active: true });
	await publish(SRC);
	await publish(SRC_OFF);
	await publish(SRC_INACTIVE);
});

afterAll(async () => {
	await cleanup();
	await query(`DELETE FROM users WHERE id = ANY($1::int[])`, [[userId, otherUserId]]);
	const left = await query<{ n: string }>(
		`SELECT (SELECT COUNT(*) FROM external_sources WHERE id = ANY($1::text[]))
		      + (SELECT COUNT(*) FROM external_places WHERE source_id = ANY($1::text[]))
		      + (SELECT COUNT(*) FROM taxonomy_cache WHERE species_code = ANY($2::text[])) AS n`,
		[SOURCES, SPECIES]
	);
	expect(Number(left.rows[0].n)).toBe(0);
});

const base = { sourceId: SRC, regionCode: R, place: null, month: 6 };

describe('externalWhereWhen, whole region', () => {
	it('lists species in taxonomic order with months, seen flags and where they are reported', async () => {
		const v = (await externalWhereWhen({ ...base, userId }))!;
		expect(v.regionName).toBe('Nordland');
		expect(v.place).toBeNull();
		expect(v.places.map((p) => p.name)).toEqual(['Andøy', 'Bodø', 'Vefsn', 'Øksnes']);
		expect(v.places.find((p) => p.name === 'Bodø')).toMatchObject({ reports: 700 });
		expect(v.monthTotals.slice(4, 6)).toEqual([900, 500]);

		expect(v.species.map((s) => [s.code, s.name, s.seen, s.reports])).toEqual([
			[SA, 'Test Alpha', true, 40],
			[SB, 'Test Beta', false, 65],
			[SC, 'Test Gamma', false, 7]
		]);
		const a = v.species[0];
		expect(a.months[5]).toBe(40);
		expect(a.whereMonth).toEqual([
			{ name: 'Bodø', reports: 30 },
			{ name: 'Øksnes', reports: 10 }
		]);
		// B's June tie (5 each) breaks by name; over the window Andøy leads (55).
		const b = v.species[1];
		expect(b.whereMonth.map((w) => w.name)).toEqual(['Andøy', 'Bodø', 'Øksnes']);
		expect(b.whereWindow[0]).toEqual({ name: 'Andøy', reports: 55 });
		// C has no June reports: nothing for the month, Øksnes for the window.
		const c = v.species[2];
		expect(c.whereMonth).toEqual([]);
		expect(c.whereWindow).toEqual([{ name: 'Øksnes', reports: 7 }]);
		expect(v.localities).toEqual([]);
	});

	it("counts each municipality's species and needs for the month and the window", async () => {
		const v = (await externalWhereWhen({ ...base, userId }))!;
		const row = (n: string) => v.placeRows.find((r) => r.name === n)!;
		expect(row('Bodø')).toEqual({
			name: 'Bodø',
			monthReports: 300,
			monthSpecies: 2,
			monthNeeds: 1,
			reports: 700,
			species: 2,
			needs: 1
		});
		expect(row('Øksnes')).toMatchObject({ monthSpecies: 2, monthNeeds: 1, species: 3, needs: 2 });
		// Vefsn has only a zero row: no species, no needs.
		expect(row('Vefsn')).toMatchObject({ monthReports: 0, monthSpecies: 0, species: 0, needs: 0 });
	});

	it("uses the viewer's own life list", async () => {
		const v = (await externalWhereWhen({ ...base, userId: otherUserId }))!;
		expect(v.species.map((s) => [s.code, s.seen])).toEqual([
			[SA, false],
			[SB, true],
			[SC, false]
		]);
		expect(v.placeRows.find((r) => r.name === 'Bodø')).toMatchObject({ monthNeeds: 1, needs: 1 });
	});

	it('shows the region birders only for a source that stores them', async () => {
		const v = (await externalWhereWhen({ ...base, userId }))!;
		expect(v.observers.map((o) => o.observer)).toEqual(['Observer A']);
		const off = (await externalWhereWhen({ ...base, sourceId: SRC_OFF, userId }))!;
		expect(off.observers).toEqual([]);
		expect(off.species).toHaveLength(3);
	});
});

describe('externalWhereWhen, one municipality', () => {
	it("reads the municipality's months, species, places and birders", async () => {
		const v = (await externalWhereWhen({ ...base, place: 'Bodø', userId }))!;
		expect(v.place).toBe('Bodø');
		expect(v.monthTotals.slice(4, 6)).toEqual([400, 300]);
		expect(v.species.map((s) => [s.code, s.reports])).toEqual([
			[SA, 30],
			[SB, 5]
		]);
		expect(v.species.every((s) => s.whereMonth.length === 0 && s.whereWindow.length === 0)).toBe(true);
		expect(v.placeRows).toEqual([]);
		expect(v.observers.map((o) => o.observer)).toEqual(['Observer B']);
	});

	it('gives coordinates (map pin, Add to trip) only to a pin within 1 km', async () => {
		const v = (await externalWhereWhen({ ...base, place: 'Bodø', userId }))!;
		expect(v.localities).toEqual([
			{ rank: 1, locality: 'Kjerringøy', reports: 120, lat: 67.5, lon: 14.7 },
			{ rank: 2, locality: 'Saltstraumen', reports: 80, lat: null, lon: null },
			{ rank: 3, locality: 'Bodø sentrum', reports: 40, lat: null, lon: null }
		]);
	});

	it('never lists a species whose only rows there are zero', async () => {
		const v = (await externalWhereWhen({ ...base, place: 'Vefsn', userId }))!;
		expect(v.place).toBe('Vefsn');
		expect(v.species).toEqual([]);
	});

	it('reads an unknown place as the whole region', async () => {
		const v = (await externalWhereWhen({ ...base, place: 'Atlantis', userId }))!;
		expect(v.place).toBeNull();
		expect(v.placeRows).toHaveLength(4);
		// A region name is not a municipality either.
		const r = (await externalWhereWhen({ ...base, place: 'Nordland', userId }))!;
		expect(r.place).toBeNull();
	});
});

describe('externalWhereWhen, sources', () => {
	it('is null for a switched-off source or one that does not cover the region', async () => {
		expect(await externalWhereWhen({ ...base, sourceId: SRC_INACTIVE, userId })).toBeNull();
		expect(await externalWhereWhen({ ...base, regionCode: 'NO-19', userId })).toBeNull();
		expect(await externalWhereWhen({ ...base, sourceId: `nope-${RUN}`, userId })).toBeNull();
	});

	it('returns an empty view, with the source, when nothing is loaded', async () => {
		const v = (await externalWhereWhen({ ...base, sourceId: SRC_EMPTY, userId }))!;
		expect(v.state.published).toBeNull();
		expect(v.state.source.id).toBe(SRC_EMPTY);
		expect(v.species).toEqual([]);
		expect(v.places).toEqual([]);
	});

	it('reads everything on the caller snapshot', async () => {
		const v = await withReadSnapshot((db) => _readWhereWhen(db, { ...base, userId }));
		expect(v?.species).toHaveLength(3);
	});
});

describe('/reports/[source]/[region] load', () => {
	type LoadEvent = Parameters<typeof routeLoad>[0];
	const call = (source: string, region: string, search: string, role: 'user' | 'viewer' = 'user') =>
		routeLoad({
			params: { source, region },
			url: new URL(`http://x/reports/${source}/${region}${search}`),
			locals: { user: { id: userId, role }, scopeId: userId }
		} as unknown as LoadEvent) as Promise<Record<string, unknown>>;

	it('reads its parameters: month, place, view and seen', async () => {
		const d = await call(SRC, R, '?month=5&place=Bod%C3%B8&view=species&seen=all');
		expect(d).toMatchObject({ month: 5, place: 'Bodø', mode: 'species', seen: 'all', regionCode: R, canLoad: true });
	});

	it('defaults to this month, the whole region, by month and needs', async () => {
		const d = await call(SRC, R, '?month=13&view=x&seen=x');
		expect(d).toMatchObject({ month: new Date().getMonth() + 1, place: null, mode: 'month', seen: 'needs' });
	});

	it('does not offer loading to a viewer', async () => {
		const d = await call(SRC, R, '', 'viewer');
		expect(d.canLoad).toBe(false);
	});

	it('is 404 for a bad or unknown source or region', async () => {
		await expect(call('Bad Source', R, '')).rejects.toMatchObject({ status: 404 });
		await expect(call(SRC, 'nordland', '')).rejects.toMatchObject({ status: 404 });
		await expect(call(SRC_INACTIVE, R, '')).rejects.toMatchObject({ status: 404 });
	});
});

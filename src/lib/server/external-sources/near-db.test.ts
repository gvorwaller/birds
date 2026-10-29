/**
 * "What can I see?" → reports near a point (td-46fff6 rev B), against
 * birds_test.
 *
 * Fixture ownership (docs/agent-development-guide.md §3): sources `xn-<run>`
 * and `xn2-<run>` (active) and `xni-<run>` (switched off); their loads, places, taxa and
 * records; four fake species with taxonomy rows; two users `xn-<run>` and
 * `xn2-<run>` with seen rows. Regions (NO-18, NO-03) are only READ. Cleanup
 * deletes by those exact ids.
 *
 * Every record sits due north of the test point at a known distance, so a
 * radius cut is exact: 1° of latitude is π·6371/180 km.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadTestEnv, requireTestDb } from '$server/testing/test-env';
import { query } from '$lib/db';
import { boxAround, externalNear, monthYearsIn } from './near';

loadTestEnv();
await requireTestDb(query);

const RUN = `${process.pid.toString(36)}${Date.now().toString(36).slice(-5)}`;
const SRC = `xn-${RUN}`;
const SRC_OFF = `xni-${RUN}`;
// A second active source, with reports only beyond the radius.
const SRC2 = `xn2-${RUN}`;
const SOURCES = [SRC, SRC_OFF, SRC2];
const SA = `xna-${RUN}`;
const SB = `xnb-${RUN}`;
const SC = `xnc-${RUN}`;
const SD = `xnd-${RUN}`;
const SPECIES = [SA, SB, SC, SD];
const R = 'NO-18';
const R2 = 'NO-03';
// The test point: open sea west of Norway, where no real record lies.
const LAT = 66;
const LON = 2;
const KM_PER_DEG = (Math.PI * 6371) / 180;
const north = (km: number) => LAT + km / KM_PER_DEG;

let userId = 0;
let otherUserId = 0;

async function addSource(id: string, active: boolean) {
	await query(
		`INSERT INTO external_sources (id, name, publisher, license, license_url, citation, attribution, record_semantics,
		                               homepage, covers_country, geo_scheme, window_months, store_observers, active)
		 VALUES ($1, $2, 'Test publisher', 'CC BY 4.0', 'https://creativecommons.org/licenses/by/4.0/', 'Test citation',
		         'Test attribution', 'reports', 'https://example.org/', 'NO', 'TEST', 24, false, $3)`,
		[id, `Test ${id}`, active]
	);
	await query(
		`INSERT INTO external_region_map (source_id, upstream_key, region_code) VALUES ($1, '18', $2), ($1, '3', $3)`,
		[id, R, R2]
	);
}

async function publish(source: string, region: string, windowStart: string, windowEnd: string, places: string[]) {
	const load = (
		await query<{ id: string }>(
			`INSERT INTO external_loads (source_id, region_code, status, max_attempts, window_months, window_start, window_end,
			                             retrieved_at, finished_at)
			 VALUES ($1, $2, 'done', 3, 24, $3::date, $4::date, now(), now()) RETURNING id`,
			[source, region, windowStart, windowEnd]
		)
	).rows[0].id;
	await query(
		`INSERT INTO external_places (source_id, region_code, place_key, name, level, parent_key, load_id)
		 VALUES ($1, $2, $2, $2, 'region', NULL, $3)`,
		[source, region, load]
	);
	for (const name of places) {
		await query(
			`INSERT INTO external_places (source_id, region_code, place_key, name, level, parent_key, load_id)
			 VALUES ($1, $2, $4, $5, 'subregion', $2, $3)`,
			[source, region, load, `${region}:${name}`, name]
		);
	}
	return load;
}

async function addTaxa(source: string, load: string) {
	// B has a subspecies too; O is a genus (no species code).
	await query(
		`INSERT INTO external_taxa (source_id, upstream_taxon_id, canonical_name, raw_name, rank, species_code, match_reason, load_id) VALUES
		   ($1, '1', 'Testus alpha', 'Testus alpha', 'SPECIES', $3, 'scientific', $2),
		   ($1, '2', 'Testus beta', 'Testus beta', 'SPECIES', $4, 'scientific', $2),
		   ($1, '22', 'Testus beta minor', 'Testus beta minor', 'SUBSPECIES', $4, 'subspecies', $2),
		   ($1, '3', 'Testus gamma', 'Testus gamma', 'SPECIES', $5, 'scientific', $2),
		   ($1, '4', 'Testus delta', 'Testus delta', 'SPECIES', $6, 'scientific', $2),
		   ($1, '9', 'Testus', 'Testus', 'OTHER', NULL, 'not_species', $2)`,
		[source, load, SA, SB, SC, SD]
	);
}

let seq = 0;
async function record(
	source: string,
	region: string,
	load: string,
	r: { taxon: string; on: string; km: number; east?: number; place: string | null; locality: string | null; unc?: number | null }
) {
	const [id, name] = {
		'1': ['1', 'Testus alpha'],
		'2': ['2', 'Testus beta'],
		'22': ['22', 'Testus beta minor'],
		'3': ['3', 'Testus gamma'],
		'4': ['4', 'Testus delta'],
		'9': ['9', 'Testus']
	}[r.taxon]!;
	await query(
		`INSERT INTO external_records (source_id, region_code, upstream_record_id, place_key, upstream_taxon_id, canonical_name,
		                               observed_on, locality, lat, lon, uncertainty_m, observers, behaviour, load_id)
		 VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8, $9, $10, $11, '{}', '{}', $12)`,
		[
			source,
			region,
			`r${++seq}`,
			r.place ? `${region}:${r.place}` : region,
			id,
			name,
			r.on,
			r.locality,
			north(r.km),
			LON + (r.east ?? 0) / (KM_PER_DEG * Math.cos((north(r.km) * Math.PI) / 180)),
			r.unc === undefined ? 50 : r.unc,
			load
		]
	);
}

async function cleanup() {
	await query(`DELETE FROM external_records WHERE source_id = ANY($1::text[])`, [SOURCES]);
	await query(`DELETE FROM external_taxa WHERE source_id = ANY($1::text[])`, [SOURCES]);
	await query(`DELETE FROM external_places WHERE source_id = ANY($1::text[])`, [SOURCES]);
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
	userId = await addUser(`xn-${RUN}`);
	otherUserId = await addUser(`xn2-${RUN}`);
	await query(
		`INSERT INTO taxonomy_cache (species_code, com_name, sci_name, category, taxon_order) VALUES
		   ($1, 'Test Alpha', 'Testus alpha', 'species', -4), ($2, 'Test Beta', 'Testus beta', 'species', -3),
		   ($3, 'Test Gamma', 'Testus gamma', 'species', -2), ($4, 'Test Delta', 'Testus delta', 'species', -1)`,
		SPECIES
	);
	// The user has seen A; the other user has seen B.
	await query(`INSERT INTO seen_species (user_id, species_code) VALUES ($1, $2), ($3, $4)`, [userId, SA, otherUserId, SB]);

	await addSource(SRC, true);
	await addSource(SRC_OFF, false);
	await addSource(SRC2, true);
	const load = await publish(SRC, R, '2024-10-01', '2026-09-30', ['Bodø', 'Vefsn']);
	// A second county with a later window: one October inside it.
	const load2 = await publish(SRC, R2, '2025-01-01', '2026-12-31', ['Oslo']);
	const loadOff = await publish(SRC_OFF, R, '2024-10-01', '2026-09-30', ['Bodø']);
	const loadB = await publish(SRC2, R, '2024-10-01', '2026-09-30', ['Bodø']);
	await addTaxa(SRC, load);
	await addTaxa(SRC_OFF, loadOff);
	await addTaxa(SRC2, loadB);

	const oct24 = '2024-10-12';
	const oct25 = '2025-10-03';
	// Within 40 km, in October, inside the window:
	// B: 3 at Alpha strand (5 km, 2024), 1 subspecies there (2025), 1 at Beta vik (20 km, 2025).
	for (let i = 0; i < 3; i++) await record(SRC, R, load, { taxon: '2', on: oct24, km: 5, place: 'Bodø', locality: 'Alpha strand, Bodø, No' });
	await record(SRC, R, load, { taxon: '22', on: oct25, km: 5.2, place: 'Bodø', locality: 'Alpha strand, Bodø, No' });
	await record(SRC, R, load, { taxon: '2', on: oct25, km: 20, place: 'Vefsn', locality: 'Beta vik', unc: 2000 });
	// A (seen by the user): 2 at Alpha strand.
	await record(SRC, R, load, { taxon: '1', on: oct24, km: 5, place: 'Bodø', locality: 'Alpha strand, Bodø, No' });
	await record(SRC, R, load, { taxon: '1', on: oct25, km: 5, place: 'Bodø', locality: 'Alpha strand, Bodø, No' });
	// A genus report: a bird report, not a species.
	await record(SRC, R, load, { taxon: '9', on: oct25, km: 5, place: 'Bodø', locality: 'Alpha strand, Bodø, No' });
	// C just inside the radius, in the second county, no locality; D with no municipality.
	await record(SRC, R2, load2, { taxon: '3', on: oct25, km: 39.9, place: 'Oslo', locality: null });
	await record(SRC, R, load, { taxon: '4', on: oct24, km: 30, place: null, locality: 'Delta skjær', unc: null });

	// Never counted: just outside 40 km, another month, after the window,
	// before the second county's window, and a switched-off source.
	await record(SRC, R, load, { taxon: '2', on: oct24, km: 40.1, place: 'Vefsn', locality: 'Far away' });
	// Inside the search box's corner, outside the circle (about 42 km).
	await record(SRC, R, load, { taxon: '2', on: oct24, km: 30, east: 30, place: 'Vefsn', locality: 'Box corner' });
	await record(SRC, R, load, { taxon: '2', on: '2025-09-30', km: 5, place: 'Bodø', locality: 'Alpha strand, Bodø, No' });
	await record(SRC, R, load, { taxon: '2', on: '2026-10-01', km: 5, place: 'Bodø', locality: 'Alpha strand, Bodø, No' });
	await record(SRC, R2, load2, { taxon: '3', on: oct24, km: 10, place: 'Oslo', locality: 'Too early' });
	await record(SRC_OFF, R, loadOff, { taxon: '2', on: oct24, km: 5, place: 'Bodø', locality: 'Alpha strand, Bodø, No' });
	// The second source: one report at 45 km, outside 40 km, inside 3 × 40.
	await record(SRC2, R, loadB, { taxon: '2', on: oct24, km: 45, place: 'Bodø', locality: 'Second skjær' });
	// November only: the same county-level locality name in both counties.
	await record(SRC, R, load, { taxon: '2', on: '2025-11-02', km: 6, place: null, locality: 'Skjæret' });
	await record(SRC, R2, load2, { taxon: '2', on: '2025-11-03', km: 7, place: null, locality: 'Skjæret' });
});

afterAll(async () => {
	await cleanup();
	await query(`DELETE FROM users WHERE id = ANY($1::int[])`, [[userId, otherUserId]]);
	const left = await query<{ n: string }>(
		`SELECT (SELECT COUNT(*) FROM external_sources WHERE id = ANY($1::text[]))
		      + (SELECT COUNT(*) FROM external_records WHERE source_id = ANY($1::text[]))
		      + (SELECT COUNT(*) FROM taxonomy_cache WHERE species_code = ANY($2::text[])) AS n`,
		[SOURCES, SPECIES]
	);
	expect(Number(left.rows[0].n)).toBe(0);
});

const base = { lat: LAT, lon: LON, radiusKm: 40, month: 10 };

describe('externalNear', () => {
	it('counts only reports within the radius, in the month, inside the window, from active sources', async () => {
		const cards = await externalNear({ ...base, userId });
		expect(cards.map((c) => c.source.id)).toEqual([SRC, SRC2]);
		const c = cards[0];
		// B 5, A 2, genus 1, C 1, D 1.
		expect(c.reports).toBe(10);
		expect(c.species.map((s) => [s.code, s.reports])).toEqual([
			[SB, 5],
			[SA, 2],
			[SD, 1],
			[SC, 1]
		]);
		expect(c.nearest).toBeNull();
	});

	it('orders species by reports then name, and marks what the viewer has seen', async () => {
		const [c] = await externalNear({ ...base, userId });
		expect(c.species.map((s) => s.name)).toEqual(['Test Beta', 'Test Alpha', 'Test Delta', 'Test Gamma']);
		expect(c.species.filter((s) => s.seen).map((s) => s.code)).toEqual([SA]);
		const [o] = await externalNear({ ...base, userId: otherUserId });
		expect(o.species.filter((s) => s.seen).map((s) => s.code)).toEqual([SB]);
	});

	it("gives each species its places, years and the county with most of its reports", async () => {
		const [c] = await externalNear({ ...base, userId });
		const b = c.species.find((s) => s.code === SB)!;
		expect(b.years).toBe(2);
		expect(b.regionCode).toBe(R);
		expect(b.where.map((p) => [p.locality, p.municipality, p.reports])).toEqual([
			['Alpha strand, Bodø, No', 'Bodø', 4],
			['Beta vik', 'Vefsn', 1]
		]);
		expect(b.where[0].km).toBeCloseTo(5, 3);
		const g = c.species.find((s) => s.code === SC)!;
		expect(g.regionCode).toBe(R2);
		// No locality: named by its municipality.
		expect(g.where[0]).toMatchObject({ locality: 'Oslo', municipality: 'Oslo', reports: 1 });
		expect(g.years).toBe(1);
	});

	it('lists the busiest places for all birds, with a pin only within 1 km uncertainty', async () => {
		const [c] = await externalNear({ ...base, userId });
		expect(c.places.map((p) => [p.locality, p.reports])).toEqual([
			['Alpha strand, Bodø, No', 7],
			['Beta vik', 1],
			['Delta skjær', 1],
			['Oslo', 1]
		]);
		const alpha = c.places[0];
		expect(alpha.lat).toBeCloseTo(north(5), 6);
		expect(alpha.lon).toBe(LON);
		expect(c.places.find((p) => p.locality === 'Beta vik')).toMatchObject({ lat: null, lon: null });
		expect(c.places.find((p) => p.locality === 'Delta skjær')).toMatchObject({ lat: null, lon: null, municipality: null });
		expect(c.municipalities).toEqual([
			{ regionCode: R, name: 'Bodø', reports: 7 },
			{ regionCode: R2, name: 'Oslo', reports: 1 },
			{ regionCode: R, name: 'Vefsn', reports: 1 }
		]);
	});

	it('names the counties and the years of the month inside their windows', async () => {
		const [c] = await externalNear({ ...base, userId });
		// By county name: Nordland, Oslo.
		expect(c.counties.map((w) => [w.code, w.windowStart, w.windowEnd])).toEqual([
			[R, '2024-10-01', '2026-09-30'],
			[R2, '2025-01-01', '2026-12-31']
		]);
		// Octobers 2024 and 2025 (Nordland), 2025 and 2026 (Oslo).
		expect(c.monthYears).toBe(3);
	});

	it('narrows with the radius', async () => {
		const [c] = await externalNear({ ...base, radiusKm: 8, userId });
		expect(c.reports).toBe(7);
		expect(c.species.map((s) => s.code).sort()).toEqual([SA, SB].sort());
		expect(c.counties.map((w) => w.code)).toEqual([R]);
	});

	it('names the nearest report when nothing is within the radius', async () => {
		// 28 km south of Alpha strand: nothing within 8 km; Alpha strand lies
		// beyond 3 × 8 km but inside the 30 km floor.
		const [c] = await externalNear({ ...base, lat: north(5) - 28 / KM_PER_DEG, radiusKm: 8, userId });
		expect(c.reports).toBe(0);
		expect(c.species).toEqual([]);
		expect(c.nearest).toMatchObject({ locality: 'Alpha strand, Bodø, No', municipality: 'Bodø', regionCode: R });
		expect(c.nearest!.km).toBeCloseTo(28, 3);
		expect(c.counties.map((w) => w.code)).toEqual([R]);
	});

	it("names each source's nearest report when that source has nothing within the radius", async () => {
		// The first source has reports within 40 km; that must not hide the second's nearest.
		const [c, b] = await externalNear({ ...base, userId });
		expect(c.nearest).toBeNull();
		expect(b.reports).toBe(0);
		expect(b.species).toEqual([]);
		expect(b.nearest).toMatchObject({ locality: 'Second skjær', municipality: 'Bodø', regionCode: R });
		expect(b.nearest!.km).toBeCloseTo(45, 3);
		expect(b.counties.map((w) => w.code)).toEqual([R]);
	});

	it('keeps places with the same name in different counties apart, with unique keys', async () => {
		const [c] = await externalNear({ ...base, month: 11, userId });
		const b = c.species.find((s) => s.code === SB)!;
		expect(b.where.map((p) => [p.locality, p.municipality, p.reports])).toEqual([
			['Skjæret', null, 1],
			['Skjæret', null, 1]
		]);
		expect(new Set(b.where.map((p) => p.key)).size).toBe(2);
		expect(new Set(c.places.map((p) => p.key)).size).toBe(c.places.length);
		// Every list the card keys by p.key holds unique keys at full scale too.
		const [o] = await externalNear({ ...base, userId });
		for (const s of o.species) expect(new Set(s.where.map((p) => p.key)).size).toBe(s.where.length);
	});

	it('gives no card when nothing is within reach, or in another month', async () => {
		expect(await externalNear({ ...base, lat: LAT - 1, radiusKm: 8, userId })).toEqual([]);
		expect(await externalNear({ ...base, month: 3, userId })).toEqual([]);
	});
});

describe('near helpers', () => {
	// The point at `km` on bearing `deg` from (lat, lon), on the same sphere.
	function destination(lat: number, lon: number, km: number, deg: number) {
		const a = km / 6371;
		const t = (deg * Math.PI) / 180;
		const p1 = (lat * Math.PI) / 180;
		const l1 = (lon * Math.PI) / 180;
		const p2 = Math.asin(Math.sin(p1) * Math.cos(a) + Math.cos(p1) * Math.sin(a) * Math.cos(t));
		const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(a) * Math.cos(p1), Math.cos(a) - Math.sin(p1) * Math.sin(p2));
		return { lat: (p2 * 180) / Math.PI, lon: ((((l2 * 180) / Math.PI + 540) % 360) - 180) };
	}

	it('boxAround contains every point of the circle (CODEX1 F2)', () => {
		const cases: [number, number, number][] = [
			[66, 13, 50],
			[66.0217, 12.6316, 150],
			[0, 0, 50],
			[-70, 40, 50],
			[80, 20, 150],
			[89.8, 0, 50],
			[60, 179.9, 50],
			[60, -179.9, 50]
		];
		for (const [lat, lon, km] of cases) {
			const b = boxAround(lat, lon, km);
			for (let deg = 0; deg < 360; deg += 0.25) {
				const d = destination(lat, lon, km * (1 - 1e-9), deg);
				expect(d.lat >= b.minLat && d.lat <= b.maxLat, `${lat},${lon},${km} @${deg} lat`).toBe(true);
				expect(d.lon >= b.minLon && d.lon <= b.maxLon, `${lat},${lon},${km} @${deg} lon`).toBe(true);
			}
		}
		// The reported miss: 49.9995 km from (66, 13), just past the old box.
		expect(boxAround(66, 13, 50).maxLon).toBeGreaterThan(14.105579256256835);
		// Still a box, not the world, away from poles and the dateline.
		expect(boxAround(66, 13, 50).maxLon - 13).toBeLessThan(1.2);
		expect(boxAround(89.8, 0, 50)).toMatchObject({ maxLat: 90, minLon: -180, maxLon: 180 });
		expect(boxAround(60, 179.9, 50)).toMatchObject({ minLon: -180, maxLon: 180 });
	});

	it('monthYearsIn counts whole months inside any window', () => {
		const w = { windowStart: '2024-10-01', windowEnd: '2026-09-30' };
		expect(monthYearsIn([w], 10)).toBe(2);
		expect(monthYearsIn([w], 9)).toBe(2);
		expect(monthYearsIn([w], 1)).toBe(2);
		expect(monthYearsIn([w, { windowStart: '2025-01-01', windowEnd: '2026-12-31' }], 10)).toBe(3);
		expect(monthYearsIn([], 10)).toBe(0);
	});
});

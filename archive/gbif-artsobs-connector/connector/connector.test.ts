/**
 * Norway connector (td-eec7db Phase 2): unit tests on recorded GBIF responses
 * and a fake GBIF built from them. No network, no database.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ContractError } from '$server/external-sources/contract';
import { DEEP_PAGING_LIMIT, GADM_TO_REGION, PAGE_SIZE, REGION_TO_GADM, REGION_NAMES, SEARCH_CAP } from './config';
import { compactRecord } from './records';
import { GbifClient, GbifError, retryAfterMs, type SpeciesInfo } from './gbif';
import { GroupAggregate, buildRegionPayload, normalizeState, placeLocality } from './aggregate';
import { fetchGroup, monthRanges, planGroups } from './fetch';
import { buildChunks, buildManifest, chunkRows } from './payload';
import { IngestCallError, IngestClient, ingestBase, type ClaimedLoad } from './ingest';
import { GroupCache, LoadError, chooseWindow, runLoad } from './run';
import { RECORDED, fakeGbif, gadm, makeRecord } from './fixtures/fake-gbif';
import { GENUS_KEY, GENUS_SPECIES, TODAY, WINDOW, nordlandRecords } from './fixtures/scenario';
import recordedSpecies from './fixtures/species-2498036.json';
import recordedHybrid from './fixtures/species-10728442-hybrid.json';
import recordedFacet from './fixtures/facet-stateProvince-NOR.10_1.json';

const never = new AbortController().signal;
const noSleep = async () => {};

/** A clock that moves only when the client sleeps: a sleep runs until now + ms. */
function fakeClock() {
	const c = { t: 1_800_000_000_000, waits: [] as number[] };
	return {
		c,
		now: () => c.t,
		sleep: async (ms: number) => {
			c.waits.push(ms);
			c.t += ms;
		}
	};
}

function client(records = nordlandRecords(), extra: Parameters<typeof fakeGbif>[0]['intercept'] = undefined) {
	const fake = fakeGbif({ records, species: GENUS_SPECIES, intercept: extra });
	return { fake, gbif: new GbifClient({ fetch: fake.fetch, sleep: noSleep }) };
}

async function nordlandGroups(gbif: GbifClient, opts = {}): Promise<GroupAggregate[]> {
	const groups = await planGroups(gbif, 'NO-18', WINDOW, never);
	const out: GroupAggregate[] = [];
	for (const g of groups) out.push(await fetchGroup(gbif, g, WINDOW, { pagesDone: 0, pagesTotal: 0 }, never, opts));
	return out;
}

async function speciesFor(gbif: GbifClient, aggs: GroupAggregate[]): Promise<Map<number, SpeciesInfo>> {
	const m = new Map<number, SpeciesInfo>();
	for (const a of aggs) for (const k of a.speciesKeys) m.set(k, await gbif.speciesInfo(k, never));
	return m;
}

describe('config', () => {
	it('the GADM county map matches the seed in migration 0092 exactly', () => {
		const sql = readFileSync('backend/db/migrations/0092_external_sources.sql', 'utf8');
		const seeded = Object.fromEntries([...sql.matchAll(/\('artsobs-gbif', '(NOR\.\d+_1)', '(NO-\d+)'\)/g)].map((m) => [m[1], m[2]]));
		expect(seeded).toEqual(GADM_TO_REGION);
		expect(Object.keys(REGION_TO_GADM).sort()).toEqual(Object.keys(REGION_NAMES).sort());
	});
	it('every page of a slice ends within the first 10,000 results (deeper pages stall on GBIF)', () => {
		const lastOffset = (Math.ceil(SEARCH_CAP / PAGE_SIZE) - 1) * PAGE_SIZE;
		expect(lastOffset + PAGE_SIZE).toBeLessThanOrEqual(DEEP_PAGING_LIMIT);
	});
});

describe('records (recorded GBIF responses)', () => {
	it('reads every recorded record and never an observer', () => {
		const out = RECORDED.map(compactRecord);
		expect(out.every((r) => typeof r === 'object')).toBe(true);
		const [goose, , , , redshank, , aves, merg] = out as Exclude<ReturnType<typeof compactRecord>, string>[];
		expect(goose).toMatchObject({ speciesKey: 2498036, date: '2025-06-08', month: 6, municipality: 'Bodø', gid: 'NOR.10_1', uncertainty: 100, count: 12, catalogNumber: '37607886' });
		expect(redshank.gid).toBeNull();
		expect(aves.speciesKey).toBeNull();
		expect(merg).toMatchObject({ gid: null, municipality: 'Alstahaug', date: '2026-01-03' });
		for (const r of out) expect(JSON.stringify(r)).not.toMatch(/recordedBy|observer/i);
	});

	it('skips records without a key, a date or a 2024 county; reads an interval by its first day', () => {
		expect(compactRecord({ ...RECORDED[0], key: undefined })).toBe('no_key');
		expect(compactRecord({ ...RECORDED[0], eventDate: '2025' })).toBe('undated');
		expect(compactRecord({ ...RECORDED[0], eventDate: '2025-02-30' })).toBe('undated');
		expect(compactRecord({ ...RECORDED[0], stateProvince: '  ' })).toBe('no_state');
		expect(compactRecord({ ...RECORDED[0], eventDate: '2025-06-01/2025-06-03' })).toMatchObject({ date: '2025-06-01' });
	});

	it('keeps uncertainty null (never 0) and drops half a coordinate', () => {
		expect(compactRecord({ ...RECORDED[0], coordinateUncertaintyInMeters: undefined })).toMatchObject({ uncertainty: null });
		expect(compactRecord({ ...RECORDED[0], decimalLongitude: null })).toMatchObject({ lat: null, lon: null });
	});

	it('a hybrid GBIF files at rank SPECIES is not a species (recorded 2026-10-23, 767 Norwegian records)', async () => {
		const gbif = new GbifClient({ fetch: async () => Response.json(recordedHybrid), sleep: noSleep });
		expect(await gbif.speciesInfo(10728442, never)).toEqual({
			key: 10728442,
			canonicalName: 'Mareca penelope x Anas platyrhynchos',
			scientificName: 'Mareca penelope x Anas platyrhynchos',
			rank: 'HYBRID'
		});
		const plain = new GbifClient({ fetch: async () => Response.json(recordedSpecies), sleep: noSleep });
		expect((await plain.speciesInfo(2498036, never)).rank).toBe('SPECIES');
	});

	it('the recorded species and facet responses have the shapes the client reads', () => {
		expect(recordedSpecies).toMatchObject({ key: 2498036, canonicalName: 'Anser anser', rank: 'SPECIES' });
		expect(recordedFacet.facets[0].counts[0]).toMatchObject({ name: 'Nordland' });
	});
});

describe('GBIF client request policy', () => {
	it('a 429 pauses for at least 15 s (longer if Retry-After says so), then succeeds', async () => {
		let n = 0;
		const clock = fakeClock();
		const gbif = new GbifClient({
			fetch: async () => (++n === 1 ? new Response('', { status: 429, headers: { 'retry-after': '2' } }) : Response.json({ ok: true })),
			sleep: clock.sleep,
			now: clock.now
		});
		expect(await gbif.getJson('x', {}, never)).toEqual({ ok: true });
		expect(n).toBe(2);
		expect(clock.c.waits[0]).toBeGreaterThanOrEqual(14_000);
		expect(clock.c.waits[0]).toBeLessThanOrEqual(16_000);
		expect(gbif.throttles).toBe(1);
		n = 0;
		const slowClock = fakeClock();
		const slow = new GbifClient({
			fetch: async () => (++n === 1 ? new Response('', { status: 429, headers: { 'retry-after': '90' } }) : Response.json({ ok: true })),
			sleep: slowClock.sleep,
			now: slowClock.now
		});
		await slow.getJson('x', {}, never);
		expect(slowClock.c.waits[0]).toBeGreaterThan(88_000);
	});

	it('a 429 pauses every request, and eight in a row fail the load as retryable', async () => {
		let calls = 0;
		const clock = fakeClock();
		const gbif = new GbifClient({
			fetch: async (url) => (calls++, url.includes('first') ? new Response('', { status: 429 }) : Response.json({ ok: true })),
			sleep: clock.sleep,
			now: clock.now
		});
		const first = gbif.getJson('first', {}, never).catch((e) => e);
		await new Promise((r) => setTimeout(r, 5));
		// A request started after the 429 waits out the same pause.
		await gbif.getJson('second', {}, never);
		expect(clock.c.waits.some((w) => w > 10_000)).toBe(true);
		const err = (await first) as GbifError;
		expect(err).toBeInstanceOf(GbifError);
		expect(err.retryable).toBe(true);
		expect(err.message).toMatch(/still throttled after 8 tries/);
		expect(calls).toBe(9);
	});

	it('requests already queued for a slot wait out a 429 too (CODEX1 finding 6)', async () => {
		const clock = fakeClock();
		const seen: { path: string; at: number }[] = [];
		let throttledOnce = false;
		const gbif = new GbifClient({
			concurrency: 2,
			sleep: clock.sleep,
			now: clock.now,
			fetch: async (url) => {
				const path = new URL(url).pathname.slice(4);
				seen.push({ path, at: clock.c.t });
				if (path === 'a' && !throttledOnce) {
					throttledOnce = true;
					return new Response('', { status: 429 });
				}
				return Response.json({ ok: path });
			}
		});
		const start = clock.c.t;
		await Promise.all(['a', 'b', 'c', 'd', 'e'].map((p) => gbif.getJson(p, {}, never)));
		// a (the 429) and b were in flight together; nothing else starts inside the pause.
		expect(seen.slice(0, 2).map((x) => x.path)).toEqual(['a', 'b']);
		expect(seen.slice(2).every((x) => x.at >= start + 15_000)).toBe(true);
		expect(seen.map((x) => x.path).sort()).toEqual(['a', 'a', 'b', 'c', 'd', 'e']);
	});

	it('a facet answer without its counts fails as retryable, never reads as "no records" (CODEX1 finding 1)', async () => {
		for (const body of [{}, { count: 5, facets: [] }, { count: 5, facets: [{ field: 'STATE_PROVINCE' }] }, { count: 5, facets: [{ field: 'STATE_PROVINCE', counts: [{ name: 'x', count: -1 }] }] }]) {
			const gbif = new GbifClient({ fetch: async () => Response.json(body), sleep: noSleep });
			const err = (await gbif.facet('stateProvince', {}, never).catch((e) => e)) as GbifError;
			expect(err).toBeInstanceOf(GbifError);
			expect(err.retryable).toBe(true);
		}
		// The shape GBIF really sends for no records (checked 2026-10-23).
		const empty = new GbifClient({ fetch: async () => Response.json({ offset: 0, limit: 0, endOfRecords: true, count: 0, results: [], facets: [{ field: 'STATE_PROVINCE', counts: [] }] }), sleep: noSleep });
		expect(await empty.facet('stateProvince', {}, never)).toEqual([]);
	});

	it('gives up after five 5xx answers as retryable; a 400 is final at once', async () => {
		let n = 0;
		const busy = new GbifClient({ fetch: async () => (n++, new Response('', { status: 503 })), sleep: noSleep });
		const err = (await busy.getJson('x', {}, never).catch((e) => e)) as GbifError;
		expect(err).toBeInstanceOf(GbifError);
		expect(err.retryable).toBe(true);
		expect(n).toBe(5);
		n = 0;
		const bad = new GbifClient({ fetch: async () => (n++, new Response('', { status: 400 })), sleep: noSleep });
		const err2 = (await bad.getJson('x', {}, never).catch((e) => e)) as GbifError;
		expect(err2.retryable).toBe(false);
		expect(n).toBe(1);
	});

	it('never has more than two requests in flight', async () => {
		let inFlight = 0;
		let peak = 0;
		const gbif = new GbifClient({
			fetch: async () => {
				peak = Math.max(peak, ++inFlight);
				await new Promise((r) => setTimeout(r, 5));
				inFlight--;
				return Response.json({});
			},
			sleep: noSleep
		});
		await Promise.all(Array.from({ length: 8 }, () => gbif.getJson('x', {}, never)));
		expect(peak).toBe(2);
	});

	it('reads Retry-After as seconds or a date, capped at two minutes', () => {
		expect(retryAfterMs('3')).toBe(3000);
		expect(retryAfterMs('9999')).toBe(120_000);
		expect(retryAfterMs(new Date(1_000_000 + 5000).toUTCString(), 1_000_000)).toBe(5000);
		expect(retryAfterMs(null)).toBeNull();
	});
});

describe('which 2024 counties to read', () => {
	it('spellings group together: GBIF returns some names garbled', () => {
		expect(normalizeState('Trøndelag')).toBe(normalizeState('Tr��ndelag'));
		expect(normalizeState('Østfold')).toBe(normalizeState('��stfold'));
		expect(normalizeState('Møre og Romsdal')).toBe(normalizeState('M��re og Romsdal'));
		expect(normalizeState('Troms')).not.toBe(normalizeState('Trøndelag'));
	});

	it('NO-18 reads Nordland and Troms; Trøndelag has too few records in Nordland to read', async () => {
		const { gbif } = client();
		const groups = await planGroups(gbif, 'NO-18', WINDOW, never);
		expect(groups.map((g) => [g.name, g.inRegion])).toEqual([
			['Nordland', 55],
			['Troms', 51]
		]);
	});

	it('a group carries every spelling, even one with no records in the county', async () => {
		const base = { stateProvince: 'Trøndelag', gadm: gadm('NOR.15_1'), eventDate: '2025-06-01' };
		const records = [
			...Array.from({ length: 60 }, () => makeRecord(RECORDED[1], base)),
			makeRecord(RECORDED[1], { ...base, stateProvince: 'Tr��ndelag', gadm: {} })
		];
		const { gbif } = client(records);
		const [g] = await planGroups(gbif, 'NO-16', WINDOW, never);
		expect(g.name).toBe('Trøndelag');
		expect(g.variants).toEqual(['Trøndelag', 'Tr��ndelag'].sort());
	});

	it('slices are calendar months, clipped to the window', () => {
		expect(monthRanges('2024-10-01', '2024-12-15')).toEqual([
			['2024-10-01', '2024-10-31'],
			['2024-11-01', '2024-11-30'],
			['2024-12-01', '2024-12-15']
		]);
		expect(monthRanges(WINDOW.start, WINDOW.through)).toHaveLength(25);
	});
});

describe('paging', () => {
	it('splits slices over the cap, pages each one, and counts every record once', async () => {
		const { fake, gbif } = client();
		const aggs = await nordlandGroups(gbif, { pageSize: 2, searchCap: 8 });
		const fetched = fake.records.filter((r) => ['Nordland', 'Troms'].includes(String(r.stateProvince)));
		expect(aggs.reduce((n, a) => n + a.stats.records, 0)).toBe(fetched.length);
		expect(aggs.reduce((n, a) => n + a.stats.duplicates, 0)).toBe(0);
		// Troms' 68 records in October are over the cap of 8, so that month was halved down.
		const tromsOct = fake.calls.filter((u) => u.searchParams.get('stateProvince') === 'Troms' && u.searchParams.get('eventDate')?.startsWith('2025-10'));
		expect(new Set(tromsOct.map((u) => u.searchParams.get('eventDate'))).size).toBeGreaterThan(3);
		expect(fake.calls.some((u) => Number(u.searchParams.get('offset')) > 0)).toBe(true);
	});

	it('a slice that changes while read is read again from scratch; a deleted record is not counted (CODEX1 finding 2)', async () => {
		let deleted: unknown = null;
		const { fake, gbif } = client(undefined, (url) => {
			// While June 2025's second page is read, GBIF drops a record it had
			// listed on page one.
			if (!deleted && url.searchParams.get('stateProvince') === 'Nordland' && url.searchParams.get('eventDate') === '2025-06-01,2025-06-30' && url.searchParams.get('offset') === '2') {
				const june = fake.records.filter((r) => r.stateProvince === 'Nordland' && String(r.eventDate).startsWith('2025-06')).sort((a, b) => Number(a.key) - Number(b.key));
				deleted = june[0];
				fake.records.splice(fake.records.indexOf(june[0]), 1);
			}
			return null;
		});
		const before = fake.records.filter((r) => r.stateProvince === 'Nordland').length;
		const aggs = await nordlandGroups(gbif, { pageSize: 2, searchCap: 1000, concurrency: 1 });
		expect(deleted).not.toBeNull();
		const nordland = aggs.find((a) => a.name === 'Nordland')!;
		expect(nordland.stats.records).toBe(before - 1);
		expect(nordland.stats.duplicates).toBe(0); // the bad read was never counted
		const juneFirstPages = fake.calls.filter(
			(u) => u.searchParams.get('eventDate') === '2025-06-01,2025-06-30' && u.searchParams.get('stateProvince') === 'Nordland' && u.searchParams.get('offset') === '0' && u.searchParams.get('limit') !== '0'
		);
		expect(juneFirstPages).toHaveLength(2);
	});

	it('a record that moves into a slice already read sends the whole group round again (CODEX1 re-review finding 1)', async () => {
		let moved = false;
		const { fake, gbif } = client(undefined, (url) => {
			// While June 2025's second page is read, GBIF moves June's first
			// record to July 1: June reads again without it, and July has
			// already been planned.
			if (!moved && url.searchParams.get('stateProvince') === 'Nordland' && url.searchParams.get('eventDate') === '2025-06-01,2025-06-30' && url.searchParams.get('offset') === '2') {
				moved = true;
				const june = fake.records.filter((r) => r.stateProvince === 'Nordland' && String(r.eventDate).startsWith('2025-06')).sort((a, b) => Number(a.key) - Number(b.key));
				Object.assign(june[0], { eventDate: '2025-07-01', year: 2025, month: 7, day: 1 });
			}
			return null;
		});
		const total = fake.records.filter((r) => r.stateProvince === 'Nordland').length;
		const aggs = await nordlandGroups(gbif, { pageSize: 2, searchCap: 1000, concurrency: 1 });
		expect(moved).toBe(true);
		const nordland = aggs.find((a) => a.name === 'Nordland')!;
		expect(nordland.stats.records).toBe(total);
		expect(nordland.stats.duplicates).toBe(0);
		// The recheck asks each slice for its count alone.
		expect(fake.calls.some((u) => u.searchParams.get('limit') === '0' && !u.searchParams.has('facet'))).toBe(true);
	});

	it('records that swap slices without changing any count send the group round again (CODEX1 round 3)', async () => {
		const records = nordlandRecords();
		const nordlandIn = (month: string) => records.filter((r) => r.stateProvince === 'Nordland' && String(r.eventDate).startsWith(month));
		// Two months with no Nordland records, so their pages hold only A–D.
		const ranges = monthRanges(WINDOW.start, WINDOW.end).map(([f]) => f.slice(0, 7));
		const i = ranges.findIndex((m, k) => k + 1 < ranges.length && nordlandIn(m).length === 0 && nordlandIn(ranges[k + 1]).length === 0);
		const [x, y] = [ranges[i], ranges[i + 1]];
		const base = records.find((r) => r.stateProvince === 'Nordland')!;
		// Keys ascend A < B < C < D: A, B in month x; C, D in month y.
		const [A, B, C, D] = [`${x}-05`, `${x}-06`, `${y}-05`, `${y}-06`].map((eventDate) => makeRecord(base, { eventDate }));
		records.push(A, B, C, D);
		let swapped = false;
		const { fake, gbif } = client(records, (url) => {
			// While month y's second page is read, B moves into y and D into x:
			// both months still hold two records.
			if (!swapped && url.searchParams.get('stateProvince') === 'Nordland' && url.searchParams.get('eventDate')?.startsWith(`${y}-01,`) && url.searchParams.get('offset') === '1') {
				swapped = true;
				B.eventDate = `${y}-04`;
				D.eventDate = `${x}-07`;
			}
			return null;
		});
		const total = fake.records.filter((r) => r.stateProvince === 'Nordland').length;
		const aggs = await nordlandGroups(gbif, { pageSize: 1, searchCap: 1000, concurrency: 1 });
		expect(swapped).toBe(true);
		const nordland = aggs.find((a) => a.name === 'Nordland')!;
		expect(nordland.stats.records).toBe(total);
		expect(nordland.stats.duplicates).toBe(0);
	});

	/** Two consecutive months with no Nordland records in the scenario. */
	function emptyMonths(records: ReturnType<typeof nordlandRecords>): [string, string] {
		const has = (m: string) => records.some((r) => r.stateProvince === 'Nordland' && String(r.eventDate).startsWith(m));
		const months = monthRanges(WINDOW.start, WINDOW.end).map(([f]) => f.slice(0, 7));
		const i = months.findIndex((m, k) => k + 1 < months.length && !has(m) && !has(months[k + 1]));
		return [months[i], months[i + 1]];
	}
	const firstPages = (fake: ReturnType<typeof client>['fake'], month: string) =>
		fake.calls.filter((u) => u.searchParams.get('stateProvince') === 'Nordland' && u.searchParams.get('eventDate')?.startsWith(`${month}-01,`) && u.searchParams.get('offset') === '0' && u.searchParams.get('limit') !== '0').length;

	it('a record dated across two months matches both slices: it counts once, on its first day, with no re-read', async () => {
		const records = nordlandRecords();
		const [x, y] = emptyMonths(records);
		const base = records.find((r) => r.stateProvince === 'Nordland')!;
		records.push(makeRecord(base, { eventDate: `${x}-27/${y}-02` }));
		const { fake, gbif } = client(records);
		const total = records.filter((r) => r.stateProvince === 'Nordland').length;
		const nordland = (await nordlandGroups(gbif, { pageSize: 1, searchCap: 1000, concurrency: 1 })).find((a) => a.name === 'Nordland')!;
		expect(nordland.stats.records).toBe(total);
		expect(nordland.stats.duplicates).toBe(1);
		expect(firstPages(fake, x)).toBe(1); // one round, no re-read
		expect(compactRecord({ ...RECORDED[0], eventDate: `${x}-27/${y}-02` })).toMatchObject({ date: `${x}-27`, range: `${x}-27/${y}-02` });
		expect(compactRecord({ ...RECORDED[0], eventDate: '2025-06-30' })).toMatchObject({ range: null });
	});

	it('interval records that swap slices are moves too: the group is read again (CODEX1 round 4)', async () => {
		const records = nordlandRecords();
		const [x, y] = emptyMonths(records);
		const base = records.find((r) => r.stateProvince === 'Nordland')!;
		// Keys ascend A < B < C < D: A, B in month x; C, D in month y.
		const [A, B, C, D] = [`${x}-05/${x}-06`, `${x}-07/${x}-08`, `${y}-05/${y}-06`, `${y}-07/${y}-08`].map((eventDate) => makeRecord(base, { eventDate }));
		records.push(A, B, C, D);
		let swapped = false;
		const { fake, gbif } = client(records, (url) => {
			if (!swapped && url.searchParams.get('stateProvince') === 'Nordland' && url.searchParams.get('eventDate')?.startsWith(`${y}-01,`) && url.searchParams.get('offset') === '1') {
				swapped = true;
				B.eventDate = `${y}-04/${y}-05`;
				D.eventDate = `${x}-09/${x}-10`;
			}
			return null;
		});
		const total = records.filter((r) => r.stateProvince === 'Nordland').length;
		const nordland = (await nordlandGroups(gbif, { pageSize: 1, searchCap: 1000, concurrency: 1 })).find((a) => a.name === 'Nordland')!;
		expect(swapped).toBe(true);
		expect(nordland.stats.records).toBe(total);
		expect(nordland.stats.duplicates).toBe(0);
		expect(firstPages(fake, x)).toBe(2); // read again
	});

	it('an unchanged interval that swaps spellings is a move too: the group is read again (CODEX1 round 5)', async () => {
		const records = nordlandRecords();
		const [x] = emptyMonths(records);
		const base = records.find((r) => r.stateProvince === 'Nordland')!;
		const garbled = 'Nordl\uFFFD\uFFFDnd';
		const span = `${x}-05/${x}-06`;
		// Keys ascend A < B < C < D; A, B spelled one way, C, D the other.
		const [A, B, C, D] = ['Nordland', 'Nordland', garbled, garbled].map((stateProvince) => makeRecord(base, { eventDate: span, stateProvince }));
		records.push(A, B, C, D);
		let swapped = false;
		const { fake, gbif } = client(records, (url) => {
			if (!swapped && url.searchParams.get('stateProvince') === garbled && url.searchParams.get('eventDate')?.startsWith(`${x}-01,`) && url.searchParams.get('offset') === '1') {
				swapped = true;
				B.stateProvince = garbled;
				D.stateProvince = 'Nordland';
			}
			return null;
		});
		const group = { name: 'Nordland', variants: ['Nordland', garbled].sort(), inRegion: 100 };
		const total = records.filter((r) => r.stateProvince === 'Nordland' || r.stateProvince === garbled).length;
		const agg = await fetchGroup(gbif, group, WINDOW, { pagesDone: 0, pagesTotal: 0 }, never, { pageSize: 1, searchCap: 1000, concurrency: 1 });
		expect(swapped).toBe(true);
		expect(agg.stats.records).toBe(total);
		expect(agg.stats.duplicates).toBe(0);
		expect(firstPages(fake, x)).toBe(2); // the Nordland spelling read again
	});

	it('a group that keeps changing after its reads fails as retryable', async () => {
		let reads = 0;
		const { fake, gbif } = client(undefined, (url) => {
			// Each count-only recheck of May 2025 finds one more record.
			if (url.searchParams.get('stateProvince') === 'Nordland' && url.searchParams.get('eventDate') === '2025-05-01,2025-05-31' && url.searchParams.get('limit') === '0') {
				reads++;
				return Response.json({ offset: 0, limit: 0, endOfRecords: true, count: 999 + reads, results: [] });
			}
			return null;
		});
		const err = (await nordlandGroups(gbif, { searchCap: 1000 }).catch((e) => e)) as GbifError;
		expect(err).toBeInstanceOf(GbifError);
		expect(err.retryable).toBe(true);
		expect(err.message).toMatch(/kept changing while reading Nordland \(1 slices changed after they were read, e\.g\. Nordland 2025-05-01/);
		expect(reads).toBe(3);
		expect(fake.calls.length).toBeGreaterThan(0);
	});

	it('a slice that grows past the cap while read is split again, never paged past it (CODEX1 finding 7)', async () => {
		const records = nordlandRecords();
		const ranges = monthRanges(WINDOW.start, WINDOW.through);
		const inMonth = (from: string, to: string) => records.filter((r) => r.stateProvince === 'Nordland' && String(r.eventDate).slice(0, 10) >= from && String(r.eventDate).slice(0, 10) <= to);
		const [from, to] = ranges.find(([f, t]) => inMonth(f, t).length >= 3 && inMonth(f, t).length <= 8)!;
		const base = inMonth(from, to)[0];
		let grown = false;
		const { fake, gbif } = client(records, (url) => {
			if (!grown && url.searchParams.get('stateProvince') === 'Nordland' && url.searchParams.get('eventDate') === `${from},${to}` && url.searchParams.get('offset') === '2') {
				grown = true;
				const days = Number(to.slice(8));
				for (let i = 0; i < 10; i++) fake.records.push(makeRecord(base, { eventDate: `${from.slice(0, 8)}${String((i % days) + 1).padStart(2, '0')}` }));
			}
			return null;
		});
		const aggs = await nordlandGroups(gbif, { pageSize: 2, searchCap: 8, concurrency: 1 });
		expect(grown).toBe(true);
		expect(fake.calls.every((u) => !u.searchParams.has('offset') || Number(u.searchParams.get('offset')) + 2 <= 8)).toBe(true);
		expect(aggs.find((a) => a.name === 'Nordland')!.stats.records).toBe(fake.records.filter((r) => r.stateProvince === 'Nordland').length);
	});

	it('fails as retryable when GBIF never returns a slice whole', async () => {
		const { gbif } = client(undefined, (url) =>
			url.searchParams.get('eventDate') === '2025-06-01,2025-06-30' && url.searchParams.get('offset') === '2'
				? Response.json({ offset: 2, limit: 2, endOfRecords: false, count: 99, results: [] })
				: null
		);
		const err = await nordlandGroups(gbif, { pageSize: 2, searchCap: 1000 }).catch((e) => e);
		expect(err).toBeInstanceOf(GbifError);
		expect(err.retryable).toBe(true);
		expect(err.message).toMatch(/kept changing/);
		expect(err.message).toMatch(/2025-06-01/);
	});
});

describe('counting and placing (NO-18)', () => {
	async function payload() {
		const { gbif } = client();
		const aggs = await nordlandGroups(gbif);
		return buildRegionPayload(aggs, 'NO-18', await speciesFor(gbif, aggs));
	}
	const total = (p: Awaited<ReturnType<typeof payload>>, place: string) =>
		p.totals.filter((t) => t.place_key === place).reduce((n, t) => n + t.reports, 0);

	it('places by GADM first, then by the municipality majority; offshore records are unplaced', async () => {
		const p = await payload();
		expect(p.stats).toMatchObject({ records: 107, unkeyed: 2, placedByMunicipality: 3, unplaced: 1 });
		expect(p.places.map((x) => x.place_key)).toEqual([
			'NO-18',
			'NO-18:Alstahaug',
			'NO-18:Bodø',
			'NO-18:Evenes',
			'NO-18:Herøy',
			'NO-18:Herøy (Troms)',
			'NO-18:Narvik',
			'NO-18:Rana'
		]);
		expect(total(p, 'NO-18')).toBe(107);
		expect(total(p, 'NO-18:Bodø')).toBe(5);
		expect(total(p, 'NO-18:Narvik')).toBe(4); // the fifth lies in Troms' polygon
		expect(total(p, 'NO-18:Rana')).toBe(44); // one placed by municipality
		expect(total(p, 'NO-18:Alstahaug')).toBe(2);
		expect(total(p, 'NO-18:Evenes')).toBe(50);
		const d = (code: string) => p.diagnostics.filter((x) => x.code === code);
		expect(d('unplaced_records')).toEqual([{ code: 'unplaced_records', detail: 'Nordland: Norskekysten hav S', count: 1 }]);
		expect(d('split_municipality').map((x) => x.detail).sort()).toEqual(['Evenes: NO-18 50, NO-19 10', 'Narvik: NO-18 4, NO-19 1']);
		expect(d('municipality_name_clash')[0].detail).toBe('Herøy: Nordland and Troms');
		expect(d('non_species_taxon')[0]).toMatchObject({ detail: `GBIF key ${GENUS_KEY} Turdus (GENUS)`, count: 1 });
		expect(d('no_uncertainty')[0].count).toBe(1);
		expect(d('generalized_coordinates')[0].count).toBe(1);
		expect(d('placed_by_municipality')[0].count).toBe(3);
	});

	it('species plus unkeyed equal every total exactly, and a total exists for every place × month', async () => {
		const p = await payload();
		for (const t of p.totals) {
			const species = p.taxon_month.filter((x) => x.place_key === t.place_key && x.month === t.month).reduce((n, x) => n + x.reports, 0);
			expect(species + t.unkeyed).toBe(t.reports);
		}
		expect(p.totals).toHaveLength(p.places.length * 12);
		expect(p.taxon_month.find((x) => x.upstream_taxon_id === String(GENUS_KEY))).toBeUndefined();
		expect(p.taxon_month.find((x) => x.place_key === 'NO-18' && x.upstream_taxon_id === '2490737' && x.month === 10)).toMatchObject({
			canonical_name: 'Turdus pilaris',
			raw_name: 'Turdus pilaris Linnaeus, 1758',
			reports: 51
		});
	});

	it('recent reports are the 14 days up to the newest, species only, newest first, never with an observer', async () => {
		const p = await payload();
		expect(p.recent.map((r) => r.observed_on)).toEqual(['2026-10-08', '2026-10-01']);
		expect(p.stats).toMatchObject({ recentFrom: '2026-09-25', recentTo: '2026-10-08' });
		expect(p.recent[0]).toMatchObject({ place_key: 'NO-18:Bodø', canonical_name: 'Anser anser', observer: null, generalized: false });
		expect(p.recent[0].record_url).toMatch(/^https:\/\/www\.artsobservasjoner\.no\/Sighting\/\d+$/);
	});

	it('a species reported only after the window still gets its recent report, and anchors the 14 days', async () => {
		const records = nordlandRecords();
		const goose = records.find((r) => r.species === 'Anser anser' && String(r.eventDate).startsWith('2026-10-08'))!;
		records.push(makeRecord(goose, { speciesKey: 2_490_266, taxonKey: 2_490_266, species: 'Cygnus cygnus', scientificName: 'Cygnus cygnus (Linnaeus, 1758)', eventDate: '2026-10-20' }));
		const { gbif } = client(records);
		const aggs = await nordlandGroups(gbif);
		const p = buildRegionPayload(aggs, 'NO-18', await speciesFor(gbif, aggs));
		expect(p.recent.map((r) => [r.observed_on, r.canonical_name])).toEqual([
			['2026-10-20', 'Cygnus cygnus'],
			['2026-10-08', 'Anser anser']
		]);
		expect(p.stats).toMatchObject({ recentFrom: '2026-10-07', recentTo: '2026-10-20' });
		expect(p.taxon_month.some((x) => x.canonical_name === 'Cygnus cygnus')).toBe(false); // after the window: recent only
	});

	it('a locality pin needs 90% of all its reports near the median: missing coordinates or uncertainty never count for it', () => {
		const at = (k: number) => Array.from({ length: k }, () => 60);
		expect(placeLocality({ n: 100, lat: [60], lon: [10], unc: [10] })).toEqual({ lat: null, lon: null, uncertainty_m: 10, placement: 'text' });
		expect(placeLocality({ n: 10, lat: at(9), lon: at(9).map(() => 10), unc: at(9).map(() => 10) }).placement).toBe('pin');
		expect(placeLocality({ n: 10, lat: at(8), lon: at(8).map(() => 10), unc: at(8).map(() => 10) }).placement).toBe('text');
		// Coordinates all agree, but most records have no uncertainty.
		expect(placeLocality({ n: 10, lat: at(10), lon: at(10).map(() => 10), unc: [10, 10, 10, 10] }).placement).toBe('text');
	});

	it('a locality with hundreds of thousands of reports across buckets merges without overflowing (CODEX1 finding 8)', () => {
		const agg = new GroupAggregate('Nordland', ['Nordland'], WINDOW);
		for (let i = 0; i < 300_000; i++) {
			agg.add({
				key: i + 1,
				speciesKey: null,
				date: '2025-06-01',
				month: 6,
				stateProvince: 'Nordland',
				municipality: 'Bodø',
				gid: i % 2 ? 'NOR.10_1' : null,
				locality: 'Bodø havn',
				lat: 67.28,
				lon: 14.4,
				uncertainty: 10,
				count: 1,
				catalogNumber: null,
				generalized: false,
				withheld: false,
				range: null
			});
		}
		const p = buildRegionPayload([agg.sealed()], 'NO-18', new Map());
		expect(p.localities[0]).toMatchObject({ place_key: 'NO-18:Bodø', locality: 'Bodø havn', reports: 300_000, placement: 'pin' });
	});

	it('localities rank by reports and get a pin only under the Phase 0 rule', async () => {
		const p = await payload();
		const bodo = p.localities.filter((l) => l.place_key === 'NO-18:Bodø');
		expect(bodo[0]).toMatchObject({ rank: 1, locality: 'Seinesodden, Bodø, No', reports: 4, placement: 'pin', lat: 67.20749, uncertainty_m: 100 });
		expect(p.localities.every((l) => l.place_key !== 'NO-18')).toBe(true);
		expect(placeLocality({ n: 3, lat: [60, 60.05, 60.1], lon: [10, 10, 10], unc: [10, 10, 10] }).placement).toBe('text');
		expect(placeLocality({ n: 2, lat: [60, 60], lon: [10, 10], unc: [5000, 5000] })).toEqual({ lat: null, lon: null, uncertainty_m: 5000, placement: 'text' });
		expect(placeLocality({ n: 2, lat: [60, 60], lon: [10, 10], unc: [] })).toEqual({ lat: null, lon: null, uncertainty_m: null, placement: 'text' });
	});

	it('rows pass the app contract validator and chunk under the byte target', async () => {
		const p = await payload();
		const chunks = buildChunks('NO-18', p);
		expect(chunks.map((c) => c.kind)).toEqual(['places', 'totals', 'taxon_month', 'localities', 'recent', 'diagnostics']);
		const m = buildManifest(p, chunks, { window_start: WINDOW.start, window_end: WINDOW.end, retrieved_at: TODAY.toISOString(), source_snapshot: {}, filter_fingerprint: 'a'.repeat(64) });
		expect(m.counts.totals).toBe(p.totals.length);
		expect(m.places).toContain('NO-18');
		const small = chunkRows('totals', p.totals, 400);
		expect(small.length).toBeGreaterThan(3);
		expect(small.reduce((n, c) => n + c.rows, 0)).toBe(p.totals.length);
		expect(small.map((c) => c.chunk_id).slice(0, 2)).toEqual(['totals-1', 'totals-2']);
		expect(() => buildChunks('NO-18', { ...p, places: [{ ...p.places[0], place_key: 'NO-19' }] })).toThrow(ContractError);
	});
});

describe('the window', () => {
	const load = { window_months: 24, window_ends: ['2026-09-30', '2026-08-31'] };
	it('ends with the last complete month before GBIF’s latest good copy', () => {
		expect(chooseWindow(load, { crawledAt: '2026-10-11T03:35:31.197Z', pubDate: null }, '2026-10-23')).toEqual(WINDOW);
	});
	it('a load queued on Oct 31 and claimed after a Nov 1 copy keeps its frozen window', () => {
		expect(chooseWindow(load, { crawledAt: '2026-11-01T03:00:00Z', pubDate: null }, '2026-11-03').end).toBe('2026-09-30');
	});
	it('early in a month, before GBIF has copied it, the month before last is used', () => {
		expect(chooseWindow(load, { crawledAt: '2026-09-27T03:00:00Z', pubDate: null }, '2026-10-02').end).toBe('2026-08-31');
	});
	it('a copy too old for either end fails without a retry', () => {
		const err = (() => {
			try {
				chooseWindow(load, { crawledAt: '2026-08-15T03:00:00Z', pubDate: null }, '2026-10-02');
			} catch (e) {
				return e;
			}
		})();
		expect(err).toBeInstanceOf(LoadError);
		expect((err as LoadError).retryable).toBe(false);
	});
});

describe('ingest client', () => {
	const TOKEN = 'ext_' + 'A'.repeat(43);
	const base = ingestBase('http://127.0.0.1:3003/api/ingest/')!;

	it('accepts only an …/api/ingest/ base without credentials', () => {
		expect(ingestBase('http://127.0.0.1:3003/api/ingest/')).not.toBeNull();
		expect(ingestBase('http://127.0.0.1:3003/api/ingest')).toBeNull();
		expect(ingestBase('http://u:p@127.0.0.1/api/ingest/')).toBeNull();
		expect(ingestBase('ftp://127.0.0.1/api/ingest/')).toBeNull();
		expect(ingestBase(undefined)).toBeNull();
	});

	it('never sends the token outside the ingest path, and never follows a redirect', async () => {
		const seen: { url: string; redirect?: RequestRedirect }[] = [];
		const c = new IngestClient(base, TOKEN, {
			fetch: async (url, init) => {
				seen.push({ url, redirect: init?.redirect });
				return new Response(null, { status: 302, headers: { location: 'https://evil.example/' } });
			},
			sleep: noSleep
		});
		await expect(c.post('../admin', {}, never)).rejects.toMatchObject({ code: 'origin' });
		await expect(c.post('https://evil.example/api/ingest/x', {}, never)).rejects.toMatchObject({ code: 'origin' });
		expect(seen).toEqual([]);
		const err = await c.post('loads/claim', {}, never).catch((e) => e);
		expect(err).toMatchObject({ code: 'redirect' });
		expect(seen).toEqual([{ url: 'http://127.0.0.1:3003/api/ingest/loads/claim', redirect: 'manual' }]);
		expect(String(err.message)).not.toContain(TOKEN);
	});

	it('retries 503 and network errors, returns null for 204, and classifies lease loss', async () => {
		let n = 0;
		const c = new IngestClient(base, TOKEN, {
			fetch: async () => {
				n++;
				if (n === 1) throw new TypeError('fetch failed');
				if (n === 2) return new Response('{}', { status: 503 });
				return new Response(null, { status: 204 });
			},
			sleep: noSleep
		});
		expect(await c.claim('claim-key-1', never)).toBeNull();
		expect(n).toBe(3);
		expect(new IngestCallError('x', 409, 'lease_expired').leaseLost).toBe(true);
		expect(new IngestCallError('x', 409, 'chunk_conflict').leaseLost).toBe(false);
		expect(new IngestCallError('x', 401, 'revoked').leaseLost).toBe(true);
		expect(new IngestCallError('x', 422, 'invalid').retryable).toBe(false);
	});
});

describe('one load (fake app)', () => {
	const LOAD: ClaimedLoad = {
		id: '00000000-0000-4000-8000-000000000001',
		region_code: 'NO-18',
		attempt: 1,
		lease_token: '00000000-0000-4000-8000-000000000002',
		lease_expires_at: '2026-10-23T13:00:00Z',
		window_months: 24,
		window_ends: ['2026-09-30', '2026-08-31']
	};
	function fakeApp(answer: (path: string, body: Record<string, unknown>) => Response | null = () => null) {
		const calls: { path: string; body: Record<string, unknown> }[] = [];
		const ingest = new IngestClient(ingestBase('http://app.test/api/ingest/')!, 'ext_' + 'B'.repeat(43), {
			sleep: noSleep,
			fetch: async (url, init) => {
				const path = new URL(url).pathname.replace('/api/ingest/', '');
				const body = JSON.parse(String(init?.body));
				calls.push({ path, body });
				const forced = answer(path, body);
				if (forced) return forced;
				if (path.endsWith('/finish')) return Response.json({ status: 'done', result: { ok: true } });
				return Response.json({ status: 'stored', lease_expires_at: 'x' });
			}
		});
		return { ingest, calls };
	}

	it('sends every chunk and a manifest that adds up, then finishes', async () => {
		const { gbif } = client();
		const { ingest, calls } = fakeApp();
		const logs: string[] = [];
		const out = await runLoad({ gbif, ingest, cache: new GroupCache(), log: (e) => void logs.push(e), now: () => TODAY }, LOAD, never);
		expect(out).toBe('done');
		const chunks = calls.filter((c) => c.path.endsWith('/chunks'));
		const finish = calls.find((c) => c.path.endsWith('/finish'))!.body.manifest as { chunks: { chunk_id: string }[]; window_end: string; source_snapshot: Record<string, unknown> };
		expect(finish.chunks.map((c) => c.chunk_id)).toEqual(chunks.map((c) => c.body.chunk_id));
		expect(finish.window_end).toBe('2026-09-30');
		expect(finish.source_snapshot).toMatchObject({ crawled_at: '2026-10-11T03:35:31.197Z' });
		expect(calls.every((c) => c.body.lease_token === LOAD.lease_token && c.body.attempt === 1)).toBe(true);
		expect(calls.some((c) => c.path.endsWith('/heartbeat'))).toBe(true);
		expect(logs).toContain('load_done');
	});

	it('a second county load within a day reuses the counted 2024 counties', async () => {
		const { fake, gbif } = client();
		const cache = new GroupCache();
		await runLoad({ gbif, ingest: fakeApp().ingest, cache, log: () => {}, now: () => TODAY }, LOAD, never);
		const searches = fake.calls.filter((u) => u.pathname.endsWith('/occurrence/search') && !u.searchParams.has('facet')).length;
		await runLoad({ gbif, ingest: fakeApp().ingest, cache, log: () => {}, now: () => TODAY }, LOAD, never);
		expect(fake.calls.filter((u) => u.pathname.endsWith('/occurrence/search') && !u.searchParams.has('facet')).length).toBe(searches);
		expect(cache.size).toBe(2);
	});

	it('a lost lease stops the load without calling fail', async () => {
		const { gbif } = client();
		const { ingest, calls } = fakeApp((path) => (path.endsWith('/heartbeat') ? Response.json({ error: 'lease_expired', message: 'x' }, { status: 409 }) : null));
		expect(await runLoad({ gbif, ingest, cache: new GroupCache(), log: () => {}, now: () => TODAY }, LOAD, never)).toBe('lease_lost');
		expect(calls.some((c) => c.path.endsWith('/fail') || c.path.endsWith('/chunks'))).toBe(false);
	});

	it('GBIF down: the load fails as retryable; stopped: it goes back to the queue', async () => {
		const down = new GbifClient({ fetch: async () => new Response('', { status: 503 }), sleep: noSleep });
		const a = fakeApp();
		expect(await runLoad({ gbif: down, ingest: a.ingest, cache: new GroupCache(), log: () => {}, now: () => TODAY }, LOAD, never)).toBe('failed');
		expect(a.calls.find((c) => c.path.endsWith('/fail'))!.body).toMatchObject({ retryable: true });

		const stop = new AbortController();
		const { gbif } = client(undefined, () => {
			stop.abort(new Error('shutdown'));
			return null;
		});
		const b = fakeApp();
		expect(await runLoad({ gbif, ingest: b.ingest, cache: new GroupCache(), log: () => {}, now: () => TODAY }, LOAD, stop.signal)).toBe('stopped');
		expect(b.calls.find((c) => c.path.endsWith('/fail'))!.body).toMatchObject({ retryable: true, reason: expect.stringMatching(/back to the queue/) });
	});

	it('a broken facet answer or a county GBIF has nothing for never publishes zeros (CODEX1 finding 1)', async () => {
		const { gbif } = client(undefined, (url) => (url.searchParams.has('facet') ? Response.json({}) : null));
		const a = fakeApp();
		expect(await runLoad({ gbif, ingest: a.ingest, cache: new GroupCache(), log: () => {}, now: () => TODAY }, LOAD, never)).toBe('failed');
		expect(a.calls.find((c) => c.path.endsWith('/fail'))!.body).toMatchObject({ retryable: true });
		expect(a.calls.some((c) => c.path.endsWith('/chunks') || c.path.endsWith('/finish'))).toBe(false);

		const empty = client([]);
		const b = fakeApp();
		expect(await runLoad({ gbif: empty.gbif, ingest: b.ingest, cache: new GroupCache(), log: () => {}, now: () => TODAY }, LOAD, never)).toBe('failed');
		expect(b.calls.find((c) => c.path.endsWith('/fail'))!.body).toMatchObject({ retryable: false, reason: expect.stringMatching(/no 2024 county/) });
		expect(b.calls.some((c) => c.path.endsWith('/chunks') || c.path.endsWith('/finish'))).toBe(false);
	});

	it('a record that moved between 2024 counties mid-load fails it as retryable and drops the cached counts (CODEX1 finding 3)', async () => {
		const records = nordlandRecords();
		const moved = records.find((r) => r.stateProvince === 'Nordland')!;
		records.push({ ...structuredClone(moved), stateProvince: 'Troms' });
		const { gbif } = client(records);
		const cache = new GroupCache();
		const a = fakeApp();
		expect(await runLoad({ gbif, ingest: a.ingest, cache, log: () => {}, now: () => TODAY }, LOAD, never)).toBe('failed');
		expect(a.calls.find((c) => c.path.endsWith('/fail'))!.body).toMatchObject({ retryable: true, reason: expect.stringMatching(/1 records moved between Nordland and Troms/) });
		expect(a.calls.some((c) => c.path.endsWith('/finish'))).toBe(false);
		expect(cache.size).toBe(0);
	});

	it('a species lookup that fails stops the other lookups instead of leaving them queued at GBIF (CODEX1 finding 9)', async () => {
		let lookups = 0;
		const { gbif } = client(undefined, (url) => {
			if (!url.pathname.includes('/species/')) return null;
			lookups++;
			return lookups === 1 ? Response.json({ error: 'bad' }, { status: 400 }) : null;
		});
		const a = fakeApp();
		expect(await runLoad({ gbif, ingest: a.ingest, cache: new GroupCache(), log: () => {}, now: () => TODAY }, LOAD, never)).toBe('failed');
		await new Promise((r) => setTimeout(r, 20));
		expect(lookups).toBeLessThanOrEqual(2); // the failed one and at most the one beside it
		expect(a.calls.find((c) => c.path.endsWith('/fail'))!.body).toMatchObject({ retryable: false });
	});

	it('the first failure aborts a request still running beside it (CODEX1 re-review finding 2)', async () => {
		const fake = fakeGbif({ records: nordlandRecords(), species: GENUS_SPECIES });
		let lookups = 0;
		let peerAborted = false;
		const gbif = new GbifClient({
			sleep: noSleep,
			fetch: async (url, init) => {
				if (!url.includes('/species/')) return fake.fetch(url, init);
				lookups++;
				if (lookups === 1) return Response.json({ error: 'bad' }, { status: 400 });
				// The peer hangs until it is aborted.
				return new Promise((_, reject) =>
					init!.signal!.addEventListener('abort', () => {
						peerAborted = true;
						reject(init!.signal!.reason);
					})
				);
			}
		});
		const a = fakeApp();
		const run = runLoad({ gbif, ingest: a.ingest, cache: new GroupCache(), log: () => {}, now: () => TODAY }, LOAD, never);
		const out = await Promise.race([run, new Promise((r) => setTimeout(() => r('still running'), 2000))]);
		expect(out).toBe('failed');
		expect(peerAborted).toBe(true);
		expect(a.calls.find((c) => c.path.endsWith('/fail'))!.body).toMatchObject({ retryable: false, reason: expect.stringMatching(/GBIF answered 400/) });
	});

	it('a chunk the app rejects as invalid fails the load without a retry', async () => {
		const { gbif } = client();
		const { ingest, calls } = fakeApp((path) => (path.endsWith('/chunks') ? Response.json({ error: 'invalid', message: 'rows[0]: bad' }, { status: 422 }) : null));
		expect(await runLoad({ gbif, ingest, cache: new GroupCache(), log: () => {}, now: () => TODAY }, LOAD, never)).toBe('failed');
		expect(calls.find((c) => c.path.endsWith('/fail'))!.body).toMatchObject({ retryable: false });
	});
});

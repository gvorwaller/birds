/**
 * Sweden connector (td-99eebf): record mapping, privacy screening, the
 * completeness rules for reading SOS (plan [C1-2]), the load preflight
 * ([C1-3]) and the secrets the connector idles without ([C1-6]).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_FINISH_BODY_BYTES, MAX_LOAD_BYTES, MAX_LOAD_ROWS, validateChunkRows, type RecordRow } from '$server/external-sources/contract';
import { RecordSpool } from '../shared/spool';
import { buildChunks } from '../shared/payload';
import { REGION_NAMES, REGION_TO_COUNTY } from './config';
import { classifyTaxon, compactRecord, modifiedAt, observerNames, recordId, recordIdentity } from './records';
import { SosClient, SosError, sliceFilter } from './sos';
import { readCounty, readSlice, signature } from './fetch';
import { LoadError, checkLimits } from './run';
import { readSettings } from './main';
import { fakeSos, makeSosRecord, type SosCall } from './fixtures/fake-sos';
import { WINDOW, jonkopingRecords } from './fixtures/scenario';
import type { CompactRecord } from '../shared/records';
import { CountyAggregate } from '../shared/aggregate';
import { MAX_RECENT_ROWS } from '../shared/limits';

const sos = (fake: ReturnType<typeof fakeSos>) => new SosClient('k'.repeat(32), { fetch: fake.fetch, sleep: async () => {} });
const compact = (over: Record<string, unknown> = {}) => compactRecord(makeSosRecord(over)) as CompactRecord;

describe('county map', () => {
	it('matches the seed in migration 0103 exactly, every län named', () => {
		const sql = readFileSync('backend/db/migrations/0103_artportalen_source.sql', 'utf8');
		const seeded = Object.fromEntries([...sql.matchAll(/\('artportalen', '(\d+)',\s*'(SE-[A-Z]+)'/g)].map((m) => [m[2], Number(m[1])]));
		expect(seeded).toEqual(REGION_TO_COUNTY);
		expect(Object.keys(REGION_NAMES).sort()).toEqual(Object.keys(REGION_TO_COUNTY).sort());
		expect(Object.keys(REGION_TO_COUNTY)).toHaveLength(21);
	});

	it('deploys with every län closed for loading; the owner opens them in Admin (CODEX1 R1)', () => {
		const sql = readFileSync('backend/db/migrations/0103_artportalen_source.sql', 'utf8');
		const rows = [...sql.matchAll(/\('artportalen', '\d+',\s*'(SE-[A-Z]+)',\s*(true|false)\)/g)];
		expect(rows).toHaveLength(21);
		expect(rows.filter((m) => m[2] === 'true')).toEqual([]);
	});
});

describe('one SOS selection [C1-1]', () => {
	it('pins provider, birds with descendants, county, present reports and start-date filtering', () => {
		const f = sliceFilter({ county: 6, from: '2026-05-01', to: '2026-05-31' }) as Record<string, any>;
		expect(f.dataProvider).toEqual({ ids: [1] });
		expect(f.taxon).toEqual({ ids: [4000104], includeUnderlyingTaxa: true });
		expect(f.geographics).toEqual({ areas: [{ areaType: 'County', featureId: '6' }] });
		expect(f.date).toEqual({ startDate: '2026-05-01', endDate: '2026-05-31', dateFilterType: 'OnlyStartDate' });
		expect(f.occurrenceStatus).toBe('Present');
		expect(f.output.fields).toContain('diffusionStatus');
		expect(f.output.fieldSet).toBeUndefined();
	});
});

describe('record mapping', () => {
	it('maps a real-shaped record, Swedish name and red list included', () => {
		const r = compact({ 'taxon.id': 100001, 'taxon.scientificName': 'Astur gentilis', 'taxon.vernacularName': 'duvhök', 'taxon.attributes': { redlistCategory: 'NT' } });
		expect(r).toMatchObject({
			date: '2026-10-01',
			month: 10,
			taxon: { id: '100001', canonical: 'Astur gentilis', rank: 'SPECIES' },
			municipality: 'Jönköping',
			municipalityId: '680',
			locality: 'Kumlaby, Visingsö, Sm',
			lat: 58.04,
			lon: 14.33,
			uncertainty: 25,
			count: 2,
			observers: ['Observer A'],
			localName: 'duvhök',
			redList: 'NT',
			redListUrl: 'https://artfakta.se/taxa/100001',
			activity: 'foraging',
			behaviour: ['foraging'],
			validation: 'Ovaliderad',
			modifiedAt: '2026-10-01T07:27:10.997'
		});
		expect(r.url).toMatch(/^https:\/\/www\.artportalen\.se\/sighting\/\d+$/);
	});

	it('splits a party on commas and keeps each name once', () => {
		expect(observerNames('Observer B, Observer C, Observer B')).toEqual(['Observer B', 'Observer C']);
		expect(observerNames('')).toEqual([]);
		expect(observerNames(undefined)).toEqual([]);
	});

	it('takes species and subspecies by Dyntaxa rank; aggregates, genera and hybrids are not species', () => {
		expect(classifyTaxon('1', 'Fulica atra', 'species')?.rank).toBe('SPECIES');
		expect(classifyTaxon('2', 'Motacilla flava thunbergi', 'subspecies')).toMatchObject({ rank: 'SUBSPECIES', binomial: 'Motacilla flava' });
		expect(classifyTaxon('3', 'Anser fabalis/serrirostris', 'speciesAggregate')).toBeNull();
		expect(classifyTaxon('4', 'Anser', 'genus')).toBeNull();
		// Feral Pigeon: kept as a form under Rock Pigeon, never dropped.
		expect(classifyTaxon('5', 'Columba livia, domesticated populations', 'unranked')).toEqual({
			id: '5',
			canonical: 'Columba livia domestica',
			raw: 'Columba livia, domesticated populations',
			rank: 'SUBSPECIES',
			binomial: 'Columba livia'
		});
		// Only that one form, at that rank: no other taxon gets an inferred name.
		expect(classifyTaxon('7', 'Anser anser, domesticated populations', 'unranked')).toBeNull();
		expect(classifyTaxon('8', 'Columba livia, domesticated populations', 'species')).toBeNull();
		expect(classifyTaxon('6', 'Fulica atra', 'unranked')).toBeNull();
	});

	it('counts individuals only: pairs or nests are a note, never a count [A4-7]', () => {
		const pairs = compact({ 'occurrence.organismQuantityInt': 3, 'occurrence.organismQuantityUnit': { id: 13, value: 'nests' } });
		expect(pairs.count).toBeNull();
		expect(pairs.notes).toBe('Quantity: 3 nests');
		expect(compact({ 'occurrence.organismQuantityUnit': { id: 9, value: 'ind.' } }).count).toBe(2);
		expect(compact({ 'occurrence.organismQuantityInt': undefined }).count).toBeNull();
		// A unit without a usable id is not a count of birds (CODEX1 R7).
		const odd = compact({ 'occurrence.organismQuantityInt': 3, 'occurrence.organismQuantityUnit': { value: 'nests' } });
		expect(odd).toMatchObject({ count: null, notes: 'Quantity: 3 nests' });
		expect(compact({ 'occurrence.organismQuantityUnit': { id: 0, value: '' } }).count).toBe(2);
	});

	it('keeps Swedish wall time and drops the zone for modified', () => {
		expect(modifiedAt('2026-10-01T07:27:10.997+02:00')).toBe('2026-10-01T07:27:10.997');
		expect(modifiedAt('2026-03-29T02:30:00Z')).toBe('2026-03-29T02:30:00');
		expect(modifiedAt('2026-02-30T07:00:00+01:00')).toBeNull();
		expect(modifiedAt('yesterday')).toBeNull();
	});

	it('reads the sighting number from catalogNumber or the occurrence id', () => {
		expect(recordId({ occurrence: { catalogNumber: '136977375' } })).toBe('136977375');
		expect(recordId({ occurrence: { occurrenceId: 'urn:lsid:artportalen.se:sighting:42' } })).toBe('42');
		expect(recordId({ occurrence: { catalogNumber: 'abc' } })).toBeNull();
		// Past 15 digits a number is no longer exact (CODEX1 R11).
		expect(recordId({ occurrence: { catalogNumber: '1234567890123456' } })).toBeNull();
	});

	it('builds the link from the record\'s own identity, never the provider url (CODEX1 round 7)', () => {
		const mismatched = {
			'occurrence.occurrenceId': 'urn:lsid:artportalen.se:sighting:042',
			'occurrence.catalogNumber': '42',
			'occurrence.url': 'https://www.artportalen.se/sighting/43',
			'event.plainStartDate': '2026-10-20'
		};
		const r = compact(mismatched);
		expect(r.id).toBe('42');
		expect(r.url).toBe('https://www.artportalen.se/sighting/42');
		expect(compact({ ...mismatched, 'occurrence.url': 'http://www.artportalen.se/sighting/1' }).url).toBe('https://www.artportalen.se/sighting/42');
		// Both published row kinds carry the matching link.
		const rows: RecordRow[] = [];
		const agg = new CountyAggregate('SE-F', 'Jönköpings län', WINDOW, (row) => rows.push(row), { sourceLabel: 'Artportalen', locale: 'sv', recentKeepDays: 14, strictRecent: true });
		agg.add(r);
		const p = agg.payload();
		expect(rows[0]).toMatchObject({ upstream_record_id: '42', record_url: 'https://www.artportalen.se/sighting/42' });
		expect(p.recent[0]).toMatchObject({ upstream_record_id: '42', record_url: 'https://www.artportalen.se/sighting/42' });
	});

	it('marks an absent report and an undated one', () => {
		expect(compactRecord(makeSosRecord({ 'occurrence.isPositiveObservation': false }))).toBe('absent');
		expect(compactRecord(makeSosRecord({ 'event.plainStartDate': '2026-13-01' }))).toBe('undated');
	});
});

describe('privacy screening [C1-5]', () => {
	it('a blurred or sensitive record keeps only date, species, county, kommun and count (CODEX1 R2)', () => {
		const cases: Record<string, unknown>[] = [
			{ diffusionStatus: 1 },
			{ diffusionStatus: 2 },
			{ diffusionStatus: undefined },
			{ diffusionStatus: null },
			{ diffusionStatus: '0' },
			{ sensitive: true },
			{ sensitive: undefined },
			{ diffusionStatus: 0, sensitive: 'false' }
		];
		for (const over of cases) {
			const r = compact({ ...over, 'occurrence.occurrenceRemarks': 'Nest by the old oak at the north shore' });
			expect(r, JSON.stringify(over)).toMatchObject({
				lat: null,
				lon: null,
				uncertainty: null,
				locality: null,
				url: null,
				observers: [],
				notes: null,
				municipality: 'Jönköping',
				date: '2026-10-01',
				count: 2
			});
			expect(r.taxon?.canonical).toBe('Fulica atra');
		}
		const precise = compact({ 'occurrence.occurrenceRemarks': 'Two adults' });
		expect(precise).toMatchObject({ lat: 58.04, observers: ['Observer A'], notes: 'Two adults' });
		expect(precise.url).toMatch(/^https:/);
	});

	it('a restricted record is exactly the allowlist: every outbound field checked (CODEX1 round 2)', () => {
		const loaded = {
			sensitive: true,
			'occurrence.activity': { id: 4, value: 'ruvande' },
			'occurrence.behavior': { id: 12, value: 'bobygge' },
			'occurrence.sex': { id: 2, value: 'hona' },
			'occurrence.organismQuantityInt': 3,
			'occurrence.organismQuantityUnit': { id: 13, value: 'nests' },
			'occurrence.occurrenceRemarks': 'By the old oak',
			'taxon.id': 100001,
			'taxon.scientificName': 'Astur gentilis',
			'taxon.vernacularName': 'duvhök',
			'taxon.attributes': { redlistCategory: 'NT' }
		};
		const r = compact(loaded);
		expect(r).toEqual({
			id: r.id,
			date: '2026-10-01',
			month: 10,
			taxon: { id: '100001', canonical: 'Astur gentilis', raw: 'Astur gentilis', rank: 'SPECIES', binomial: 'Astur gentilis' },
			otherName: null,
			municipality: 'Jönköping',
			municipalityId: '680',
			count: null,
			taxonId: '100001',
			localName: 'duvhök',
			redList: 'NT',
			redListUrl: 'https://artfakta.se/taxa/100001',
			locality: null,
			lat: null,
			lon: null,
			uncertainty: null,
			observers: [],
			url: null,
			behaviour: [],
			activity: null,
			validation: null,
			notes: null,
			sex: null,
			photos: null,
			dataset: null,
			modifiedAt: null
		});
		// The same record, precise: all of it kept.
		const precise = compact({ ...loaded, sensitive: false });
		expect(precise).toMatchObject({ activity: 'incubating', sex: 'female', notes: 'Quantity: 3 nests. By the old oak', modifiedAt: '2026-10-01T07:27:10.997' });
	});

	it('never lets a blurred record become a pin, a locality or a place location', async () => {
		const fake = fakeSos({ records: jonkopingRecords() });
		const rows: RecordRow[] = [];
		const spool = { reset() {}, write: (r: RecordRow) => rows.push(r) } as unknown as RecordSpool;
		const { agg } = await readCounty(sos(fake), 'SE-F', 6, WINDOW, { pagesDone: 0, pagesTotal: 0 }, AbortSignal.timeout(10_000), {}, spool);
		const p = agg.payload();
		const everything = JSON.stringify(p) + JSON.stringify(rows);
		for (const leak of ['Hidden Lake', 'Secret Marsh', 'Observer Z', 'Observer Y', 'old oak']) expect(everything).not.toContain(leak);
		const hidden = rows.find((r) => r.observed_on === '2026-05-11')!;
		expect(hidden).toMatchObject({ lat: null, lon: null, uncertainty_m: null, locality: null, observers: [], record_url: null, notes: null, place_key: 'SE-F:Jönköping' });
		const secret = rows.find((r) => r.observed_on === '2026-10-09')!;
		expect(secret).toMatchObject({ lat: null, observers: [], record_url: null });
		// Never a latest-reports row: those need a link.
		expect(p.recent.map((x) => x.observed_on)).not.toContain('2026-10-09');
		// The kommun's location is the median of exact points only.
		expect(p.places.find((x) => x.place_key === 'SE-F:Jönköping')).toMatchObject({ lat: 58.04, lon: 14.33, upstream_place_id: '680' });
	});
});

describe('reading a county', () => {
	const progress = () => ({ pagesDone: 0, pagesTotal: 0 });
	const signal = () => AbortSignal.timeout(10_000);

	it('reads the window whole, month by month, and builds a payload the app accepts', async () => {
		const fake = fakeSos({ records: jonkopingRecords() });
		const spool = new RecordSpool();
		try {
			const { agg, evidence } = await readCounty(sos(fake), 'SE-F', 6, WINDOW, progress(), signal(), { pageSize: 2 }, spool);
			const p = agg.payload();
			// 13 months: Oct 2025 – Oct 2026 (through the 23rd).
			expect(evidence).toHaveLength(13);
			expect(evidence.every((e) => e.count === e.total && e.reads === 1)).toBe(true);
			expect(fake.calls.every((c) => c.county === 6)).toBe(true);
			// In-window records only: 11 for SE-F; the two October 2026 Coots are recent only.
			expect(p.stats.records).toBe(11);
			expect(p.stats.unkeyed).toBe(1);
			expect(p.places.map((x) => x.place_key)).toEqual(['SE-F', 'SE-F:Jönköping', 'SE-F:Nässjö']);
			expect(p.recent.map((x) => x.observed_on).slice(0, 2)).toEqual(['2026-10-08', '2026-10-01']);
			expect(p.stats.recentTo).toBe('2026-10-09');
			expect(p.observers.find((o) => o.place_key === 'SE-F')?.observer).toBe('Observer A');
			expect(p.taxa.find((t) => t.canonical_name === 'Motacilla flava thunbergi')?.rank).toBe('SUBSPECIES');
			for (const c of buildChunks('SE-F', p, true)) validateChunkRows(c.kind, c.rowData, c.sha256, { region: 'SE-F', storeObservers: true });
			for await (const c of spool.chunks(200 * 1024)) validateChunkRows('records', c.rowData, c.sha256, { region: 'SE-F', storeObservers: true });
			expect(spool.rows).toBe(14);
		} finally {
			spool.close();
		}
	});

	it('re-reads a month whose total changes mid-read, then accepts it', async () => {
		let bumped = false;
		const fake = fakeSos({
			records: jonkopingRecords(),
			intercept: (call, _n, f) => {
				if (!bumped && call.kind === 'page' && call.cursor && call.from === '2026-05-01') {
					bumped = true;
					f.records.push(makeSosRecord({ 'event.plainStartDate': '2026-05-28' }));
				}
			}
		});
		const { evidence } = await readCounty(sos(fake), 'SE-F', 6, WINDOW, progress(), signal(), { pageSize: 2 });
		expect(evidence.find((e) => e.from === '2026-05-01')).toMatchObject({ reads: 2, total: 6 });
	});

	it('de-duplicates repeated rows before counting, and fails a month whose distinct ids fall short', async () => {
		const q = { county: 6, from: '2026-05-01', to: '2026-05-31' };
		// A page that repeats the previous page's rows: distinct < total on every read.
		let firstPage: unknown = null;
		const fake = fakeSos({
			records: jonkopingRecords(),
			intercept: (call) => {
				if (call.kind !== 'page') return;
				if (!call.cursor) return;
				return Response.json(firstPage);
			}
		});
		const orig = fake.fetch;
		fake.fetch = async (input, init) => {
			const res = await orig(input, init);
			if (new URL(input).searchParams.get('cursor') === null && input.includes('SearchByCursor')) {
				firstPage = await res.clone().json();
			}
			return res;
		};
		await expect(readSlice(sos(fake), q, progress(), signal(), { pageSize: 2 })).rejects.toThrow(/cursor repeated itself|never read back whole/);
	});

	it('never reads a non-empty Count with an empty cursor as an empty month (CODEX1 R3)', async () => {
		const q = { county: 6, from: '2026-05-01', to: '2026-05-31' };
		const fake = fakeSos({
			records: jonkopingRecords(),
			intercept: (call) => (call.kind === 'page' ? Response.json({ totalCount: 0, records: [], nextCursor: null }) : undefined)
		});
		await expect(readSlice(sos(fake), q, progress(), signal())).rejects.toThrow(/SOS counted 5 reports but the cursor listed 0/);
		expect(fake.calls.filter((c) => c.kind === 'count')).toHaveLength(3);
	});

	it('reads a month again when the same sighting comes back changed, e.g. newly blurred (CODEX1 R3)', async () => {
		const q = { county: 6, from: '2026-05-01', to: '2026-05-31' };
		let reads = 0;
		const fake = fakeSos({
			records: jonkopingRecords(),
			intercept: (call) => {
				if (call.kind !== 'page') return;
				reads++;
				if (reads > 1) return;
				// First read: the same sighting twice, the second time blurred.
				const base = makeSosRecord({ 'event.plainStartDate': '2026-05-02' });
				const { __county: _c, ...a } = base;
				const b = { ...a, diffusionStatus: 2 };
				return Response.json({ totalCount: 2, records: [a, b], nextCursor: null });
			}
		});
		const { buffer, evidence } = await readSlice(sos(fake), q, progress(), signal());
		buffer.close();
		expect(evidence.reads).toBe(2);
	});

	it('tells repeats apart by everything that would be published, types kept (CODEX1 rounds 2 and 5)', () => {
		const { __county: _c, ...base } = makeSosRecord({ 'event.plainStartDate': '2026-05-02' });
		const variant = (over: Record<string, unknown>) => ({ ...base, ...over });
		expect(signature(base)).toBe(signature(structuredClone(base)));
		expect(signature(base)).not.toBe(signature(variant({ diffusionStatus: '0' })));
		expect(signature(base)).not.toBe(signature(variant({ sensitive: 'false' })));
		expect(signature(base)).not.toBe(signature(variant({ sensitive: true })));
		// A correction with the same (or no) modification time still differs.
		expect(signature(base)).not.toBe(signature(variant({ event: { plainStartDate: '2026-05-03' } })));
		expect(signature(base)).not.toBe(signature(variant({ occurrence: { ...(base.occurrence as object), organismQuantityInt: 9 } })));
		expect(signature(variant({ modified: undefined }))).not.toBe(
			signature(variant({ modified: undefined, location: { ...(base.location as object), locality: 'Elsewhere' } }))
		);
	});

	it('a repeat that flips presence, in either order, rereads the month; a persistent flip fails it (CODEX1 round 4)', async () => {
		const q = { county: 6, from: '2026-05-01', to: '2026-05-31' };
		const { __county: _c, ...a } = makeSosRecord({ 'event.plainStartDate': '2026-05-02' });
		const absent = { ...a, occurrence: { ...(a.occurrence as object), isPositiveObservation: false } };
		expect(signature(a)).not.toBe(signature(absent));
		for (const pair of [[a, absent], [absent, a]]) {
			const stuck = fakeSos({ records: [], intercept: (call) => (call.kind === 'count' ? Response.json(1) : Response.json({ totalCount: 1, records: pair, nextCursor: null })) });
			await expect(readSlice(sos(stuck), q, progress(), signal())).rejects.toThrow(/came back changed/);
			let reads = 0;
			const settles = fakeSos({
				records: [],
				intercept: (call) =>
					call.kind === 'count' ? Response.json(1) : Response.json({ totalCount: 1, records: ++reads === 1 ? pair : [pair[1]], nextCursor: null })
			});
			const r = await readSlice(sos(settles), q, progress(), signal());
			r.buffer.close();
			expect(r.evidence.reads).toBe(2);
		}
	});

	it('one identity: the occurrence id first, digits normalized; a self-contradicting record never counts (CODEX1 round 6)', async () => {
		expect(recordIdentity({ occurrence: { occurrenceId: 'urn:lsid:artportalen.se:sighting:007', catalogNumber: '7' } })).toBe('7');
		expect(recordIdentity({ occurrence: { occurrenceId: 'urn:lsid:artportalen.se:sighting:42' } })).toBe('42');
		expect(recordIdentity({ occurrence: { catalogNumber: 42 } })).toBe('42');
		expect(recordIdentity({ occurrence: { occurrenceId: 'urn:lsid:artportalen.se:sighting:42', catalogNumber: '43' } })).toBe('conflict');
		expect(recordId({ occurrence: { occurrenceId: 'urn:lsid:artportalen.se:sighting:42', catalogNumber: '43' } })).toBeNull();
		// A precise copy and a sensitive correction: same URN, different catalog numbers.
		const { __county: _c, ...precise } = makeSosRecord({ 'event.plainStartDate': '2026-05-02', 'location.locality': 'Open Shore' });
		const urn = (precise.occurrence as { occurrenceId: string }).occurrenceId;
		const corrected = { ...precise, sensitive: true, occurrence: { ...(precise.occurrence as object), occurrenceId: urn, catalogNumber: '999999999' } };
		for (const pair of [[precise, corrected], [corrected, precise]]) {
			const stuck = fakeSos({ records: [], intercept: (call) => (call.kind === 'count' ? Response.json(2) : Response.json({ totalCount: 2, records: pair, nextCursor: null })) });
			await expect(readCounty(sos(stuck), 'SE-F', 6, { start: '2026-05-01', end: '2026-05-31', through: '2026-05-31' }, progress(), signal())).rejects.toThrow(
				/occurrence id and catalog number disagree/
			);
			// Settles on a reread: only the corrected (now consistent) copy, restricted.
			let reads = 0;
			const fixed = { ...corrected, occurrence: { ...(corrected.occurrence as object), catalogNumber: (precise.occurrence as { catalogNumber: string }).catalogNumber } };
			const settles = fakeSos({
				records: [],
				intercept: (call) =>
					call.kind === 'count'
						? Response.json(reads === 0 ? 2 : 1)
						: Response.json(++reads === 1 ? { totalCount: 2, records: pair, nextCursor: null } : { totalCount: 1, records: [fixed], nextCursor: null })
			});
			const { agg } = await readCounty(sos(settles), 'SE-F', 6, { start: '2026-05-01', end: '2026-05-31', through: '2026-05-31' }, progress(), signal());
			const p = agg.payload();
			expect(p.stats.records).toBe(1);
			expect(JSON.stringify(p)).not.toContain('Open Shore');
		}
	});

	it('validates every row before the repeat check, in either order (CODEX1 round 5)', async () => {
		const q = { county: 6, from: '2026-05-01', to: '2026-05-31' };
		const { __county: _c, ...may } = makeSosRecord({ 'event.plainStartDate': '2026-05-02' });
		const june = { ...may, event: { plainStartDate: '2026-06-01' } };
		for (const pair of [[may, june], [june, may]]) {
			const fake = fakeSos({ records: [], intercept: (call) => (call.kind === 'count' ? Response.json(1) : Response.json({ totalCount: 1, records: pair, nextCursor: null })) });
			await expect(readSlice(sos(fake), q, progress(), signal())).rejects.toThrow(/the date 2026-06-01/);
		}
		// Two valid May dates for one sighting: a change, never the first copy silently kept.
		const may3 = { ...may, event: { plainStartDate: '2026-05-03' } };
		for (const pair of [[may, may3], [may3, may]]) {
			const fake = fakeSos({ records: [], intercept: (call) => (call.kind === 'count' ? Response.json(1) : Response.json({ totalCount: 1, records: pair, nextCursor: null })) });
			await expect(readSlice(sos(fake), q, progress(), signal())).rejects.toThrow(/came back changed/);
		}
	});

	it('reads a month again when a repeat changes only its privacy decision (same modified time)', async () => {
		const q = { county: 6, from: '2026-05-01', to: '2026-05-31' };
		let reads = 0;
		const fake = fakeSos({
			records: jonkopingRecords(),
			intercept: (call) => {
				if (call.kind !== 'page' || ++reads > 1) return;
				const { __county: _c, ...a } = makeSosRecord({ 'event.plainStartDate': '2026-05-02' });
				return Response.json({ totalCount: 1, records: [a, { ...a, sensitive: true }], nextCursor: null });
			}
		});
		const { buffer, evidence } = await readSlice(sos(fake), q, progress(), signal());
		buffer.close();
		expect(evidence.reads).toBe(2);
	});

	it('a sighting precise in April and listed again in May (even as absent) rereads the county (CODEX1 round 3)', async () => {
		const april = makeSosRecord({ 'event.plainStartDate': '2026-04-10' });
		const id = (april.occurrence as { catalogNumber: string }).catalogNumber;
		const twin = makeSosRecord({ 'event.plainStartDate': '2026-05-10', 'occurrence.isPositiveObservation': false });
		Object.assign(twin.occurrence as object, { catalogNumber: id, occurrenceId: `urn:lsid:artportalen.se:sighting:${id}` });
		// Persistent contradiction: the county never reads back whole.
		const stuck = fakeSos({ records: [april, twin] });
		await expect(readCounty(sos(stuck), 'SE-F', 6, WINDOW, progress(), signal())).rejects.toThrow(/turned up in two months/);
		// It settles on the second read (April's copy gone): the precise row is gone too.
		let countyReads = 0;
		const settles = fakeSos({
			records: [april, twin],
			intercept: (call, _n, f) => {
				if (call.kind === 'count' && call.from === '2025-10-01' && ++countyReads === 2) f.records.splice(f.records.indexOf(april), 1);
			}
		});
		const { agg } = await readCounty(sos(settles), 'SE-F', 6, WINDOW, progress(), signal());
		const p = agg.payload();
		expect(p.stats.records).toBe(0);
		expect(p.recent).toEqual([]);
	});

	it('anchors the newest date on every accepted report, a genus too (CODEX1 round 3)', async () => {
		const fake = fakeSos({
			records: [
				makeSosRecord({ 'event.plainStartDate': '2026-04-01' }),
				makeSosRecord({ 'event.plainStartDate': '2026-05-28', 'taxon.id': 6006001, 'taxon.scientificName': 'Anser fabalis/serrirostris', 'taxon.taxonRank': 'speciesAggregate' })
			]
		});
		const { agg } = await readCounty(sos(fake), 'SE-F', 6, WINDOW, progress(), signal());
		const p = agg.payload();
		expect(p.stats.recentTo).toBe('2026-05-28');
		// The April species report is older than the last 14 days with data: not "latest".
		expect(p.recent).toEqual([]);
	});

	it('anchors latest reports to the newest report, not to today (CODEX1 R4)', async () => {
		// A county whose newest report is weeks before the load's last day.
		const quiet = jonkopingRecords().filter((r) => (r.event as { plainStartDate: string }).plainStartDate < '2026-09-01');
		quiet.push(makeSosRecord({ 'event.plainStartDate': '2026-09-01' }));
		const fake = fakeSos({ records: quiet });
		const { agg } = await readCounty(sos(fake), 'SE-F', 6, WINDOW, progress(), signal());
		const p = agg.payload();
		expect(p.stats.recentTo).toBe('2026-09-01');
		expect(p.recent.map((r) => r.observed_on)).toContain('2026-09-01');
	});

	it('stops a cursor that repeats itself or never ends', async () => {
		const q = { county: 6, from: '2026-05-01', to: '2026-05-31' };
		const loop = fakeSos({
			records: jonkopingRecords(),
			intercept: (call) =>
				call.kind === 'page' ? Response.json({ totalCount: 5, records: [], nextCursor: 'same' }) : undefined
		});
		await expect(readSlice(sos(loop), q, progress(), signal(), { pageSize: 2 })).rejects.toThrow(/cursor repeated itself/);
		let n = 0;
		const endless = fakeSos({
			records: jonkopingRecords(),
			intercept: (call) => (call.kind === 'page' ? Response.json({ totalCount: 2, records: [], nextCursor: `c${n++}` }) : undefined)
		});
		await expect(readSlice(sos(endless), q, progress(), signal(), { pageSize: 2 })).rejects.toThrow(/ran past/);
	});

	it('accepts a short terminal page and a null or empty next cursor', async () => {
		const q = { county: 6, from: '2026-05-01', to: '2026-05-31' };
		const fake = fakeSos({ records: jonkopingRecords() });
		const { buffer, evidence } = await readSlice(sos(fake), q, progress(), signal(), { pageSize: 4 });
		buffer.close();
		expect(evidence).toMatchObject({ total: 5, pages: 2 });
		const empty = fakeSos({
			records: [],
			intercept: (call) => (call.kind === 'page' ? Response.json({ totalCount: 0, records: [], nextCursor: '' }) : undefined)
		});
		const r = await readSlice(sos(empty), q, progress(), signal());
		r.buffer.close();
		expect(r.evidence.total).toBe(0);
	});

	it('fails a record dated outside its month (a broken answer), never publishing the month', async () => {
		const q = { county: 6, from: '2026-05-01', to: '2026-05-31' };
		const stray = makeSosRecord({ 'event.plainStartDate': '2026-06-02' });
		const fake = fakeSos({
			records: jonkopingRecords(),
			intercept: (call) => {
				if (call.kind === 'page') {
					const { __county: _c, ...r } = stray;
					return Response.json({ totalCount: 1, records: [r], nextCursor: null });
				}
			}
		});
		await expect(readSlice(sos(fake), q, progress(), signal())).rejects.toThrow(/the date 2026-06-02/);
	});

	it('splits a month over the 2M cursor cap into smaller ranges, and refuses only a single oversized day (CODEX1 R11)', async () => {
		const calls: SosCall[] = [];
		const huge = fakeSos({ records: [], intercept: (call) => (calls.push(call), call.kind === 'count' ? Response.json(2_000_001) : undefined) });
		await expect(readSlice(sos(huge), { county: 1, from: '2026-05-01', to: '2026-05-31' }, progress(), signal())).rejects.toThrow(/cursor limit/);
		expect(calls.filter((c) => c.kind === 'page')).toHaveLength(0);
		// May "too big" as a whole month: read as two halves, both whole.
		const split = fakeSos({
			records: jonkopingRecords(),
			intercept: (call) => (call.kind === 'count' && call.from === '2026-05-01' && call.to === '2026-05-31' ? Response.json(2_000_001) : undefined)
		});
		const { agg, evidence } = await readCounty(sos(split), 'SE-F', 6, WINDOW, progress(), signal());
		expect(evidence.filter((e) => e.from.startsWith('2026-05')).map((e) => [e.from, e.to])).toEqual([
			['2026-05-01', '2026-05-16'],
			['2026-05-17', '2026-05-31']
		]);
		expect(agg.payload().stats.records).toBe(11);
		// A single day over the cap can't be split.
		const day = fakeSos({ records: jonkopingRecords(), intercept: (call) => (call.kind === 'count' ? Response.json(2_000_001) : undefined) });
		await expect(readCounty(sos(day), 'SE-F', 6, WINDOW, progress(), signal())).rejects.toThrow(/on 2025-10-01 alone/);
	});

	it('reads the whole county again, spool emptied, when a report moves between months', async () => {
		let moved = false;
		const fake = fakeSos({
			records: jonkopingRecords(),
			intercept: (call, _n, f) => {
				// After May is read, re-date one May Coot into June (not yet read).
				if (!moved && call.kind === 'count' && call.from === '2026-06-01') {
					moved = true;
					const r = f.records.find((x) => (x.event as { plainStartDate: string }).plainStartDate === '2026-05-03')!;
					(r.event as { plainStartDate: string }).plainStartDate = '2026-06-03';
				}
			}
		});
		const spool = new RecordSpool();
		try {
			const { agg } = await readCounty(sos(fake), 'SE-F', 6, WINDOW, progress(), signal(), {}, spool);
			expect(agg.payload().stats.records).toBe(11);
			expect(spool.rows).toBe(14);
		} finally {
			spool.close();
		}
	});

	it('retries 429 and 5xx, and stops at once on a refused key', async () => {
		let n = 0;
		const flaky = fakeSos({ records: jonkopingRecords(), intercept: () => (n++ < 2 ? new Response('busy', { status: 429 }) : undefined) });
		expect(await sos(flaky).count({ county: 6, from: '2026-05-01', to: '2026-05-31' }, signal())).toBe(5);
		const refused = fakeSos({ records: [], intercept: () => new Response('no', { status: 401 }) });
		const err = await sos(refused).count({ county: 6, from: '2026-05-01', to: '2026-05-31' }, signal()).catch((e) => e);
		expect(err).toBeInstanceOf(SosError);
		expect(err.retryable).toBe(false);
		expect(String(err.message)).not.toContain('k'.repeat(32));
	});
});

describe('latest reports at the 20,000 cap (CODEX1 round 2)', () => {
	it('never lets unlistable (restricted) reports displace listable ones, nor count as cut', () => {
		const agg = new CountyAggregate('SE-F', 'Jönköpings län', WINDOW, null, { sourceLabel: 'Artportalen', locale: 'sv', recentKeepDays: 14, strictRecent: true });
		const base = compact({ 'event.plainStartDate': '2026-10-20' });
		for (let i = 0; i < MAX_RECENT_ROWS; i++) agg.add({ ...base, id: String(100_000 + i), date: '2026-10-20' });
		// Newer, but protected: no link.
		for (let i = 0; i < 50; i++) agg.add({ ...base, id: String(900_000 + i), date: '2026-10-22', url: null, observers: [] });
		const p = agg.payload();
		expect(p.recent).toHaveLength(MAX_RECENT_ROWS);
		expect(p.recent.every((r) => r.observed_on === '2026-10-20')).toBe(true);
		expect(p.diagnostics.find((d) => d.code === 'recent_truncated')).toBeUndefined();
		expect(p.diagnostics.find((d) => d.code === 'recent_without_link')?.count).toBe(50);
		// One more listable report: now one is cut.
		agg.add({ ...base, id: '999999', date: '2026-10-21' });
		const q = agg.payload();
		expect(q.recent[0].observed_on).toBe('2026-10-21');
		expect(q.diagnostics.find((d) => d.code === 'recent_truncated')?.count).toBe(1);
	});
});

describe('truncation survives a long diagnostics list (CODEX1 round 3)', () => {
	it('reports the cut in stats even when 500+ other notes outrank it', () => {
		const agg = new CountyAggregate('SE-F', 'Jönköpings län', WINDOW, null, { sourceLabel: 'Artportalen', locale: 'sv', recentKeepDays: 14, strictRecent: true });
		const base = compact({ 'event.plainStartDate': '2026-10-20' });
		for (let i = 0; i <= MAX_RECENT_ROWS; i++) agg.add({ ...base, id: String(200_000 + i), date: '2026-10-20' });
		for (let i = 0; i < 501; i++) for (let k = 0; k < 2; k++) agg.add({ ...base, id: `${300_000 + i * 2 + k}`, date: '2026-09-01', taxon: null, otherName: `Genus${i}` });
		const p = agg.payload();
		expect(p.diagnostics).toHaveLength(500);
		expect(p.diagnostics.find((d) => d.code === 'recent_truncated')).toBeUndefined();
		expect(p.stats.recentTruncated).toBe(1);
	});
});

describe('preflight [C1-3]', () => {
	it('passes a load exactly at the limits and refuses one a byte over (no margins, CODEX1 R6)', () => {
		expect(() => checkLimits({ rows: MAX_LOAD_ROWS, bytes: MAX_LOAD_BYTES, finishBytes: MAX_FINISH_BODY_BYTES })).not.toThrow();
		expect(() => checkLimits({ rows: MAX_LOAD_ROWS + 1, bytes: 1, finishBytes: 1 })).toThrow(LoadError);
		expect(() => checkLimits({ rows: 1, bytes: MAX_LOAD_BYTES + 1, finishBytes: 1 })).toThrow(/bytes/);
		expect(() => checkLimits({ rows: 1, bytes: 1, finishBytes: MAX_FINISH_BODY_BYTES + 1 })).toThrow(/finish call/);
	});
});

describe('connector secrets [C1-6]', () => {
	const base = 'INGEST_URL=http://127.0.0.1:3003/api/ingest/\n';
	const token = `INGEST_TOKEN=ext_${'a'.repeat(43)}\n`;
	const key = `ARTPORTALEN_API_KEY=${'b'.repeat(32)}\n`;
	it('idles without the token or without the API key, and runs with both', () => {
		expect(readSettings(null, 'f').problem).toMatch(/no env file/);
		expect(readSettings(base + key, 'f').problem).toMatch(/INGEST_TOKEN/);
		expect(readSettings(base + token, 'f').problem).toMatch(/ARTPORTALEN_API_KEY/);
		const ok = readSettings(base + token + key, 'f');
		expect(ok.problem).toBeNull();
		expect(ok.key).toBe('b'.repeat(32));
	});
});

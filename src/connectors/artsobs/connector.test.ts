/**
 * Norway connector (td-eec7db Phase 2 rev B): unit tests on recorded
 * Artskart records and a fake Artskart built from them. No network, no
 * database.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ContractError, validateChunkRows } from '$server/external-sources/contract';
import { REGION_NAMES, REGION_TO_COUNTY, sightingUrl } from './config';
import { classifyName, compactRecord, decimal, isoDate, observerNames, recordId, type CompactRecord } from './records';
import { ArtskartClient, ArtskartError, retryAfterMs } from './artskart';
import { CountyAggregate, partyText, placeLocality, type RegionPayload } from './aggregate';
import { monthRanges, readCounty, readSlice } from './fetch';
import { buildChunks, buildManifest, chunkRows } from './payload';
import { IngestCallError, IngestClient, ingestBase, type ClaimedLoad } from './ingest';
import { LoadError, chooseWindow, runLoad } from './run';
import { RECORDED, ddmmyyyy, fakeArtskart, makeRecord, type ArtskartRecord } from './fixtures/fake-artskart';
import { TODAY, WINDOW, nordlandRecords } from './fixtures/scenario';

const never = new AbortController().signal;
const noSleep = async () => {};

function client(records = nordlandRecords(), intercept?: Parameters<typeof fakeArtskart>[0]['intercept'], repeatRows?: (u: URL) => number) {
	const fake = fakeArtskart({ records, intercept, repeatRows });
	return { fake, artskart: new ArtskartClient({ fetch: fake.fetch, sleep: noSleep }) };
}

async function nordland(records = nordlandRecords(), opts = {}): Promise<RegionPayload> {
	const { artskart } = client(records);
	const agg = await readCounty(artskart, 'NO-18', 18, WINDOW, { pagesDone: 0, pagesTotal: 0 }, never, opts);
	return agg.payload();
}

const list = (records: Record<string, unknown>[], total = records.length, totalPages = 1) =>
	Response.json({ Observations: records, PageIndex: 0, PageSize: 5000, TotalCount: total, TotalPages: totalPages });

describe('config', () => {
	it('the county map matches the seed in migration 0096 exactly', () => {
		const sql = readFileSync(new URL('../../../backend/db/migrations/0096_artsobs_artskart_observers.sql', import.meta.url), 'utf8');
		const seeded = Object.fromEntries([...sql.matchAll(/\('artsobs', '(\d+)', '(NO-\d+)'\)/g)].map((m) => [m[2], Number(m[1])]));
		expect(seeded).toEqual(REGION_TO_COUNTY);
		expect(Object.keys(REGION_NAMES).sort()).toEqual(Object.keys(REGION_TO_COUNTY).sort());
	});

	it('links a report to Artsobservasjoner by its sighting number, else to Artskart, else nowhere', () => {
		expect(sightingUrl('36377855', null)).toBe('https://www.artsobservasjoner.no/Sighting/36377855');
		expect(sightingUrl(null, 'https://artskart.artsdatabanken.no/#featureInfo/x')).toBe('https://artskart.artsdatabanken.no/#featureInfo/x');
		expect(sightingUrl('abc', 'http://evil.example/')).toBeNull();
	});
});

describe('records (recorded Artskart records)', () => {
	it('reads every recorded record: date, decimal-comma coordinates, precision, count and party', () => {
		const party = compactRecord(RECORDED.party) as CompactRecord;
		expect(party).toMatchObject({ date: '2025-02-22', month: 2, municipality: 'Nesna', count: 1, observers: ['Observer B', 'Observer C'] });
		expect(party.lat).toBeCloseTo(Number(String(RECORDED.party.Latitude).replace(',', '.')), 5);
		expect(party.uncertainty).toBe(250);
		expect(party.url).toBe(`https://www.artsobservasjoner.no/Sighting/${RECORDED.party.CatalogNumber}`);
		expect((compactRecord(RECORDED.nullcount) as CompactRecord).count).toBeNull();
		expect((compactRecord(RECORDED.bigprec) as CompactRecord).uncertainty).toBe(10000);
		for (const raw of Object.values(RECORDED)) expect(compactRecord(raw)).not.toBe('undated');
	});

	it('names: species, subspecies (as eBird writes them) and everything else unkeyed; trailing spaces trimmed', () => {
		expect((compactRecord(RECORDED.trailing) as CompactRecord).taxon).toMatchObject({ canonical: 'Astur gentilis', rank: 'SPECIES' });
		expect((compactRecord(RECORDED.subsp) as CompactRecord).taxon).toEqual({
			id: String(RECORDED.subsp.TaxonId),
			canonical: 'Anas crecca carolinensis',
			raw: 'Anas crecca subsp. carolinensis',
			rank: 'SUBSPECIES',
			binomial: 'Anas crecca'
		});
		const genus = compactRecord(RECORDED.genus) as CompactRecord;
		expect(genus.taxon).toBeNull();
		expect(genus.otherName).toBe('Laridae');
		expect(classifyName('1', 'Cairina moschata var. domestica')).toMatchObject({ canonical: 'Cairina moschata domestica', rank: 'SUBSPECIES' });
		expect(classifyName('1', 'Phylloscopus collybita subsp. tristis/abietinus')).toMatchObject({ rank: 'SUBSPECIES' });
		expect(classifyName('1', 'Anas platyrhynchos x Anas acuta')).toBeNull();
		expect(classifyName(null, 'Anser anser')).toBeNull();
	});

	it('dates, numbers and observers are read strictly', () => {
		expect(isoDate('31.02.2025')).toBeNull();
		expect(isoDate('2025-02-01')).toBeNull();
		expect(decimal('15,4558')).toBe(15.4558);
		expect(decimal('')).toBeNull();
		expect(observerNames(' Ann  Lee |Bo|Ann Lee||')).toEqual(['Ann Lee', 'Bo']);
		expect(recordId({ Id: 'miljodir/rovbase/k1' })).toBeNull();
		expect(compactRecord({ ...RECORDED.species, CollectedDate: '1823' })).toBe('undated');
		const half = compactRecord({ ...RECORDED.species, Longitude: null }) as CompactRecord;
		expect([half.lat, half.lon]).toEqual([null, null]);
	});

	it('a party too long for one line names as many as fit, then "+N"', () => {
		const names = Array.from({ length: 13 }, (_, i) => `Observer Number ${i + 1} Longname`);
		const text = partyText(names)!;
		expect(text.length).toBeLessThanOrEqual(200);
		expect(text).toMatch(/^Observer Number 1 Longname, .* \+\d+$/);
		expect(partyText([])).toBeNull();
		expect(partyText(['A', 'B'])).toBe('A, B');
	});
});

describe('Artskart client', () => {
	it('asks for one county, birds, Artsobservasjoner, inclusive dates, one page', () => {
		const u = new URL(ArtskartClient.listUrl({ county: 18, from: '2025-05-01', to: '2025-05-31' }, 2, 5000));
		expect(u.origin + u.pathname).toBe('https://artskart.artsdatabanken.no/publicapi/api/observations/list');
		expect(Object.fromEntries(u.searchParams)).toEqual({
			'countys[]': '18',
			'taxongroups[]': '8',
			'collections[]': 'so2-birds',
			fromDate: '2025-05-01',
			toDate: '2025-05-31',
			pageSize: '5000',
			pageIndex: '2'
		});
	});

	it('retries 503, 429 (honouring Retry-After) and network errors; a 400 is final at once', async () => {
		const waits: number[] = [];
		let n = 0;
		const c = new ArtskartClient({
			sleep: async (ms) => void waits.push(ms),
			fetch: async () => {
				n++;
				if (n === 1) throw new TypeError('fetch failed');
				if (n === 2) return new Response('busy', { status: 503 });
				if (n === 3) return new Response('slow down', { status: 429, headers: { 'retry-after': '30' } });
				return list([]);
			}
		});
		expect((await c.page({ county: 18, from: '2025-01-01', to: '2025-01-31' }, 0, 10, never)).total).toBe(0);
		expect(n).toBe(4);
		expect(waits[2]).toBeGreaterThanOrEqual(30_000);
		const bad = new ArtskartClient({ sleep: noSleep, fetch: async () => new Response('no', { status: 400 }) });
		await expect(bad.page({ county: 18, from: '2025-01-01', to: '2025-01-31' }, 0, 10, never)).rejects.toMatchObject({ retryable: false });
	});

	it('gives up after five failures as retryable; an answer without counts is broken, never "no records"', async () => {
		let n = 0;
		const down = new ArtskartClient({ sleep: noSleep, fetch: async () => (n++, new Response('x', { status: 502 })) });
		await expect(down.page({ county: 18, from: '2025-01-01', to: '2025-01-31' }, 0, 10, never)).rejects.toMatchObject({ retryable: true });
		expect(n).toBe(5);
		for (const body of ['{"Message":"An error has occurred."}', 'null', '{"Observations":[],"TotalCount":"7","TotalPages":1}', 'not json']) {
			const c = new ArtskartClient({ sleep: noSleep, fetch: async () => new Response(body, { status: 200 }) });
			await expect(c.page({ county: 18, from: '2025-01-01', to: '2025-01-31' }, 0, 10, never)).rejects.toBeInstanceOf(ArtskartError);
		}
	});

	it('reads Retry-After as seconds or a date, capped at two minutes', () => {
		expect(retryAfterMs('5')).toBe(5000);
		expect(retryAfterMs('999')).toBe(120_000);
		expect(retryAfterMs(new Date(1_000_060_000).toUTCString(), 1_000_000_000)).toBe(60_000);
		expect(retryAfterMs('soon')).toBeNull();
	});
});

describe('paging', () => {
	it('slices are calendar months, clipped to the window and today', () => {
		const r = monthRanges('2024-10-01', '2026-10-23');
		expect(r).toHaveLength(25);
		expect(r[0]).toEqual(['2024-10-01', '2024-10-31']);
		expect(r[4]).toEqual(['2025-02-01', '2025-02-28']);
		expect(r[24]).toEqual(['2026-10-01', '2026-10-23']);
	});

	it('pages a slice whole and counts a row Artskart repeats only once', async () => {
		const { artskart } = client(nordlandRecords(), undefined, (u) => (u.searchParams.get('pageIndex') === '0' ? 2 : 0));
		const slice = await readSlice(artskart, { county: 18, from: '2025-04-01', to: '2025-04-30' }, { pagesDone: 0, pagesTotal: 0 }, never, { pageSize: 7 });
		// April 2025: 28 Goldcrests, the Narvik Fieldfares (3) and the teal.
		expect(slice.total).toBe(32);
		expect(new Set(slice.records.map((r) => r.id)).size).toBe(32);
		expect(slice.records).toHaveLength(32);
	});

	it('a slice whose count changes while read is read again from scratch', async () => {
		let added = false;
		const { artskart, fake } = client(nordlandRecords(), (url, records) => {
			if (!added && url.searchParams.get('pageIndex') === '1') {
				added = true;
				records.push(makeRecord(RECORDED.species3, { CollectedDate: '15.04.2025' }));
			}
		});
		const slice = await readSlice(artskart, { county: 18, from: '2025-04-01', to: '2025-04-30' }, { pagesDone: 0, pagesTotal: 0 }, never, { pageSize: 7 });
		expect(slice.total).toBe(33);
		expect(slice.records).toHaveLength(33);
		expect(fake.calls.filter((u) => u.searchParams.get('pageIndex') === '0')).toHaveLength(2);
	});

	it('a report deleted while its month is paged changes the count, so the month is read again', async () => {
		let deleted = false;
		const { artskart } = client(nordlandRecords(), (url, records) => {
			if (!deleted && url.searchParams.get('pageIndex') === '1') {
				deleted = true;
				records.splice(records.findIndex((r) => r.CollectedDate === '01.04.2025'), 1);
			}
		});
		const slice = await readSlice(artskart, { county: 18, from: '2025-04-01', to: '2025-04-30' }, { pagesDone: 0, pagesTotal: 0 }, never, { pageSize: 7 });
		expect(slice.total).toBe(31);
		expect(slice.records).toHaveLength(31);
		expect(slice.records.some((r) => r.date === '2025-04-01')).toBe(false);
	});

	it('a slice that never reads back whole fails as retryable; a record without an id is a broken answer', async () => {
		let n = 0;
		const { artskart } = client(nordlandRecords(), (url, records) => {
			if (url.searchParams.get('pageIndex') === '1') records.push(makeRecord(RECORDED.species3, { CollectedDate: `${String((n++ % 28) + 1).padStart(2, '0')}.04.2025` }));
		});
		await expect(
			readSlice(artskart, { county: 18, from: '2025-04-01', to: '2025-04-30' }, { pagesDone: 0, pagesTotal: 0 }, never, { pageSize: 7 })
		).rejects.toMatchObject({ retryable: true, message: expect.stringMatching(/never read back whole/) });
		const noId = new ArtskartClient({ sleep: noSleep, fetch: async () => list([{ ...RECORDED.species, Id: null }]) });
		await expect(readSlice(noId, { county: 18, from: '2025-03-01', to: '2025-03-31' }, { pagesDone: 0, pagesTotal: 0 }, never)).rejects.toMatchObject({
			retryable: true,
			message: expect.stringMatching(/no usable id/)
		});
	});

	it('a record whose date moves into a later month mid-read sends the county round again, counted once', async () => {
		let moved = false;
		const records = nordlandRecords();
		const { artskart, fake } = client(records, (url, rs) => {
			if (!moved && url.searchParams.get('fromDate') === '2025-05-01') {
				moved = true;
				// A Goldcrest already read in April is re-dated into May.
				rs.find((r) => r.CollectedDate === '01.04.2025')!.CollectedDate = '13.05.2025';
			}
		});
		const agg = await readCounty(artskart, 'NO-18', 18, WINDOW, { pagesDone: 0, pagesTotal: 0 }, never);
		expect(agg.payload().stats.records).toBe(54);
		expect(fake.calls.filter((u) => u.searchParams.get('fromDate') === '2024-10-01')).toHaveLength(2);
	});

	it('accepted limit: a report re-dated back into a month already read is missed by this load (CODEX1 rev B finding 4)', async () => {
		let moved = false;
		const { artskart, fake } = client(nordlandRecords(), (url, rs) => {
			if (!moved && url.searchParams.get('fromDate') === '2025-05-01') {
				moved = true;
				// A May Goldcrest (not yet read) is re-dated into April (already read).
				rs.find((r) => r.CollectedDate === '01.05.2025')!.CollectedDate = '15.04.2025';
			}
		});
		const agg = await readCounty(artskart, 'NO-18', 18, WINDOW, { pagesDone: 0, pagesTotal: 0 }, never);
		expect(agg.payload().stats.records).toBe(53);
		expect(fake.calls.filter((u) => u.searchParams.get('fromDate') === '2024-10-01')).toHaveLength(1);
	});

	it('a record with no readable date, or a date outside the month asked for, fails the load instead of shrinking the month (CODEX1 rev B finding 1)', async () => {
		const q = { county: 18, from: '2025-03-01', to: '2025-03-31' };
		for (const [bad, why] of [
			[{ ...RECORDED.species, Id: 'urn:uuid:bad-1', CollectedDate: '2025-03-05' }, /no readable date/],
			[{ ...RECORDED.species, Id: 'urn:uuid:bad-2', CollectedDate: '05.04.2025' }, /the date 2025-04-05/]
		] as const) {
			const c = new ArtskartClient({ sleep: noSleep, fetch: async () => list([RECORDED.species, bad]) });
			await expect(readSlice(c, q, { pagesDone: 0, pagesTotal: 0 }, never)).rejects.toMatchObject({ retryable: true, message: expect.stringMatching(why) });
		}
	});

	it('a county that keeps changing fails as retryable', async () => {
		const { artskart } = client(nordlandRecords(), (url, rs) => {
			// Every time May is read, another Goldcrest already read in April is re-dated into May.
			if (url.searchParams.get('fromDate') === '2025-05-01') rs.find((r) => r.Collector === 'Observer D' && r.CollectedDate.endsWith('.04.2025'))!.CollectedDate = '13.05.2025';
		});
		await expect(readCounty(artskart, 'NO-18', 18, WINDOW, { pagesDone: 0, pagesTotal: 0 }, never)).rejects.toMatchObject({
			retryable: true,
			message: expect.stringMatching(/kept changing/)
		});
	});
});

describe('counting (NO-18)', () => {
	it('counts the county and each municipality; another county is never read', async () => {
		const p = await nordland();
		expect(p.stats).toMatchObject({ records: 54, unkeyed: 1, noMunicipality: 1 });
		expect(p.places.map((x) => x.place_key)).toEqual(
			['NO-18', 'NO-18:Bodø', 'NO-18:Lurøy', 'NO-18:Narvik', 'NO-18:Nesna', 'NO-18:Rana', 'NO-18:Røst', 'NO-18:Saltdal'].sort((a, b) =>
				a === 'NO-18' ? -1 : b === 'NO-18' ? 1 : a.localeCompare(b)
			)
		);
		expect(p.places.some((x) => x.place_key.includes('Harstad'))).toBe(false);
	});

	it('species plus unkeyed equal every total exactly, and a total exists for every place × month', async () => {
		const p = await nordland();
		for (const place of p.places) {
			for (let m = 1; m <= 12; m++) {
				const t = p.totals.find((x) => x.place_key === place.place_key && x.month === m);
				expect(t, `${place.place_key} ${m}`).toBeDefined();
				const species = p.taxon_month.filter((x) => x.place_key === place.place_key && x.month === m).reduce((a, x) => a + x.reports, 0);
				expect(species + t!.unkeyed).toBe(t!.reports);
			}
		}
		expect(p.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'non_species_taxon', detail: 'Laridae', count: 1 })]));
	});

	it('a subspecies is sent under the name eBird uses, with its rank and raw name', async () => {
		const p = await nordland();
		expect(p.taxon_month.find((x) => x.place_key === 'NO-18:Røst')).toMatchObject({
			canonical_name: 'Anas crecca carolinensis',
			raw_name: 'Anas crecca subsp. carolinensis',
			rank: 'SUBSPECIES'
		});
		expect(p.taxon_month.find((x) => x.canonical_name === 'Astur gentilis')).toBeDefined();
	});

	it('observers rank by days out, then species; parties count for each person', async () => {
		const p = await nordland();
		const county = p.observers.filter((o) => o.place_key === 'NO-18');
		expect(county.map((o) => o.observer)).toEqual(['Observer D', 'Observer A', 'Observer B', 'Observer C']);
		expect(county[0]).toMatchObject({ rank: 1, days: 40, species: 1, reports: 40 });
		expect(county[1]).toMatchObject({ rank: 2, days: 8 });
		expect(p.observers.filter((o) => o.place_key === 'NO-18:Nesna').map((o) => o.observer)).toEqual(['Observer B', 'Observer C']);
		for (const o of p.observers) expect(o.days).toBeLessThanOrEqual(o.reports);
	});

	it('many reports on one big day rank below fewer reports on more days out', () => {
		const agg = new CountyAggregate('NO-18', WINDOW);
		const at = (who: string, day: string, n: number) => {
			for (let i = 0; i < n; i++) agg.add(compactRecord(makeRecord(RECORDED.species, { Collector: who, CollectedDate: ddmmyyyy(day) })) as CompactRecord);
		};
		at('Big Day', '2025-05-20', 30);
		for (const d of ['2025-05-01', '2025-05-02', '2025-05-03']) at('Patch Walker', d, 1);
		expect(agg.payload().observers.filter((o) => o.place_key === 'NO-18').map((o) => [o.observer, o.days, o.reports])).toEqual([
			['Patch Walker', 3, 3],
			['Big Day', 1, 30]
		]);
	});

	it('a taxon id that arrives under a second name keeps its first, with a note', () => {
		const agg = new CountyAggregate('NO-18', WINDOW);
		const a = compactRecord(RECORDED.species) as CompactRecord;
		const b = { ...(compactRecord(makeRecord(RECORDED.species)) as CompactRecord), taxon: { ...a.taxon!, canonical: 'Anser rubrirostris', raw: 'Anser rubrirostris' } };
		agg.add(a);
		agg.add(b);
		const p = agg.payload();
		expect(new Set(p.taxon_month.map((x) => x.canonical_name))).toEqual(new Set(['Anser anser']));
		expect(p.diagnostics.some((d) => d.code === 'taxon_renamed')).toBe(true);
	});

	it('recent reports are the 14 days up to the newest, newest first, with the party named', async () => {
		const p = await nordland();
		expect(p.recent.map((r) => r.observed_on)).toEqual(['2026-10-08', '2026-10-01']);
		expect(p.recent.every((r) => r.observer === 'Observer A' && r.record_url.startsWith('https://www.artsobservasjoner.no/Sighting/'))).toBe(true);
		expect(p.stats).toMatchObject({ recentFrom: '2026-09-25', recentTo: '2026-10-08' });
		// The window total does not include the reports after it.
		expect(p.totals.find((t) => t.place_key === 'NO-18' && t.month === 10)!.reports).toBe(0);
	});

	it('localities: a pin only under the Phase 0 rule; imprecise ones are text', async () => {
		const p = await nordland();
		const bodo = p.localities.find((l) => l.place_key === 'NO-18:Bodø' && l.rank === 1)!;
		expect(bodo).toMatchObject({ placement: 'pin', uncertainty_m: 300 });
		expect(p.localities.find((l) => l.place_key === 'NO-18:Saltdal')).toMatchObject({ placement: 'text', lat: null, uncertainty_m: 10000 });
		expect(placeLocality({ n: 2, lat: [65], lon: [14], unc: [10] })).toMatchObject({ placement: 'text' });
		for (const l of p.localities) expect(l.placement === 'pin').toBe(l.lat !== null);
	});

	it('rows pass the app contract validator and chunk under the byte target', async () => {
		const p = await nordland();
		const chunks = buildChunks('NO-18', p);
		expect(chunks.map((c) => c.kind)).toEqual(expect.arrayContaining(['places', 'totals', 'taxon_month', 'localities', 'recent', 'diagnostics', 'observers']));
		for (const c of chunks) expect(Buffer.byteLength(JSON.stringify(c.rowData))).toBeLessThan(256 * 1024);
		const m = buildManifest(p, chunks, { window_start: WINDOW.start, window_end: WINDOW.end, retrieved_at: TODAY.toISOString(), source_snapshot: {}, filter_fingerprint: '0'.repeat(64) });
		expect(m.counts.observers).toBe(p.observers.length);
		// A source without store_observers refuses the observers chunk.
		const obs = chunks.find((c) => c.kind === 'observers')!;
		expect(() => validateChunkRows('observers', obs.rowData, obs.sha256, { region: 'NO-18', storeObservers: false })).toThrow(ContractError);
		expect(chunkRows('totals', Array.from({ length: 12_000 }, (_, i) => ({ place_key: 'NO-18', month: (i % 12) + 1, reports: i, unkeyed: 0 }))).every((c) => c.rows <= 5000)).toBe(true);
	});
});

describe('the window', () => {
	const load = { window_months: 24, window_ends: ['2026-09-30', '2026-08-31'] };
	it('ends with the latest end before today (Artskart is live) and starts 24 months earlier', () => {
		expect(chooseWindow(load, '2026-10-23')).toEqual(WINDOW);
	});
	it('a load whose ends are all today or later fails without a retry', () => {
		expect(() => chooseWindow({ window_months: 24, window_ends: ['2026-10-31'] }, '2026-10-23')).toThrow(LoadError);
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

	it('a success answer without its body is retried, never read as done; 204 is a success only for a claim (CODEX1 rev B finding 3)', async () => {
		const LOAD = { id: '00000000-0000-4000-8000-000000000001', region_code: 'NO-18', attempt: 1, lease_token: '00000000-0000-4000-8000-000000000002', lease_expires_at: 'x', window_months: 24, window_ends: ['2026-09-30'] };
		const manifest = {} as never;
		let n = 0;
		const garbled = new IngestClient(base, TOKEN, { sleep: noSleep, fetch: async () => (n++, new Response('<html>proxy</html>', { status: 200 })) });
		await expect(garbled.finish(LOAD, manifest, never)).rejects.toMatchObject({ code: 'bad_answer', retryable: true });
		expect(n).toBe(5);
		const wrongShape = new IngestClient(base, TOKEN, { sleep: noSleep, fetch: async () => Response.json({ status: 'stored' }) });
		await expect(wrongShape.finish(LOAD, manifest, never)).rejects.toMatchObject({ code: 'bad_answer' });
		const noContent = new IngestClient(base, TOKEN, { sleep: noSleep, fetch: async () => new Response(null, { status: 204 }) });
		await expect(noContent.heartbeat(LOAD, { phase: 'x', done: 0, total: 0 }, never)).rejects.toMatchObject({ code: 'bad_answer' });
		await expect(noContent.chunk(LOAD, { chunk_id: 'c', kind: 'totals', sha256: 'x', rows: [] }, never)).rejects.toMatchObject({ code: 'bad_answer' });
		expect(await noContent.claim('claim-key-2', never)).toBeNull();
		let tries = 0;
		const recovers = new IngestClient(base, TOKEN, {
			sleep: noSleep,
			fetch: async () => (tries++ === 0 ? new Response('garbage', { status: 200 }) : Response.json({ status: 'done', result: { places: 1 } }))
		});
		expect(await recovers.finish(LOAD, manifest, never)).toEqual({ places: 1 });
	});

	it('a claim answer is checked whole and retried under the same key, never run half-formed (CODEX1 rev B re-review)', async () => {
		const good = { id: '00000000-0000-4000-8000-000000000001', region_code: 'NO-18', attempt: 1, lease_token: '00000000-0000-4000-8000-000000000002', lease_expires_at: '2026-10-27T17:00:00Z', window_months: 24, window_ends: ['2026-09-30', '2026-08-31'] };
		const { region_code: _r, ...noRegion } = good;
		const bad = [{}, noRegion, { ...good, lease_token: 'x' }, { ...good, attempt: 0 }, { ...good, window_ends: [] }, { ...good, window_ends: ['30.09.2026'] }, { ...good, window_ends: ['2026-09-15'] }, { ...good, window_ends: ['2026-02-31'] }, { ...good, window_months: 0 }, [good]];
		for (const load of bad) {
			let n = 0;
			const c = new IngestClient(base, TOKEN, { sleep: noSleep, fetch: async () => (n++, Response.json({ load })) });
			await expect(c.claim('claim-key-3', never), JSON.stringify(load)).rejects.toMatchObject({ code: 'bad_answer', retryable: true });
			expect(n).toBe(5);
		}
		const keys: string[] = [];
		let tries = 0;
		const recovers = new IngestClient(base, TOKEN, {
			sleep: noSleep,
			fetch: async (_url, init) => {
				keys.push(JSON.parse(String(init?.body)).idempotency_key);
				const t = tries++;
				return Response.json({ load: t === 0 ? noRegion : t === 1 ? { ...good, window_ends: ['2026-09-15'] } : good });
			}
		});
		expect(await recovers.claim('claim-key-4', never)).toEqual(good);
		expect(keys).toEqual(['claim-key-4', 'claim-key-4', 'claim-key-4']);
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
				if (path.endsWith('/fail')) return Response.json({ status: 'queued' });
				return Response.json({ status: 'stored', lease_expires_at: 'x' });
			}
		});
		return { ingest, calls };
	}
	const run = (artskart: ArtskartClient, ingest: IngestClient, stop = never, logs: string[] = []) =>
		runLoad({ artskart, ingest, log: (e) => void logs.push(e), now: () => TODAY }, LOAD, stop);

	it('sends every chunk and a manifest that adds up, then finishes', async () => {
		const { artskart } = client();
		const { ingest, calls } = fakeApp();
		const logs: string[] = [];
		expect(await run(artskart, ingest, never, logs)).toBe('done');
		const chunks = calls.filter((c) => c.path.endsWith('/chunks'));
		const manifest = calls.find((c) => c.path.endsWith('/finish'))!.body.manifest as {
			chunks: { chunk_id: string }[];
			window_end: string;
			source_snapshot: Record<string, unknown>;
			counts: Record<string, number>;
		};
		expect(manifest.chunks.map((c) => c.chunk_id)).toEqual(chunks.map((c) => c.body.chunk_id));
		expect(manifest.window_end).toBe('2026-09-30');
		expect(manifest.source_snapshot).toEqual({ api: 'artskart-publicapi-v1', collection: 'so2-birds', taxon_group: 8, county: 18, through: '2026-10-23' });
		expect(manifest.counts.observers).toBeGreaterThan(0);
		expect(calls.every((c) => c.body.lease_token === LOAD.lease_token && c.body.attempt === 1)).toBe(true);
		expect(calls.some((c) => c.path.endsWith('/heartbeat'))).toBe(true);
		expect(logs).toContain('load_done');
	});

	it('a lost lease stops the load without calling fail', async () => {
		const { artskart } = client();
		const { ingest, calls } = fakeApp((path) => (path.endsWith('/heartbeat') ? Response.json({ error: 'lease_expired', message: 'x' }, { status: 409 }) : null));
		expect(await run(artskart, ingest)).toBe('lease_lost');
		expect(calls.some((c) => c.path.endsWith('/fail') || c.path.endsWith('/chunks'))).toBe(false);
	});

	it('Artskart down: the load fails as retryable; stopped: it goes back to the queue', async () => {
		const down = new ArtskartClient({ sleep: noSleep, fetch: async () => new Response('x', { status: 503 }) });
		const a = fakeApp();
		expect(await run(down, a.ingest)).toBe('failed');
		expect(a.calls.find((c) => c.path.endsWith('/fail'))!.body).toMatchObject({ retryable: true });

		const stop = new AbortController();
		const { artskart } = client(nordlandRecords(), () => void stop.abort(new Error('shutdown')));
		const b = fakeApp();
		expect(await run(artskart, b.ingest, stop.signal)).toBe('stopped');
		expect(b.calls.find((c) => c.path.endsWith('/fail'))!.body).toMatchObject({ retryable: true, reason: expect.stringMatching(/back to the queue/) });
	});

	it('a county Artskart has nothing for never publishes zeros', async () => {
		const { artskart } = client(nordlandRecords().map((r) => ({ ...r, __county: 19 })) as ArtskartRecord[]);
		const { ingest, calls } = fakeApp();
		expect(await run(artskart, ingest)).toBe('failed');
		expect(calls.some((c) => c.path.endsWith('/chunks') || c.path.endsWith('/finish'))).toBe(false);
		expect(calls.find((c) => c.path.endsWith('/fail'))!.body).toMatchObject({ retryable: true, reason: expect.stringMatching(/no bird reports/) });
	});

	it('a garbled answer to finish fails the load as retryable, never reports done (CODEX1 rev B finding 3)', async () => {
		const { artskart } = client();
		const logs: string[] = [];
		const { ingest, calls } = fakeApp((path) => (path.endsWith('/finish') ? new Response('<html>502 from a proxy</html>', { status: 200 }) : null));
		expect(await run(artskart, ingest, never, logs)).toBe('failed');
		expect(logs).not.toContain('load_done');
		expect(calls.find((c) => c.path.endsWith('/fail'))!.body).toMatchObject({ retryable: true });
	});

	it('a chunk the app rejects as invalid fails the load without a retry', async () => {
		const { artskart } = client();
		const { ingest, calls } = fakeApp((path) => (path.endsWith('/chunks') ? Response.json({ error: 'observer', message: 'no observers here' }, { status: 422 }) : null));
		expect(await run(artskart, ingest)).toBe('failed');
		expect(calls.find((c) => c.path.endsWith('/fail'))!.body).toMatchObject({ retryable: false });
	});

	it('the dates in a recorded record are what the fake serves', () => {
		expect(ddmmyyyy('2025-04-01')).toBe('01.04.2025');
	});
});

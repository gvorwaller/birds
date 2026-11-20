/**
 * Norway payload parity (td-99eebf, plan [C1-7]): the Sweden work moves the
 * Norway connector's generic parts into src/connectors/shared/. This pins the
 * exact chunks, records and manifest fingerprint the Norway connector builds
 * from the frozen Nordland fixture, as computed BEFORE that move, so any
 * change to what Norway sends fails here.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { rowsDigest, type RecordRow } from '$server/external-sources/contract';
import { CountyAggregate } from './aggregate';
import { buildChunks, buildManifest, filterFingerprint } from './payload';
import { compactRecord, type CompactRecord } from './records';
import { MAX_RECENT_ROWS } from './config';
import { WINDOW, nordlandRecords } from './fixtures/scenario';

function norwayPayloadDigest(): { chunks: string; records: string; manifest: string; fingerprint: string } {
	const records: RecordRow[] = [];
	const agg = new CountyAggregate('NO-18', WINDOW, (row) => records.push(row));
	for (const raw of nordlandRecords()) {
		if ((raw as { __county?: number }).__county === 19) continue;
		const c = compactRecord(raw);
		if (c !== 'undated') agg.add(c);
	}
	const payload = agg.payload();
	const chunks = buildChunks('NO-18', payload);
	const sent = chunks.map(({ chunk_id, kind, rows, sha256 }) => ({ chunk_id, kind, rows, sha256 }));
	const filters = { api: 'artskart-publicapi-v1', collection: 'so2-birds', taxon_group: 8, county: 18 };
	const fingerprint = filterFingerprint({ ...filters, window_start: WINDOW.start, window_end: WINDOW.end, placement: 'artskart-municipality/v2' });
	const manifest = buildManifest(payload, sent, {
		window_start: WINDOW.start,
		window_end: WINDOW.end,
		retrieved_at: '2026-10-23T12:00:00.000Z',
		source_snapshot: { ...filters, through: WINDOW.through },
		filter_fingerprint: fingerprint
	});
	const h = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
	return { chunks: h(sent), records: rowsDigest(records), manifest: h(manifest), fingerprint };
}

describe('Norway payload parity (frozen Nordland fixture)', () => {
	it('builds exactly the chunks, records and manifest it built before the shared-core move', () => {
		expect(norwayPayloadDigest()).toEqual(PINNED);
	});
});

const PINNED = {
	chunks: '2f7d0cfcebe0b47bd46c7652e320eb5e5f103df38d96e90d64f0238bf3b3e40f',
	records: '03214fa8a9c7a76377920ea14c96f96cff4daedce354e886ae8f82ba6221fc3d',
	manifest: 'eb9358d715da5ca56b96c9a0002b0b543e5f96ca8c9bab009cb5f6d46ebb82a3',
	fingerprint: '298e46bb3a653fd333bc4db6421eacd97f823f2a3d18f817de022aafa462e95c'
};

describe("Norway's latest-reports rules are unchanged (CODEX1 td-99eebf round 4)", () => {
	const window = { start: '2025-10-01', end: '2026-09-30', through: '2026-10-23' };
	const rec = (over: Partial<CompactRecord>): CompactRecord => ({
		id: '1', date: '2026-05-01', month: 5, otherName: null, municipality: 'Bodø', locality: 'Kjerringøy', lat: 67.5, lon: 14.7,
		uncertainty: 10, count: 1, observers: ['Observer A'], url: 'https://www.artsobservasjoner.no/Sighting/1', taxonId: '100',
		localName: 'grågås', redList: null, redListUrl: null, municipalityId: '1804', behaviour: [], activity: null, validation: null,
		notes: null, sex: null, photos: null, dataset: null, modifiedAt: null,
		taxon: { id: '100', canonical: 'Anser anser', raw: 'Anser anser', rank: 'SPECIES', binomial: 'Anser anser' },
		...over
	});

	it('a later family report does not move the anchor: the May 1 species stays a latest report', () => {
		const agg = new CountyAggregate('NO-18', window);
		agg.add(rec({}));
		agg.add(rec({ id: '2', date: '2026-05-28', taxon: null, otherName: 'Laridae', url: null }));
		expect(agg.payload().recent.map((r) => r.observed_on)).toEqual(['2026-05-01']);
	});

	it('counts reports without a link inside the cap, as before', () => {
		const agg = new CountyAggregate('NO-18', window);
		for (let i = 0; i < MAX_RECENT_ROWS; i++) agg.add(rec({ id: String(10_000 + i), date: '2026-05-20' }));
		agg.add(rec({ id: '99', date: '2026-05-21', url: null }));
		const p = agg.payload();
		expect(p.recent).toHaveLength(MAX_RECENT_ROWS - 1);
		expect(p.diagnostics.find((d) => d.code === 'recent_truncated')?.count).toBe(1);
		expect(p.diagnostics.find((d) => d.code === 'recent_without_link')?.count).toBe(1);
	});
});

/**
 * Ingest contract v1 (td-eec7db Phase 1): row shapes, digests, the manifest
 * window rule and reason sanitizing. Pure; no database.
 */
import { describe, expect, it } from 'vitest';
import {
	allowedWindowEnds,
	windowStartFor,
	canonicalJson,
	ContractError,
	parseChunkEnvelope,
	parseClaim,
	parseFenced,
	parseManifest,
	parseProgress,
	rowsDigest,
	sanitizeReason,
	validateChunkRows,
	validateRow,
	MAX_ROWS_PER_CHUNK
} from './contract';

const ctx = { region: 'NO-18', storeObservers: false };
const LEASE = '0b6f1f9e-4c1b-4c55-9a3e-7d2b1c0a9e11';

function err(fn: () => unknown): ContractError {
	try {
		fn();
	} catch (e) {
		if (e instanceof ContractError) return e;
		throw e;
	}
	throw new Error('expected a ContractError');
}

const recent = (over: Record<string, unknown> = {}) => ({
	upstream_record_id: '4011',
	place_key: 'NO-18:Nesna',
	upstream_taxon_id: '2490266',
	canonical_name: 'Erithacus rubecula',
	observed_on: '2026-10-01',
	count: 2,
	locality: 'Skogsøy, Nesna',
	lat: 66.2,
	lon: 13.0,
	uncertainty_m: 100,
	generalized: false,
	record_url: 'https://www.artsobservasjoner.no/Sighting/41803040',
	observer: null,
	...over
});

describe('canonical JSON and digest', () => {
	it('sorts keys at every level and ignores the key order sent', () => {
		expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[1,{"y":2,"z":1}]},"b":1}');
		expect(rowsDigest([{ a: 1, b: 2 }])).toBe(rowsDigest([{ b: 2, a: 1 }]));
		expect(rowsDigest([{ a: 1 }])).toMatch(/^[0-9a-f]{64}$/);
		expect(rowsDigest([{ a: 1 }])).not.toBe(rowsDigest([{ a: 2 }]));
	});
});

describe('rows', () => {
	it('accepts each kind in its contract shape', () => {
		expect(validateRow('places', { place_key: 'NO-18', name: 'Nordland', level: 'region', parent_key: null, lat: null, lon: null }, 0, ctx).level).toBe('region');
		expect(validateRow('places', { place_key: 'NO-18:Nesna', name: 'Nesna', level: 'subregion', parent_key: 'NO-18', lat: 66.2, lon: 13 }, 0, ctx).parent_key).toBe('NO-18');
		expect(validateRow('totals', { place_key: 'NO-18', month: 6, reports: 10, unkeyed: 1 }, 0, ctx).reports).toBe(10);
		expect(
			validateRow('taxon_month', { place_key: 'NO-18', month: 1, upstream_taxon_id: '2490266', canonical_name: 'Erithacus rubecula', raw_name: 'Erithacus rubecula (Linnaeus, 1758)', rank: 'SPECIES', reports: 3 }, 0, ctx).reports
		).toBe(3);
		expect(validateRow('localities', { place_key: 'NO-18:Nesna', rank: 1, locality: 'Skogsøy', reports: 4306, lat: null, lon: null, uncertainty_m: null, placement: 'text' }, 0, ctx).placement).toBe('text');
		expect(validateRow('recent', recent(), 0, ctx).observer).toBeNull();
		expect(validateRow('diagnostics', { code: 'unplaced_records', detail: 'Norskekysten hav', count: 1517 }, 0, ctx).count).toBe(1517);
	});

	it('rejects unknown and missing fields', () => {
		expect(err(() => validateRow('totals', { place_key: 'NO-18', month: 6, reports: 10, unkeyed: 1, extra: 1 }, 0, ctx)).message).toMatch(/unknown field "extra"/);
		expect(err(() => validateRow('totals', { place_key: 'NO-18', month: 6, reports: 10 }, 0, ctx)).message).toMatch(/missing field "unkeyed"/);
	});

	it('enforces numbers: months, counts, int4, unkeyed ≤ reports', () => {
		expect(() => validateRow('totals', { place_key: 'NO-18', month: 13, reports: 1, unkeyed: 0 }, 0, ctx)).toThrow(ContractError);
		expect(() => validateRow('totals', { place_key: 'NO-18', month: 1, reports: -1, unkeyed: 0 }, 0, ctx)).toThrow(ContractError);
		expect(() => validateRow('totals', { place_key: 'NO-18', month: 1, reports: 1.5, unkeyed: 0 }, 0, ctx)).toThrow(ContractError);
		expect(() => validateRow('totals', { place_key: 'NO-18', month: 1, reports: 2 ** 31, unkeyed: 0 }, 0, ctx)).toThrow(ContractError);
		expect(() => validateRow('totals', { place_key: 'NO-18', month: 1, reports: 1, unkeyed: 2 }, 0, ctx)).toThrow(/unkeyed is larger/);
	});

	it('refuses places outside the load region as a region error (403)', () => {
		const e = err(() => validateRow('totals', { place_key: 'NO-19', month: 1, reports: 1, unkeyed: 0 }, 0, ctx));
		expect(e.code).toBe('region');
		expect(err(() => validateRow('totals', { place_key: 'NO-180:X', month: 1, reports: 1, unkeyed: 0 }, 0, ctx)).code).toBe('region');
		expect(err(() => validateRow('places', { place_key: 'NO-18:Nesna', name: 'Nesna', level: 'subregion', parent_key: 'NO-19', lat: null, lon: null }, 0, ctx)).code).toBe('region');
	});

	it('keeps the region and subregion levels straight', () => {
		expect(() => validateRow('places', { place_key: 'NO-18:Nesna', name: 'Nesna', level: 'region', parent_key: null, lat: null, lon: null }, 0, ctx)).toThrow(/only the place/);
		expect(() => validateRow('places', { place_key: 'NO-18', name: 'Nordland', level: 'region', parent_key: 'NO-18', lat: null, lon: null }, 0, ctx)).toThrow(/no parent/);
	});

	it('needs lat and lon together, and coordinates for a pin', () => {
		expect(() => validateRow('places', { place_key: 'NO-18', name: 'Nordland', level: 'region', parent_key: null, lat: 66, lon: null }, 0, ctx)).toThrow(/both/);
		expect(() => validateRow('localities', { place_key: 'NO-18', rank: 1, locality: 'X', reports: 1, lat: null, lon: null, uncertainty_m: null, placement: 'pin' }, 0, ctx)).toThrow(/pin needs/);
		expect(() => validateRow('recent', recent({ lat: 91 }), 0, ctx)).toThrow(ContractError);
		expect(() => validateRow('recent', recent({ lat: Number.NaN }), 0, ctx)).toThrow(ContractError);
	});

	it('accepts only species-rank taxa, real dates and https record links', () => {
		expect(() => validateRow('taxon_month', { place_key: 'NO-18', month: 1, upstream_taxon_id: '1', canonical_name: 'Larus', raw_name: 'Larus', rank: 'GENUS', reports: 3 }, 0, ctx)).toThrow(/SPECIES/);
		expect(() => validateRow('recent', recent({ observed_on: '2026-02-30' }), 0, ctx)).toThrow(/calendar date/);
		expect(() => validateRow('recent', recent({ observed_on: '0000-01-01' }), 0, ctx)).toThrow(/year must be/);
		expect(() => validateRow('recent', recent({ observed_on: '1899-12-31' }), 0, ctx)).toThrow(/year must be/);
		expect(validateRow('recent', recent({ observed_on: '1900-01-01' }), 0, ctx).observed_on).toBe('1900-01-01');
		const nextYear = new Date().getUTCFullYear() + 1;
		expect(validateRow('recent', recent({ observed_on: `${nextYear}-12-31` }), 0, ctx).observed_on).toBe(`${nextYear}-12-31`);
		expect(() => validateRow('recent', recent({ observed_on: `${nextYear + 1}-01-01` }), 0, ctx)).toThrow(/year must be/);
		expect(() => validateRow('recent', recent({ record_url: 'http://example.org/x' }), 0, ctx)).toThrow(/https/);
		expect(() => validateRow('recent', recent({ locality: 'a\nb' }), 0, ctx)).toThrow(ContractError);
	});

	it('accepts subspecies-rank taxa (Phase 2 rev B)', () => {
		const row = { place_key: 'NO-18', month: 4, upstream_taxon_id: '225778', canonical_name: 'Anas crecca carolinensis', raw_name: 'Anas crecca subsp. carolinensis', rank: 'SUBSPECIES', reports: 1 };
		expect(validateRow('taxon_month', row, 0, ctx).rank).toBe('SUBSPECIES');
	});

	it('observers rows: only from a source that stores observers, with days, species and localities within reports', () => {
		const obs = (over: Record<string, unknown> = {}) => ({ place_key: 'NO-18:Nesna', rank: 1, observer: 'Kari Nordmann', days: 3, species: 2, localities: 1, reports: 5, ...over });
		expect(err(() => validateRow('observers', obs(), 0, ctx)).code).toBe('observer');
		const on = { ...ctx, storeObservers: true };
		expect(validateRow('observers', obs(), 0, on)).toEqual(obs());
		expect(() => validateRow('observers', obs({ days: 6 }), 0, on)).toThrow(/exceed reports/);
		expect(() => validateRow('observers', obs({ species: 6 }), 0, on)).toThrow(/exceed reports/);
		expect(() => validateRow('observers', obs({ days: 0, reports: 0, species: 0, localities: 0 }), 0, on)).toThrow(/at least one/);
		expect(() => validateRow('observers', obs({ rank: 0 }), 0, on)).toThrow(ContractError);
		expect(() => validateRow('observers', obs({ observer: ' ' }), 0, on)).toThrow(ContractError);
		expect(err(() => validateRow('observers', obs({ place_key: 'NO-19:Harstad' }), 0, on)).code).toBe('region');
		const rows = [obs(), obs({ observer: 'Ola Nordmann' })];
		expect(() => validateChunkRows('observers', rows, rowsDigest(rows), on)).toThrow(/duplicate/);
	});

	it('refuses an observer name unless the source stores observers', () => {
		const e = err(() => validateRow('recent', recent({ observer: 'Kari Nordmann' }), 0, ctx));
		expect(e.code).toBe('observer');
		expect(validateRow('recent', recent({ observer: 'Kari Nordmann' }), 0, { ...ctx, storeObservers: true }).observer).toBe('Kari Nordmann');
	});
});

describe('chunks', () => {
	it('checks the digest before reading rows, then duplicates inside the chunk', () => {
		const rows = [{ place_key: 'NO-18', month: 1, reports: 1, unkeyed: 0 }];
		expect(validateChunkRows('totals', rows, rowsDigest(rows), ctx)).toHaveLength(1);
		expect(() => validateChunkRows('totals', rows, rowsDigest([]), ctx)).toThrow(/does not match/);
		const dup = [rows[0], { ...rows[0] }];
		expect(() => validateChunkRows('totals', dup, rowsDigest(dup), ctx)).toThrow(/duplicate/);
	});

	it('bounds the envelope', () => {
		const ok = { chunk_id: 'totals-1', kind: 'totals', sha256: 'a'.repeat(64), rows: [] };
		expect(parseChunkEnvelope(ok).kind).toBe('totals');
		expect(() => parseChunkEnvelope({ ...ok, kind: 'other' })).toThrow(ContractError);
		expect(() => parseChunkEnvelope({ ...ok, chunk_id: 'a b' })).toThrow(ContractError);
		expect(() => parseChunkEnvelope({ ...ok, rows: new Array(MAX_ROWS_PER_CHUNK + 1).fill({}) })).toThrow(/at most/);
	});
});

describe('bodies', () => {
	it('requires contract 1, a lease token and an attempt on every load call', () => {
		expect(parseFenced({ contract_version: 1, lease_token: LEASE, attempt: 1, progress: {} }, ['progress']).fence.attempt).toBe(1);
		expect(() => parseFenced({ contract_version: 2, lease_token: LEASE, attempt: 1 }, [])).toThrow(/contract 1/);
		expect(() => parseFenced({ contract_version: 1, lease_token: 'x', attempt: 1 }, [])).toThrow(/lease token/);
		expect(() => parseFenced({ contract_version: 1, lease_token: LEASE, attempt: 1, sneaky: 1 }, [])).toThrow(/unknown field/);
		expect(() => parseClaim({ contract_version: 1, idempotency_key: 'short' })).toThrow(ContractError);
		expect(parseClaim({ contract_version: 1, idempotency_key: 'claim-0001' }).idempotency_key).toBe('claim-0001');
		expect(() => parseProgress({ phase: 'fetching', done: 5, total: 4 })).toThrow(/done is larger/);
	});
});

describe('manifest', () => {
	const now = new Date('2026-10-22T12:00:00Z');
	const base = {
		window_start: '2024-10-01',
		window_end: '2026-09-30',
		retrieved_at: '2026-10-22T11:00:00Z',
		source_snapshot: { pubDate: '2026-10-10', lastCrawl: '2026-10-11T03:20:00Z' },
		filter_fingerprint: 'f'.repeat(64),
		chunks: [{ chunk_id: 'p1', kind: 'places', rows: 1, sha256: 'a'.repeat(64) }],
		counts: { places: 1 },
		places: ['NO-18'],
		months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
	};
	const opts = { windowMonths: 24, region: 'NO-18', now, allowedEnds: allowedWindowEnds(new Date('2026-10-15T00:00:00Z')) };

	it('accepts a 24-month window of whole months ending before today', () => {
		expect(parseManifest(base, opts).window_end).toBe('2026-09-30');
	});
	it('rejects windows of the wrong length, partial months or reaching today', () => {
		expect(() => parseManifest({ ...base, window_start: '2024-11-01' }, opts)).toThrow(/23 months/);
		expect(() => parseManifest({ ...base, window_start: '2024-10-02' }, opts)).toThrow(/first day/);
		expect(() => parseManifest({ ...base, window_end: '2026-09-29' }, opts)).toThrow(/last day/);
		expect(() => parseManifest({ ...base, window_start: '2024-11-01', window_end: '2026-10-31' }, opts)).toThrow(/before today/);
	});
	it("pins the window end to the latest complete months when the load was queued", () => {
		expect(allowedWindowEnds(new Date('2026-10-15T00:00:00Z'))).toEqual(['2026-09-30', '2026-08-31']);
		expect(allowedWindowEnds(new Date('2026-01-03T00:00:00Z'))).toEqual(['2025-12-31', '2025-11-30']);
		expect(allowedWindowEnds(new Date('2024-03-31T23:00:00Z'))).toEqual(['2024-02-29', '2024-01-31']);
		expect(windowStartFor('2026-09-30', 24)).toBe('2024-10-01');
		expect(windowStartFor('2026-01-31', 24)).toBe('2024-02-01');
		expect(windowStartFor('2024-02-29', 1)).toBe('2024-02-01');
		expect(parseManifest({ ...base, window_start: '2024-09-01', window_end: '2026-08-31' }, opts).window_end).toBe('2026-08-31');
		expect(() => parseManifest({ ...base, window_start: '2000-01-01', window_end: '2001-12-31' }, opts)).toThrow(/must end 2026-09-30 or 2026-08-31/);
		expect(() => parseManifest({ ...base, window_start: '2024-08-01', window_end: '2026-07-31' }, opts)).toThrow(/must end/);
	});
	it('requires every month listed once and the region among the places', () => {
		expect(() => parseManifest({ ...base, months: [1, 2, 3] }, opts)).toThrow(/every month/);
		expect(() => parseManifest({ ...base, months: [1, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] }, opts)).toThrow(/every month/);
		expect(() => parseManifest({ ...base, places: ['NO-18:Nesna'] }, opts)).toThrow(/must include the region/);
		expect(() => parseManifest({ ...base, chunks: [...base.chunks, base.chunks[0]] }, opts)).toThrow(/listed twice/);
	});
	it('rejects a retrieval time in the future and odd snapshot values', () => {
		expect(() => parseManifest({ ...base, retrieved_at: '2026-10-23T00:00:00Z' }, opts)).toThrow(/future/);
		expect(() => parseManifest({ ...base, source_snapshot: { nested: { a: 1 } } }, opts)).toThrow(/short text/);
	});
});

describe('sanitizeReason', () => {
	it('redacts tokens and bearer headers, flattens control characters and caps length', () => {
		const token = `ext_${'A'.repeat(43)}`;
		expect(sanitizeReason(`failed with ${token}`)).toBe('failed with [redacted]');
		expect(sanitizeReason('Authorization: Bearer abc.def')).toBe('Authorization: Bearer [redacted]');
		expect(sanitizeReason('a\n\tb')).toBe('a b');
		expect(sanitizeReason('x'.repeat(1000))).toHaveLength(300);
		expect(sanitizeReason(42)).toBe('');
	});
});

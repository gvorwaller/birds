/**
 * External sightings sources, Phase 1 (td-eec7db): the whole ingest lifecycle
 * against birds_test, driven by a fake connector through the real route
 * handlers (auth → body cap → contract → lifecycle → SQL).
 *
 * Fixture ownership (docs/agent-development-guide.md §3): every mutable row
 * belongs to this run — two sources `xt-<run>` / `xt2-<run>` with their own
 * connectors, region map rows and loads, and one user `xt-<run>`. Regions
 * (NO-18, NO-19) and taxonomy rows are only READ. Cleanup deletes by those
 * exact ids. The eBird frequency tables must have the same row counts after
 * every test.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadTestEnv, requireTestDb } from '$server/testing/test-env';
import { query, withTransaction } from '$lib/db';
import { newConnectorToken, tokenHash } from './auth';
import { allowedWindowEnds, rowsDigest, windowStartFor, MAX_BODY_BYTES } from './contract';
import { resetIngestRateForTest } from './http';
import { finishLoad, publishedCounts, putChunk, queueExternalLoad, sweepExternalStaging } from './lifecycle';
import { adminSources, rematchSource, removeTaxonOverride, revokeConnector, setTaxonOverride } from './admin';
import { lockSourceDerived } from './taxa';
import { externalLoadsForUser } from './jobs';
import { isPublicPath } from '../../../hooks.server';
import * as claimRoute from '../../../routes/api/ingest/loads/claim/+server';
import * as heartbeatRoute from '../../../routes/api/ingest/loads/[id]/heartbeat/+server';
import * as chunksRoute from '../../../routes/api/ingest/loads/[id]/chunks/+server';
import * as finishRoute from '../../../routes/api/ingest/loads/[id]/finish/+server';
import * as failRoute from '../../../routes/api/ingest/loads/[id]/fail/+server';

loadTestEnv();
await requireTestDb(query);

const RUN = `${process.pid.toString(36)}${Date.now().toString(36).slice(-5)}`;
const SRC = `xt-${RUN}`;
const SRC2 = `xt2-${RUN}`;
const REGION = 'NO-18';
const OTHER_REGION = 'NO-19';
const ROBIN_ID = `robin-${RUN}`;
const EIDER_ID = `eider-${RUN}`;
const EIDER_SYN_ID = `eidersyn-${RUN}`;
const FAKE_ID = `fake-${RUN}`;

let userId = 0;
let token = '';
let tokenId = 0;
let token2 = '';
let tokenOtherSource = '';
let robin = '';
let eider = '';
let otherCode = '';
const silence: unknown[] = [];
// The window every fixture load uses: the latest one allowed for a load queued
// now, by the DATABASE clock (loads are created with its now()), so the
// fixtures never age out at a month boundary.
let WINDOW_END = '';
let WINDOW_START = '';

const EBIRD_TABLES = ['species_frequency', 'species_month_freq', 'loc_month_samples', 'frequency_fetch'];
let ebirdBefore: Record<string, number> = {};

async function ebirdCounts(): Promise<Record<string, number>> {
	const out: Record<string, number> = {};
	for (const t of EBIRD_TABLES) out[t] = Number((await query<{ n: string }>(`SELECT COUNT(*) AS n FROM ${t}`)).rows[0].n);
	return out;
}

async function addConnector(source: string, label: string): Promise<{ token: string; id: number }> {
	const t = newConnectorToken();
	const r = await query<{ id: string }>(
		`INSERT INTO external_connectors (source_id, label, token_sha256) VALUES ($1, $2, $3) RETURNING id`,
		[source, label, tokenHash(t)]
	);
	return { token: t, id: Number(r.rows[0].id) };
}

async function cleanLoads(): Promise<void> {
	for (const table of [
		'external_records',
		'external_place_month_species',
		'external_unmatched',
		'external_recent_reports',
		'external_top_observers',
		'external_top_localities',
		'external_taxon_month',
		'external_place_month_totals',
		'external_places'
	]) {
		await query(`DELETE FROM ${table} WHERE source_id = ANY($1::text[])`, [[SRC, SRC2]]);
	}
	await query(`DELETE FROM external_taxon_overrides WHERE source_id = ANY($1::text[])`, [[SRC, SRC2]]);
	await query(`DELETE FROM external_taxa WHERE source_id = ANY($1::text[])`, [[SRC, SRC2]]);
	await query(`DELETE FROM external_loads WHERE source_id = ANY($1::text[])`, [[SRC, SRC2]]);
}

beforeAll(async () => {
	ebirdBefore = await ebirdCounts();
	const dbNow = (await query<{ now: Date }>('SELECT now() AS now')).rows[0].now;
	WINDOW_END = allowedWindowEnds(dbNow)[0];
	WINDOW_START = windowStartFor(WINDOW_END, 24);
	const sp = await query<{ species_code: string; sci_name: string }>(
		`SELECT species_code, sci_name FROM taxonomy_cache
		  WHERE category = 'species' AND sci_name IN ('Erithacus rubecula', 'Somateria mollissima', 'Pica pica')`
	);
	const bySci = new Map(sp.rows.map((r) => [r.sci_name, r.species_code]));
	robin = bySci.get('Erithacus rubecula') ?? '';
	eider = bySci.get('Somateria mollissima') ?? '';
	otherCode = bySci.get('Pica pica') ?? '';
	if (!robin || !eider || !otherCode) throw new Error('birds_test taxonomy lacks the fixture species (robin, eider, magpie)');

	userId = (
		await query<{ id: number }>(
			`INSERT INTO users (username, display_name, password_hash, role) VALUES ($1, $2, 'x', 'admin') RETURNING id`,
			[`xt-${RUN}`, `XT ${RUN}`]
		)
	).rows[0].id;
	for (const id of [SRC, SRC2]) {
		await query(
			`INSERT INTO external_sources (id, name, publisher, license, license_url, citation, attribution, record_semantics,
			                               homepage, covers_country, geo_scheme, window_months)
			 VALUES ($1, $2, 'Test publisher', 'CC BY 4.0', 'https://creativecommons.org/licenses/by/4.0/', 'Test citation',
			         'Test attribution', 'reports', 'https://example.org/', 'NO', 'TEST', 24)`,
			[id, `Test source ${id}`]
		);
		await query(
			`INSERT INTO external_region_map (source_id, upstream_key, region_code) VALUES ($1, 'T.18', $2), ($1, 'T.19', $3)`,
			[id, REGION, OTHER_REGION]
		);
	}
	// Twelve more regions for the job-list test (read-only borrowed region rows).
	await query(
		`INSERT INTO external_region_map (source_id, upstream_key, region_code)
		 SELECT $1, 'T.' || code, code FROM regions WHERE code = ANY($2::text[])`,
		[SRC, ['NO-01', 'NO-02', 'NO-03', 'NO-04', 'NO-05', 'NO-06', 'NO-07', 'NO-08', 'NO-09', 'NO-10', 'NO-11', 'NO-12']]
	);
	({ token, id: tokenId } = await addConnector(SRC, 'test-a'));
	token2 = (await addConnector(SRC, 'test-b')).token;
	tokenOtherSource = (await addConnector(SRC2, 'test-other')).token;
});

beforeEach(() => {
	resetIngestRateForTest();
	silence.length = 0;
});

afterEach(async () => {
	await cleanLoads();
	await query(`UPDATE external_sources SET store_observers = false, active = true WHERE id = ANY($1::text[])`, [[SRC, SRC2]]);
	expect(await ebirdCounts()).toEqual(ebirdBefore);
});

afterAll(async () => {
	await cleanLoads();
	await query(`DELETE FROM external_sources WHERE id = ANY($1::text[])`, [[SRC, SRC2]]);
	await query(`DELETE FROM users WHERE id = $1`, [userId]);
	const left = await query<{ n: string }>(
		`SELECT (SELECT COUNT(*) FROM external_sources WHERE id = ANY($1::text[]))
		      + (SELECT COUNT(*) FROM external_connectors WHERE source_id = ANY($1::text[]))
		      + (SELECT COUNT(*) FROM users WHERE id = $2) AS n`,
		[[SRC, SRC2], userId]
	);
	expect(Number(left.rows[0].n)).toBe(0);
});

// ── Fake connector ─────────────────────────────────────────────────────────

type Route = { POST: (event: never) => Response | Promise<Response> };
interface Call {
	status: number;
	body: Record<string, any> | null;
}

async function call(
	route: Route,
	loadId: string | null,
	body: unknown,
	opts: { token?: string | null; contentType?: string; raw?: string } = {}
): Promise<Call> {
	resetIngestRateForTest();
	const headers: Record<string, string> = { 'content-type': opts.contentType ?? 'application/json' };
	const t = opts.token === undefined ? token : opts.token;
	if (t) headers.authorization = `Bearer ${t}`;
	const request = new Request('http://localhost/api/ingest/x', {
		method: 'POST',
		headers,
		body: opts.raw ?? JSON.stringify(body)
	});
	const res = await route.POST({ request, params: { id: loadId ?? undefined } } as never);
	const text = await res.text();
	return { status: res.status, body: text ? JSON.parse(text) : null };
}

interface Lease {
	id: string;
	lease_token: string;
	attempt: number;
}

async function claim(key = `claim-${Math.random().toString(36).slice(2, 10)}`, t = token): Promise<Lease> {
	const r = await call(claimRoute, null, { contract_version: 1, idempotency_key: key }, { token: t });
	expect(r.status, JSON.stringify(r.body)).toBe(200);
	return r.body!.load as Lease;
}

const fence = (l: Lease) => ({ contract_version: 1, lease_token: l.lease_token, attempt: l.attempt });

async function chunk(l: Lease, chunkId: string, kind: string, rows: unknown[], t = token): Promise<Call> {
	return call(chunksRoute, l.id, { ...fence(l), chunk_id: chunkId, kind, sha256: rowsDigest(rows), rows }, { token: t });
}

const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

/** A small, internally consistent county dataset. */
function dataset(region = REGION) {
	const sub = `${region}:Nesna`;
	const places = [
		{ place_key: region, name: 'Nordland', level: 'region', parent_key: null, lat: null, lon: null, upstream_place_id: null as string | null },
		{ place_key: sub, name: 'Nesna', level: 'subregion', parent_key: region, lat: 66.2, lon: 13.0, upstream_place_id: null as string | null }
	];
	const taxa = [
		// June: robin 10 + eider 5 + eider synonym 2 + fake 1 + unkeyed 2 = 20 of 25 → gap of 5
		{ place_key: region, month: 6, upstream_taxon_id: ROBIN_ID, canonical_name: 'Erithacus rubecula', raw_name: 'Erithacus rubecula (Linnaeus, 1758)', rank: 'SPECIES', reports: 10 },
		{ place_key: region, month: 6, upstream_taxon_id: EIDER_ID, canonical_name: 'Somateria mollissima', raw_name: 'Somateria mollissima (Linnaeus, 1758)', rank: 'SPECIES', reports: 5 },
		{ place_key: region, month: 6, upstream_taxon_id: EIDER_SYN_ID, canonical_name: 'Somateria mollissima', raw_name: 'Somateria mollissima borealis', rank: 'SPECIES', reports: 2 },
		{ place_key: region, month: 6, upstream_taxon_id: FAKE_ID, canonical_name: 'Nonexistus fakeus', raw_name: 'Nonexistus fakeus', rank: 'SPECIES', reports: 1 },
		{ place_key: sub, month: 6, upstream_taxon_id: ROBIN_ID, canonical_name: 'Erithacus rubecula', raw_name: 'Erithacus rubecula (Linnaeus, 1758)', rank: 'SPECIES', reports: 4 }
	];
	const totals = places.flatMap((p) =>
		MONTHS.map((month) => ({
			place_key: p.place_key,
			month,
			reports: month === 6 ? (p.place_key === region ? 25 : 4) : 0,
			unkeyed: month === 6 && p.place_key === region ? 2 : 0
		}))
	);
	const localities = [
		{ place_key: sub, rank: 1, locality: 'Skogsøy, Nesna', reports: 4, lat: 66.2, lon: 13.0, uncertainty_m: 100, placement: 'pin' },
		{ place_key: sub, rank: 2, locality: 'Vassdal, Nesna', reports: 1, lat: null, lon: null, uncertainty_m: null, placement: 'text' }
	];
	const recent = [
		{ upstream_record_id: `r1-${RUN}`, place_key: sub, upstream_taxon_id: ROBIN_ID, canonical_name: 'Erithacus rubecula', observed_on: '2026-09-28', count: 1, locality: 'Skogsøy, Nesna', lat: 66.2, lon: 13.0, uncertainty_m: 100, generalized: false, record_url: 'https://www.artsobservasjoner.no/Sighting/1', observer: null },
		{ upstream_record_id: `r2-${RUN}`, place_key: region, upstream_taxon_id: FAKE_ID, canonical_name: 'Nonexistus fakeus', observed_on: '2026-09-29', count: null, locality: 'Somewhere, Bodø', lat: null, lon: null, uncertainty_m: null, generalized: true, record_url: 'https://www.artsobservasjoner.no/Sighting/2', observer: null }
	];
	const diagnostics = [{ code: 'unplaced_records', detail: 'Norskekysten hav N', count: 3 }];
	return { places, taxa, totals, localities, recent, diagnostics };
}

type Sent = { chunk_id: string; kind: string; rows: number; sha256: string };

async function sendAll(l: Lease, d = dataset(), order: (keyof ReturnType<typeof dataset>)[] = ['places', 'totals', 'taxa', 'localities', 'recent', 'diagnostics']): Promise<Sent[]> {
	const kindOf: Record<string, string> = { places: 'places', totals: 'totals', taxa: 'taxon_month', localities: 'localities', recent: 'recent', diagnostics: 'diagnostics' };
	const sent: Sent[] = [];
	for (const key of order) {
		const rows = d[key] as unknown[];
		const kind = kindOf[key];
		const r = await chunk(l, `${kind}-1`, kind, rows);
		expect(r.status, JSON.stringify(r.body)).toBe(200);
		sent.push({ chunk_id: `${kind}-1`, kind, rows: rows.length, sha256: rowsDigest(rows) });
	}
	return sent;
}

function manifest(sent: Sent[], over: Record<string, unknown> = {}, region = REGION) {
	const counts: Record<string, number> = {};
	for (const s of sent) counts[s.kind] = (counts[s.kind] ?? 0) + s.rows;
	return {
		window_start: WINDOW_START,
		window_end: WINDOW_END,
		retrieved_at: new Date().toISOString(),
		source_snapshot: { pubDate: '2026-10-10' },
		filter_fingerprint: 'c'.repeat(64),
		chunks: sent,
		counts,
		places: [region, `${region}:Nesna`],
		months: MONTHS,
		...over
	};
}

async function finish(l: Lease, m: unknown, t = token): Promise<Call> {
	return call(finishRoute, l.id, { ...fence(l), manifest: m }, { token: t });
}

async function loadRow(id: string) {
	return (
		await query<{ status: string; attempt: number; error: string | null; result: any; window_start: string | null }>(
			`SELECT status, attempt, error, result, to_char(window_start, 'YYYY-MM-DD') AS window_start FROM external_loads WHERE id = $1`,
			[id]
		)
	).rows[0];
}

async function stagingRows(loadId: string): Promise<number> {
	const r = await query<{ n: string }>(
		`SELECT (SELECT COUNT(*) FROM external_stage_places WHERE load_id = $1)
		      + (SELECT COUNT(*) FROM external_stage_totals WHERE load_id = $1)
		      + (SELECT COUNT(*) FROM external_stage_taxon_month WHERE load_id = $1)
		      + (SELECT COUNT(*) FROM external_stage_localities WHERE load_id = $1)
		      + (SELECT COUNT(*) FROM external_stage_recent WHERE load_id = $1)
		      + (SELECT COUNT(*) FROM external_stage_diagnostics WHERE load_id = $1)
		      + (SELECT COUNT(*) FROM external_stage_observers WHERE load_id = $1)
		      + (SELECT COUNT(*) FROM external_stage_taxa WHERE load_id = $1)
		      + (SELECT COUNT(*) FROM external_stage_records WHERE load_id = $1)
		      + (SELECT COUNT(*) FROM external_load_chunks WHERE load_id = $1) AS n`,
		[loadId]
	);
	return Number(r.rows[0].n);
}

/** Queue + claim + send + finish one complete load. */
async function publishOnce(d = dataset()): Promise<{ lease: Lease; result: any }> {
	await queueExternalLoad({ sourceId: SRC, regionCode: REGION, requestedBy: userId });
	const lease = await claim();
	const sent = await sendAll(lease, d);
	const f = await finish(lease, manifest(sent));
	expect(f.status, JSON.stringify(f.body)).toBe(200);
	return { lease, result: f.body!.result };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('hooks and HTTP surface', () => {
	it('opens exactly the /api/ingest/ prefix to token-only requests', () => {
		expect(isPublicPath('/api/ingest/loads/claim')).toBe(true);
		expect(isPublicPath('/api/ingest/loads/0b6f1f9e-4c1b-4c55-9a3e-7d2b1c0a9e11/finish')).toBe(true);
		expect(isPublicPath('/api/ingest')).toBe(false);
		expect(isPublicPath('/api/ingestx/loads/claim')).toBe(false);
		expect(isPublicPath('/api/ingest-admin')).toBe(false);
		expect(isPublicPath('/api/jobs')).toBe(false);
	});

	it('exports POST only from every ingest route (other methods get 405)', () => {
		for (const mod of [claimRoute, heartbeatRoute, chunksRoute, finishRoute, failRoute]) {
			expect(Object.keys(mod).sort()).toEqual(['POST']);
		}
	});

	it('refuses missing, unknown, revoked and inactive-source tokens before reading the body', async () => {
		const body = { contract_version: 1, idempotency_key: 'claim-auth-1' };
		expect((await call(claimRoute, null, body, { token: null })).status).toBe(401);
		expect((await call(claimRoute, null, body, { token: newConnectorToken() })).body!.error).toBe('unknown');
		expect((await call(claimRoute, null, body, { token: 'not-a-token' })).status).toBe(401);
		const c = await addConnector(SRC, 'test-revoked');
		await revokeConnector(c.id);
		expect((await call(claimRoute, null, body, { token: c.token })).body!.error).toBe('revoked');
		await query(`UPDATE external_sources SET active = false WHERE id = $1`, [SRC]);
		expect((await call(claimRoute, null, body, { token })).body!.error).toBe('inactive');
		// The 401 is decided before parsing: a malformed body still gets 401.
		expect((await call(claimRoute, null, null, { token: null, raw: '{not json' })).status).toBe(401);
	});

	it('requires JSON, caps the body before parsing and rejects malformed JSON', async () => {
		expect((await call(claimRoute, null, {}, { contentType: 'text/plain' })).status).toBe(415);
		const big = JSON.stringify({ contract_version: 1, idempotency_key: 'claim-big-1', pad: 'x'.repeat(MAX_BODY_BYTES) });
		expect((await call(claimRoute, null, null, { raw: big })).status).toBe(413);
		expect((await call(claimRoute, null, null, { raw: '{"contract_version":' })).status).toBe(400);
		expect((await call(claimRoute, null, { contract_version: 1, idempotency_key: 'claim-x-1', extra: 1 })).status).toBe(422);
	});

	it('answers 429 with Retry-After when a connector floods the API', async () => {
		resetIngestRateForTest();
		const statuses: number[] = [];
		for (let i = 0; i < 25; i++) {
			const res = await claimRoute.POST({
				request: new Request('http://localhost/x', {
					method: 'POST',
					headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
					body: JSON.stringify({ contract_version: 1, idempotency_key: `claim-flood-${i}` })
				}),
				params: {}
			} as never);
			statuses.push(res.status);
			if (res.status === 429) expect(res.headers.get('retry-after')).toBe('1');
		}
		expect(statuses).toContain(429);
	});

	it('404s a load id that is not a uuid or does not exist, 403s another source', async () => {
		const fake = { contract_version: 1, lease_token: '0b6f1f9e-4c1b-4c55-9a3e-7d2b1c0a9e11', attempt: 1, progress: { phase: 'x', done: 0, total: 0 } };
		expect((await call(heartbeatRoute, 'not-a-uuid', fake)).status).toBe(404);
		expect((await call(heartbeatRoute, '0b6f1f9e-4c1b-4c55-9a3e-7d2b1c0a9e11', fake)).status).toBe(404);
		await queueExternalLoad({ sourceId: SRC, regionCode: REGION, requestedBy: null });
		const l = await claim();
		const r = await call(heartbeatRoute, l.id, { ...fence(l), progress: { phase: 'x', done: 0, total: 0 } }, { token: tokenOtherSource });
		expect(r.status).toBe(403);
		expect(r.body!.error).toBe('wrong_source');
	});
});

describe('lifecycle', () => {
	it('publishes a complete load: places, totals, summed species, unmatched, localities, recent, gaps', async () => {
		const { lease, result } = await publishOnce();
		expect(result.places).toBe(2);
		expect(result.species).toBe(2);
		expect(result.unmatched_taxa).toBe(1);
		expect(result.unmatched_reports).toBe(1);
		expect(result.gaps).toEqual({ place_months: 1, reports: 5 });
		expect(result.diagnostics).toEqual([{ code: 'unplaced_records', notes: 1, count: 3 }]);
		expect(result.window).toEqual({ start: WINDOW_START, end: WINDOW_END });

		const counts = await publishedCounts(SRC, REGION);
		expect(counts).toEqual({
			external_records: 0,
			external_place_month_species: 3,
			external_unmatched: 1,
			external_recent_reports: 2,
			external_top_localities: 2,
			external_top_observers: 0,
			external_taxon_month: 5,
			external_place_month_totals: 24,
			external_places: 2
		});
		// Two upstream taxa for one eBird species are SUMMED [C-P1-4].
		const eiderRow = await query<{ reports: number }>(
			`SELECT reports FROM external_place_month_species WHERE source_id = $1 AND place_key = $2 AND species_code = $3 AND month = 6`,
			[SRC, REGION, eider]
		);
		expect(eiderRow.rows[0].reports).toBe(7);
		const rec = await query<{ upstream_record_id: string; species_code: string | null }>(
			`SELECT upstream_record_id, species_code FROM external_recent_reports WHERE source_id = $1 ORDER BY upstream_record_id`,
			[SRC]
		);
		expect(rec.rows.map((r) => r.species_code)).toEqual([robin, null]);

		const row = await loadRow(lease.id);
		expect(row.status).toBe('done');
		expect(row.window_start).toBe(WINDOW_START);
		expect(await stagingRows(lease.id)).toBe(0);
	});

	it('returns the stored result for a finish repeated after a lost response', async () => {
		await queueExternalLoad({ sourceId: SRC, regionCode: REGION, requestedBy: null });
		const lease = await claim();
		const sent = await sendAll(lease);
		const first = await finish(lease, manifest(sent));
		const again = await finish(lease, manifest(sent));
		expect(again.status).toBe(200);
		expect(again.body).toEqual(first.body);
	});

	it('accepts chunks in any order and treats a repeated chunk as a duplicate', async () => {
		await queueExternalLoad({ sourceId: SRC, regionCode: REGION, requestedBy: null });
		const lease = await claim();
		const d = dataset();
		const sent = await sendAll(lease, d, ['recent', 'taxa', 'totals', 'diagnostics', 'localities', 'places']);
		const dup = await chunk(lease, 'totals-1', 'totals', d.totals);
		expect(dup.body).toEqual({ status: 'duplicate' });
		const changed = await chunk(lease, 'totals-1', 'totals', d.totals.map((t, i) => (i === 0 ? { ...t, reports: t.reports + 1 } : t)));
		expect(changed.status).toBe(409);
		expect(changed.body!.error).toBe('chunk_conflict');
		expect((await finish(lease, manifest(sent))).status).toBe(200);
	});

	it('refuses a row that repeats a row from an earlier chunk', async () => {
		await queueExternalLoad({ sourceId: SRC, regionCode: REGION, requestedBy: null });
		const lease = await claim();
		const d = dataset();
		expect((await chunk(lease, 'totals-a', 'totals', d.totals.slice(0, 3))).status).toBe(200);
		const r = await chunk(lease, 'totals-b', 'totals', d.totals.slice(2, 5));
		expect(r.status).toBe(422);
		expect(r.body!.error).toBe('duplicate_row');
	});

	it('keeps the previous data published when a manifest is incomplete or wrong', async () => {
		const { result: before } = await publishOnce();
		const countsBefore = await publishedCounts(SRC, REGION);
		await queueExternalLoad({ sourceId: SRC, regionCode: REGION, requestedBy: null });
		const lease = await claim();
		const sent = await sendAll(lease);

		const missing = await finish(lease, manifest([...sent, { chunk_id: 'never-sent', kind: 'totals', rows: 1, sha256: 'd'.repeat(64) }]));
		expect(missing.status).toBe(422);
		expect(missing.body!.message).toMatch(/never received/);
		const extra = await finish(lease, manifest(sent.slice(1)));
		expect(extra.body!.message).toMatch(/not in the manifest/);
		const badCount = await finish(lease, manifest(sent, { counts: { places: 2 } }));
		expect(badCount.status).toBe(422);
		const badPlaces = await finish(lease, manifest(sent, { places: [REGION] }));
		expect(badPlaces.body!.message).toMatch(/places differ/);
		const shortWindow = await finish(lease, manifest(sent, { window_start: windowStartFor(WINDOW_END, 23) }));
		expect(shortWindow.body!.error).toBe('invalid_manifest');

		expect(await publishedCounts(SRC, REGION)).toEqual(countsBefore);
		expect((await loadRow(lease.id)).status).toBe('staging');
		expect(before.places).toBe(2);
	});

	it('requires a total for every place and month, and species never above the total', async () => {
		await queueExternalLoad({ sourceId: SRC, regionCode: REGION, requestedBy: null });
		let lease = await claim();
		const d = dataset();
		d.totals = d.totals.filter((t) => !(t.place_key === `${REGION}:Nesna` && t.month === 12));
		let sent = await sendAll(lease, d);
		const r = await finish(lease, manifest(sent));
		expect(r.body!.error).toBe('totals_incomplete');
		await call(failRoute, lease.id, { ...fence(lease), reason: 'test', retryable: false });

		await queueExternalLoad({ sourceId: SRC, regionCode: REGION, requestedBy: null });
		lease = await claim();
		const over = dataset();
		over.totals = over.totals.map((t) => (t.place_key === REGION && t.month === 6 ? { ...t, reports: 10, unkeyed: 2 } : t));
		sent = await sendAll(lease, over);
		const r2 = await finish(lease, manifest(sent));
		expect(r2.status).toBe(422);
		expect(r2.body!.error).toBe('totals_inconsistent');
	});

	it('rejects rows naming a place that was never sent', async () => {
		await queueExternalLoad({ sourceId: SRC, regionCode: REGION, requestedBy: null });
		const lease = await claim();
		const d = dataset();
		d.taxa = [...d.taxa, { ...d.taxa[0], place_key: `${REGION}:Ghost` }];
		const sent = await sendAll(lease, d);
		const r = await finish(lease, manifest(sent));
		expect(r.body!.error).toBe('unknown_place');
	});

	it('refuses rows for another region with 403', async () => {
		await queueExternalLoad({ sourceId: SRC, regionCode: REGION, requestedBy: null });
		const lease = await claim();
		const r = await chunk(lease, 'totals-x', 'totals', [{ place_key: OTHER_REGION, month: 1, reports: 1, unkeyed: 0 }]);
		expect(r.status).toBe(403);
	});

	it('publishes an empty but complete load (zero totals, no taxa)', async () => {
		await queueExternalLoad({ sourceId: SRC, regionCode: REGION, requestedBy: null });
		const lease = await claim();
		const places = [{ place_key: REGION, name: 'Nordland', level: 'region', parent_key: null, lat: null, lon: null, upstream_place_id: null }];
		const totals = MONTHS.map((month) => ({ place_key: REGION, month, reports: 0, unkeyed: 0 }));
		const sent: Sent[] = [];
		for (const [kind, rows] of [['places', places], ['totals', totals]] as const) {
			expect((await chunk(lease, `${kind}-1`, kind, rows as unknown[])).status).toBe(200);
			sent.push({ chunk_id: `${kind}-1`, kind, rows: rows.length, sha256: rowsDigest(rows as unknown[]) });
		}
		const r = await finish(lease, manifest(sent, { places: [REGION] }));
		expect(r.status, JSON.stringify(r.body)).toBe(200);
		expect(r.body!.result.species).toBe(0);
		expect((await publishedCounts(SRC, REGION)).external_place_month_totals).toBe(12);
	});

	it('rolls back a failure in the middle of the swap, leaving the old data and the staging', async () => {
		await publishOnce();
		const before = await publishedCounts(SRC, REGION);
		await queueExternalLoad({ sourceId: SRC, regionCode: REGION, requestedBy: null });
		const lease = await claim();
		const d = dataset();
		d.taxa = d.taxa.filter((t) => t.upstream_taxon_id !== FAKE_ID);
		d.totals = d.totals.map((t) => (t.place_key === REGION && t.month === 6 ? { ...t, reports: 24 } : t));
		const sent = await sendAll(lease, d);
		const staged = await stagingRows(lease.id);
		const connector = { connectorId: tokenId, sourceId: SRC, storeObservers: false };
		await expect(
			finishLoad(connector, lease.id, { lease_token: lease.lease_token, attempt: lease.attempt }, manifest(sent), { failAfterSwapForTest: true })
		).rejects.toThrow(/middle of the swap/);
		expect(await publishedCounts(SRC, REGION)).toEqual(before);
		expect((await loadRow(lease.id)).status).toBe('staging');
		expect(await stagingRows(lease.id)).toBe(staged);
		const ok = await finish(lease, manifest(sent));
		expect(ok.status).toBe(200);
		expect((await publishedCounts(SRC, REGION)).external_taxon_month).toBe(4);
		expect(await query(`SELECT 1 FROM external_loads WHERE source_id = $1 AND status = 'superseded'`, [SRC]).then((r) => r.rowCount)).toBe(1);
	});

	it('marks a failed load and requeues a retryable one with backoff', async () => {
		await queueExternalLoad({ sourceId: SRC, regionCode: REGION, requestedBy: null });
		const lease = await claim();
		await sendAll(lease);
		const r = await call(failRoute, lease.id, { ...fence(lease), reason: `GBIF 503 with ext_${'B'.repeat(43)}`, retryable: true });
		expect(r.body).toEqual({ status: 'queued' });
		const row = await loadRow(lease.id);
		expect(row.status).toBe('queued');
		expect(row.error).toBe('GBIF 503 with [redacted]');
		expect(await stagingRows(lease.id)).toBe(0);
		// Backoff: not claimable yet.
		expect((await call(claimRoute, null, { contract_version: 1, idempotency_key: 'claim-backoff' })).status).toBe(204);
	});
});

describe('fencing and races', () => {
	it('gives one load to one of two claimers for the same county, and a second queue request returns it', async () => {
		const a = await queueExternalLoad({ sourceId: SRC, regionCode: REGION, requestedBy: null });
		const b = await queueExternalLoad({ sourceId: SRC, regionCode: REGION, requestedBy: null });
		expect(b).toEqual({ loadId: a.loadId, created: false });
		const [r1, r2] = await Promise.all([
			call(claimRoute, null, { contract_version: 1, idempotency_key: 'claim-race-a' }, { token }),
			call(claimRoute, null, { contract_version: 1, idempotency_key: 'claim-race-b' }, { token: token2 })
		]);
		expect([r1.status, r2.status].sort()).toEqual([200, 204]);
	});

	it('returns the same lease for a repeated idempotency key', async () => {
		await queueExternalLoad({ sourceId: SRC, regionCode: REGION, requestedBy: null });
		const first = await claim('claim-same-key');
		const again = await claim('claim-same-key');
		expect(again).toEqual(first);
	});

	it('fences a stale writer after its lease expired and the load was re-claimed', async () => {
		await queueExternalLoad({ sourceId: SRC, regionCode: REGION, requestedBy: null });
		const old = await claim();
		expect((await chunk(old, 'places-1', 'places', dataset().places)).status).toBe(200);
		await query(`UPDATE external_loads SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [old.id]);
		const expired = await chunk(old, 'totals-1', 'totals', dataset().totals);
		expect(expired.status).toBe(409);
		expect(expired.body!.error).toBe('lease_expired');

		// The next claim returns it to the queue (staging discarded) with a backoff.
		expect((await call(claimRoute, null, { contract_version: 1, idempotency_key: 'claim-after-expiry' })).status).toBe(204);
		expect(await stagingRows(old.id)).toBe(0);
		await query(`UPDATE external_loads SET not_before = now() WHERE id = $1`, [old.id]);
		const fresh = await claim('claim-restart', token2);
		expect(fresh.attempt).toBe(2);
		const stale = await chunk(old, 'places-1', 'places', dataset().places);
		expect(stale.status).toBe(409);
		expect(stale.body!.error).toBe('fenced');
		const staleFinish = await finish(old, manifest([]));
		expect(staleFinish.status).toBe(409);
	});

	it('gives a load up after max_attempts expired leases', async () => {
		const { loadId } = await queueExternalLoad({ sourceId: SRC, regionCode: REGION, requestedBy: null });
		for (let i = 1; i <= 3; i++) {
			const l = await claim();
			expect(l.attempt).toBe(i);
			await query(`UPDATE external_loads SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [loadId]);
			// The next claim requeues it with a backoff; skip the wait.
			expect((await call(claimRoute, null, { contract_version: 1, idempotency_key: `claim-expire-${i}` })).status).toBe(204);
			await query(`UPDATE external_loads SET not_before = now() WHERE id = $1 AND status = 'queued'`, [loadId]);
		}
		expect((await call(claimRoute, null, { contract_version: 1, idempotency_key: 'claim-giveup' })).status).toBe(204);
		const row = await loadRow(loadId);
		expect(row.status).toBe('failed');
		expect(row.error).toMatch(/3 attempts/);
	});

	it('refuses a chunk that arrives while finish holds the load', async () => {
		await queueExternalLoad({ sourceId: SRC, regionCode: REGION, requestedBy: null });
		const lease = await claim();
		await sendAll(lease);
		let release: () => void = () => {};
		const held = new Promise<void>((r) => (release = r));
		let locked: () => void = () => {};
		const isLocked = new Promise<void>((r) => (locked = r));
		const finisher = withTransaction(async (c) => {
			await c.query(`SELECT 1 FROM external_loads WHERE id = $1 FOR UPDATE`, [lease.id]);
			locked();
			await held;
			await c.query(`UPDATE external_loads SET status = 'done', result = '{}'::jsonb, finished_at = now() WHERE id = $1`, [lease.id]);
		});
		await isLocked;
		const late = chunk(lease, 'late-1', 'diagnostics', [{ code: 'late', detail: '', count: 1 }]);
		await new Promise((r) => setTimeout(r, 150));
		release();
		await finisher;
		const r = await late;
		expect(r.status).toBe(409);
		expect(r.body!.error).toBe('not_leased');
	});

	it('refuses every call once the token is revoked mid-load, so the load can never publish', async () => {
		const c = await addConnector(SRC, 'test-midload');
		await queueExternalLoad({ sourceId: SRC, regionCode: REGION, requestedBy: null });
		const lease = await claim('claim-midload', c.token);
		const d = dataset();
		expect((await chunk(lease, 'places-1', 'places', d.places, c.token)).status).toBe(200);
		await revokeConnector(c.id);
		expect((await chunk(lease, 'totals-1', 'totals', d.totals, c.token)).status).toBe(401);
		expect((await finish(lease, manifest([]), c.token)).status).toBe(401);
		expect((await loadRow(lease.id)).status).toBe('staging');
	});

	it('lets a restarted connector pick its load up again only after the lease lapses', async () => {
		await queueExternalLoad({ sourceId: SRC, regionCode: REGION, requestedBy: null });
		const before = await claim('claim-before-crash');
		// Restart: new idempotency key, old lease still live → nothing to claim.
		expect((await call(claimRoute, null, { contract_version: 1, idempotency_key: 'claim-after-crash' })).status).toBe(204);
		await query(`UPDATE external_loads SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [before.id]);
		await call(claimRoute, null, { contract_version: 1, idempotency_key: 'claim-requeue' });
		await query(`UPDATE external_loads SET not_before = now() WHERE id = $1`, [before.id]);
		const after = await claim('claim-after-crash-2');
		expect(after.id).toBe(before.id);
		expect(after.attempt).toBe(2);
		const sent = await sendAll(after);
		expect((await finish(after, manifest(sent))).status).toBe(200);
	});
});

describe('sweeper', () => {
	it('removes week-old staging no live lease holds, never staging under a live lease', async () => {
		const a = await queueExternalLoad({ sourceId: SRC, regionCode: REGION, requestedBy: null });
		const la = await claim();
		await chunk(la, 'places-1', 'places', dataset().places);
		const b = await queueExternalLoad({ sourceId: SRC, regionCode: OTHER_REGION, requestedBy: null });
		const lb = await claim();
		await chunk(lb, 'places-1', 'places', dataset(OTHER_REGION).places);
		await query(`UPDATE external_load_chunks SET received_at = now() - interval '8 days' WHERE load_id = ANY($1::uuid[])`, [[a.loadId, b.loadId]]);
		// a: abandoned (status left as failed without cleanup); b: still leased and live.
		await query(`UPDATE external_loads SET status = 'failed', finished_at = now() WHERE id = $1`, [a.loadId]);
		expect(await sweepExternalStaging([a.loadId, b.loadId])).toBe(1);
		expect(await stagingRows(a.loadId)).toBe(0);
		expect(await stagingRows(lb.id)).toBeGreaterThan(0);
	});
});

describe('taxon matching and overrides', () => {
	it('matches an unmatched taxon by override and rebuilds species and recent reports without a fetch', async () => {
		await publishOnce();
		const r = await setTaxonOverride({ sourceId: SRC, upstreamTaxonId: FAKE_ID, species: otherCode, userId });
		expect(r.speciesCode).toBe(otherCode);
		const sp = await query<{ reports: number }>(
			`SELECT reports FROM external_place_month_species WHERE source_id = $1 AND species_code = $2 AND place_key = $3 AND month = 6`,
			[SRC, otherCode, REGION]
		);
		expect(sp.rows[0].reports).toBe(1);
		expect((await publishedCounts(SRC, REGION)).external_unmatched).toBe(0);
		const rec = await query<{ species_code: string }>(
			`SELECT species_code FROM external_recent_reports WHERE source_id = $1 AND upstream_record_id = $2`,
			[SRC, `r2-${RUN}`]
		);
		expect(rec.rows[0].species_code).toBe(otherCode);

		// The override also applies to the next load.
		const next = await publishOnce();
		expect(next.result.unmatched_taxa).toBe(0);

		expect(await removeTaxonOverride(SRC, FAKE_ID)).toBe(true);
		expect((await publishedCounts(SRC, REGION)).external_unmatched).toBe(1);
		const recAfter = await query<{ species_code: string | null }>(
			`SELECT species_code FROM external_recent_reports WHERE source_id = $1 AND upstream_record_id = $2`,
			[SRC, `r2-${RUN}`]
		);
		expect(recAfter.rows[0].species_code).toBeNull();
	});

	it('refuses an override to something that is not an eBird species', async () => {
		await publishOnce();
		await expect(setTaxonOverride({ sourceId: SRC, upstreamTaxonId: FAKE_ID, species: 'Not a bird at all', userId })).rejects.toThrow(/not an eBird species/);
	});

	it('refuses an upstream id sent under two names in one load', async () => {
		await queueExternalLoad({ sourceId: SRC, regionCode: REGION, requestedBy: null });
		const lease = await claim();
		const d = dataset();
		d.recent = d.recent.map((r) => (r.upstream_taxon_id === ROBIN_ID ? { ...r, canonical_name: 'Erithacus rubeculus' } : r));
		const sent = await sendAll(lease, d);
		expect((await finish(lease, manifest(sent))).body!.error).toBe('taxon_name_conflict');
	});
});

describe('observer column', () => {
	it('is refused unless the source stores observers', async () => {
		await queueExternalLoad({ sourceId: SRC, regionCode: REGION, requestedBy: null });
		const lease = await claim();
		const row = { ...dataset().recent[0], observer: 'Kari Nordmann' };
		const r = await chunk(lease, 'recent-obs', 'recent', [row]);
		expect(r.status).toBe(422);
		expect(r.body!.error).toBe('observer');
		await query(`UPDATE external_sources SET store_observers = true WHERE id = $1`, [SRC]);
		expect((await chunk(lease, 'recent-obs', 'recent', [row])).status).toBe(200);
	});
});

describe('observers (Phase 2 rev B)', () => {
	const obs = (place_key: string, rank: number, observer: string, days: number) => ({ place_key, rank, observer, days, species: 1, localities: 1, reports: days * 2 });

	it('are refused from a source that does not store observers', async () => {
		await queueExternalLoad({ sourceId: SRC, regionCode: REGION, requestedBy: null });
		const lease = await claim();
		const r = await chunk(lease, 'observers-1', 'observers', [obs(REGION, 1, 'Kari Nordmann', 3)]);
		expect(r.status).toBe(422);
		expect(r.body!.error).toBe('observer');
	});

	it('publish with the county and are replaced whole by the next load', async () => {
		await query(`UPDATE external_sources SET store_observers = true WHERE id = $1`, [SRC]);
		const send = async (rows: unknown[]) => {
			await queueExternalLoad({ sourceId: SRC, regionCode: REGION, requestedBy: null });
			const lease = await claim();
			const sent = await sendAll(lease);
			if (rows.length) {
				expect((await chunk(lease, 'observers-1', 'observers', rows)).status).toBe(200);
				sent.push({ chunk_id: 'observers-1', kind: 'observers', rows: rows.length, sha256: rowsDigest(rows) });
			}
			const f = await finish(lease, manifest(sent));
			expect(f.status, JSON.stringify(f.body)).toBe(200);
			return f.body!.result as { counts: Record<string, number> };
		};
		const result = await send([obs(REGION, 1, 'Kari Nordmann', 5), obs(REGION, 2, 'Ola Nordmann', 2), obs(`${REGION}:Nesna`, 1, 'Kari Nordmann', 4)]);
		expect(result.counts.observers).toBe(3);
		const published = await query<{ place_key: string; observer: string; rank: number }>(
			`SELECT place_key, observer, rank FROM external_top_observers WHERE source_id = $1 ORDER BY place_key, rank`,
			[SRC]
		);
		expect(published.rows).toEqual([
			{ place_key: REGION, observer: 'Kari Nordmann', rank: 1 },
			{ place_key: REGION, observer: 'Ola Nordmann', rank: 2 },
			{ place_key: `${REGION}:Nesna`, observer: 'Kari Nordmann', rank: 1 }
		]);
		await send([]);
		expect((await query(`SELECT 1 FROM external_top_observers WHERE source_id = $1`, [SRC])).rowCount).toBe(0);
	});

	it('switched off after the names were staged: finish refuses to publish them (CODEX1 rev B finding 2)', async () => {
		await query(`UPDATE external_sources SET store_observers = true WHERE id = $1`, [SRC]);
		await queueExternalLoad({ sourceId: SRC, regionCode: REGION, requestedBy: null });
		const lease = await claim();
		const sent = await sendAll(lease);
		const rows = [obs(REGION, 1, 'Kari Nordmann', 5)];
		expect((await chunk(lease, 'observers-1', 'observers', rows)).status).toBe(200);
		sent.push({ chunk_id: 'observers-1', kind: 'observers', rows: 1, sha256: rowsDigest(rows) });
		await query(`UPDATE external_sources SET store_observers = false WHERE id = $1`, [SRC]);
		const f = await finish(lease, manifest(sent));
		expect(f.status).toBe(422);
		expect(f.body!.error).toBe('observer');
		expect((await query(`SELECT 1 FROM external_top_observers WHERE source_id = $1`, [SRC])).rowCount).toBe(0);
		expect((await query(`SELECT 1 FROM external_places WHERE source_id = $1`, [SRC])).rowCount).toBe(0);
	});

	it('a recent report naming an observer is refused at finish too once the flag is off', async () => {
		await query(`UPDATE external_sources SET store_observers = true WHERE id = $1`, [SRC]);
		await queueExternalLoad({ sourceId: SRC, regionCode: REGION, requestedBy: null });
		const lease = await claim();
		const d = dataset();
		(d as { recent: unknown[] }).recent = d.recent.map((r, i) => (i === 0 ? { ...r, observer: 'Kari Nordmann' } : r));
		const sent = await sendAll(lease, d);
		await query(`UPDATE external_sources SET store_observers = false WHERE id = $1`, [SRC]);
		const f = await finish(lease, manifest(sent));
		expect(f.status).toBe(422);
		expect(f.body!.error).toBe('observer');
		expect((await query(`SELECT 1 FROM external_recent_reports WHERE source_id = $1`, [SRC])).rowCount).toBe(0);
	});

	it('a chunk is checked against the flag as it is now, not as it was when the token was read', async () => {
		await queueExternalLoad({ sourceId: SRC, regionCode: REGION, requestedBy: null });
		const lease = await claim();
		// Authentication saw the flag on; it has since been switched off (false in the DB).
		const stale = { connectorId: tokenId, sourceId: SRC, storeObservers: true };
		const rows = [obs(REGION, 1, 'Kari Nordmann', 5)];
		await expect(
			putChunk(stale, lease.id, { lease_token: lease.lease_token, attempt: lease.attempt }, { chunk_id: 'observers-1', kind: 'observers', sha256: rowsDigest(rows), rows }, 100)
		).rejects.toMatchObject({ code: 'observer' });
		expect((await query(`SELECT 1 FROM external_stage_observers WHERE load_id = $1`, [lease.id])).rowCount).toBe(0);
	});

	it('an observer listed twice for one place is refused', async () => {
		await query(`UPDATE external_sources SET store_observers = true WHERE id = $1`, [SRC]);
		await queueExternalLoad({ sourceId: SRC, regionCode: REGION, requestedBy: null });
		const lease = await claim();
		const r = await chunk(lease, 'observers-1', 'observers', [obs(REGION, 1, 'Kari Nordmann', 5), obs(REGION, 2, 'Kari Nordmann', 2)]);
		expect(r.status).toBe(422);
		expect(r.body!.error).toBe('duplicate_row');
	});
});

describe('subspecies matching (Phase 2 rev B)', () => {
	it("matches an eBird issf to the species eBird reports it as, and never rolls a subspecies up to its binomial", async () => {
		const codes = await query<{ sci_name: string; species_code: string }>(
			`SELECT sci_name, species_code FROM taxonomy_cache WHERE sci_name IN ('Anas crecca', 'Anas crecca carolinensis', 'Somateria mollissima fakeus')`
		);
		const by = Object.fromEntries(codes.rows.map((r) => [r.sci_name, r.species_code]));
		expect(by['Anas crecca carolinensis']).toBeDefined();
		expect(by['Somateria mollissima fakeus']).toBeUndefined();
		await queueExternalLoad({ sourceId: SRC, regionCode: REGION, requestedBy: null });
		const lease = await claim();
		const d = dataset();
		const sub = (id: string, canonical: string, raw: string) => ({ place_key: REGION, month: 6, upstream_taxon_id: id, canonical_name: canonical, raw_name: raw, rank: 'SUBSPECIES', reports: 1 });
		d.taxa = [
			...d.taxa,
			sub(`teal-${RUN}`, 'Anas crecca carolinensis', 'Anas crecca subsp. carolinensis'),
			sub(`eidersub-${RUN}`, 'Somateria mollissima fakeus', 'Somateria mollissima subsp. fakeus')
		] as typeof d.taxa;
		d.totals = d.totals.map((t) => (t.place_key === REGION && t.month === 6 ? { ...t, reports: t.reports + 2 } : t));
		const f = await finish(lease, manifest(await sendAll(lease, d)));
		expect(f.status, JSON.stringify(f.body)).toBe(200);
		const species = await query<{ species_code: string; reports: number }>(
			`SELECT species_code, reports FROM external_place_month_species WHERE source_id = $1 AND place_key = $2 AND month = 6`,
			[SRC, REGION]
		);
		expect(species.rows.find((r) => r.species_code === by['Anas crecca'])?.reports).toBe(1);
		const unmatched = await query<{ canonical_name: string; reason: string }>(
			`SELECT canonical_name, reason FROM external_unmatched WHERE source_id = $1 AND upstream_taxon_id = $2`,
			[SRC, `eidersub-${RUN}`]
		);
		expect(unmatched.rows).toEqual([{ canonical_name: 'Somateria mollissima fakeus', reason: 'no_match' }]);
	});
});

describe('records and taxa (td-769300)', () => {
	const GULLS_ID = `gulls-${RUN}`;
	const taxa = () => [
		{ upstream_taxon_id: ROBIN_ID, canonical_name: 'Erithacus rubecula', raw_name: 'Erithacus rubecula', rank: 'SPECIES', local_name: 'rødstrupe', red_list: 'LC', red_list_url: 'https://artsdatabanken.no/lister/rodlisteforarter/2021/1' },
		{ upstream_taxon_id: FAKE_ID, canonical_name: 'Nonexistus fakeus', raw_name: 'Nonexistus fakeus', rank: 'SPECIES', local_name: null, red_list: null, red_list_url: null },
		{ upstream_taxon_id: GULLS_ID, canonical_name: 'Laridae', raw_name: 'Laridae', rank: 'OTHER', local_name: 'måkefamilien', red_list: null, red_list_url: null }
	];
	const record = (id: string, over: Record<string, unknown> = {}) => ({
		upstream_record_id: `${id}-${RUN}`,
		place_key: `${REGION}:Nesna`,
		upstream_taxon_id: ROBIN_ID,
		canonical_name: 'Erithacus rubecula',
		observed_on: '2026-06-03',
		count: 2,
		locality: 'Skogsøy, Nesna, No',
		lat: 66.2,
		lon: 13.0,
		uncertainty_m: 300,
		observers: [],
		behaviour: ['feeding'],
		activity: 'Forage',
		validation: 'Approved Documented',
		notes: 'Activity: Forage. Validationstatus: Approved Documented',
		sex: 'male',
		photos: [{ url: 'https://www.artsobservasjoner.no/MediaLibrary/2026/6/x.jpg', by: null as string | null }],
		dataset: null,
		record_url: 'https://www.artsobservasjoner.no/Sighting/9',
		upstream_modified_at: '2026-06-04T07:01:02.123456',
		...over
	});
	const records = () => [
		record('rec1'),
		record('rec2', { place_key: REGION, upstream_taxon_id: FAKE_ID, canonical_name: 'Nonexistus fakeus', count: null, locality: null, lat: null, lon: null, uncertainty_m: null, behaviour: [], activity: null, validation: null, notes: null, sex: null, photos: null, record_url: null, upstream_modified_at: null }),
		record('rec3', { upstream_taxon_id: GULLS_ID, canonical_name: 'Laridae', photos: null })
	];

	/** One full load with taxa and records, on top of the usual dataset. */
	async function publishRecords(opts: { region?: string; taxaRows?: unknown[]; recordRows?: unknown[]; expectStatus?: number; data?: ReturnType<typeof dataset> } = {}) {
		const region = opts.region ?? REGION;
		await queueExternalLoad({ sourceId: SRC, regionCode: region, requestedBy: null });
		const lease = await claim();
		const sent = await sendAll(lease, opts.data ?? dataset(region));
		const taxaRows = opts.taxaRows ?? taxa();
		const recordRows = opts.recordRows ?? records();
		for (const [kind, rows] of [['taxa', taxaRows], ['records', recordRows]] as const) {
			if (rows.length === 0) continue;
			const r = await chunk(lease, `${kind}-1`, kind, rows as unknown[]);
			expect(r.status, JSON.stringify(r.body)).toBe(200);
			sent.push({ chunk_id: `${kind}-1`, kind, rows: rows.length, sha256: rowsDigest(rows as unknown[]) });
		}
		const f = await finish(lease, manifest(sent, {}, region));
		expect(f.status, JSON.stringify(f.body)).toBe(opts.expectStatus ?? 200);
		// A refused finish leaves the load leased; release it so the next one can be claimed.
		if (f.status !== 200) await call(failRoute, lease.id, { ...fence(lease), reason: 'test', retryable: false });
		return { lease, f };
	}

	it('publishes every record with its details, and each taxon once with its species code', async () => {
		const { lease, f } = await publishRecords();
		expect(f.body!.result.counts).toMatchObject({ taxa: 3, records: 3 });
		const rec = await query<Record<string, any>>(
			`SELECT place_key, observed_on::text, count, locality, lat, lon, uncertainty_m, observers, behaviour, activity, validation,
			        notes, sex, photos, record_url, upstream_modified_at::text, load_id
			   FROM external_records WHERE source_id = $1 AND upstream_record_id = $2`,
			[SRC, `rec1-${RUN}`]
		);
		expect(rec.rows[0]).toMatchObject({
			place_key: `${REGION}:Nesna`,
			observed_on: '2026-06-03',
			count: 2,
			observers: [],
			behaviour: ['feeding'],
			activity: 'Forage',
			validation: 'Approved Documented',
			sex: 'male',
			photos: [{ url: 'https://www.artsobservasjoner.no/MediaLibrary/2026/6/x.jpg', by: null }],
			upstream_modified_at: '2026-06-04 07:01:02.123456',
			load_id: lease.id
		});
		const bare = await query<Record<string, any>>(`SELECT count, locality, lat, photos, behaviour FROM external_records WHERE source_id = $1 AND upstream_record_id = $2`, [SRC, `rec2-${RUN}`]);
		expect(bare.rows[0]).toEqual({ count: null, locality: null, lat: null, photos: null, behaviour: [] });

		const tx = await query<{ upstream_taxon_id: string; rank: string; local_name: string | null; red_list: string | null; species_code: string | null; match_reason: string }>(
			`SELECT upstream_taxon_id, rank, local_name, red_list, species_code, match_reason FROM external_taxa WHERE source_id = $1 ORDER BY upstream_taxon_id`,
			[SRC]
		);
		const byId = new Map(tx.rows.map((t) => [t.upstream_taxon_id, t]));
		expect(byId.get(ROBIN_ID)).toMatchObject({ rank: 'SPECIES', local_name: 'rødstrupe', red_list: 'LC', species_code: robin, match_reason: 'scientific' });
		expect(byId.get(FAKE_ID)).toMatchObject({ species_code: null, match_reason: 'no_match' });
		expect(byId.get(GULLS_ID)).toMatchObject({ rank: 'OTHER', local_name: 'måkefamilien', species_code: null, match_reason: 'not_species' });
		expect(await stagingRows(lease.id)).toBe(0);
	});

	it("stores a place's upstream id and location", async () => {
		await queueExternalLoad({ sourceId: SRC, regionCode: REGION, requestedBy: null });
		const lease = await claim();
		const d = dataset();
		d.places = d.places.map((p) => (p.level === 'subregion' ? { ...p, upstream_place_id: '1828' } : p));
		const f = await finish(lease, manifest(await sendAll(lease, d)));
		expect(f.status, JSON.stringify(f.body)).toBe(200);
		const p = await query<{ upstream_place_id: string | null; lat: number }>(`SELECT upstream_place_id, lat FROM external_places WHERE source_id = $1 AND place_key = $2`, [SRC, `${REGION}:Nesna`]);
		expect(p.rows[0]).toEqual({ upstream_place_id: '1828', lat: 66.2 });
	});

	it("replaces a county's records whole on reload, leaves another county alone, and keeps taxa source-wide", async () => {
		await publishRecords();
		await publishRecords({ region: OTHER_REGION, recordRows: [record('rec9', { place_key: OTHER_REGION })] });
		await publishRecords({ taxaRows: [{ ...taxa()[0], local_name: null }], recordRows: [record('rec1')] });
		const n = await query<{ region_code: string; n: string }>(
			`SELECT region_code, COUNT(*) AS n FROM external_records WHERE source_id = $1 GROUP BY region_code ORDER BY region_code`,
			[SRC]
		);
		expect(n.rows).toEqual([
			{ region_code: REGION, n: '1' },
			{ region_code: OTHER_REGION, n: '1' }
		]);
		const tx = await query<{ upstream_taxon_id: string; local_name: string | null }>(`SELECT upstream_taxon_id, local_name FROM external_taxa WHERE source_id = $1`, [SRC]);
		// The gull family stays although this reload didn't send it; a name left out keeps the known one.
		expect(tx.rows.map((t) => t.upstream_taxon_id).sort()).toEqual([FAKE_ID, GULLS_ID, ROBIN_ID].sort());
		expect(tx.rows.find((t) => t.upstream_taxon_id === ROBIN_ID)!.local_name).toBe('rødstrupe');
	});

	it('refuses records whose taxon or place was never sent, and keeps the previous data', async () => {
		await publishRecords();
		const before = await publishedCounts(SRC, REGION);
		const lost = await publishRecords({ taxaRows: [taxa()[0]], expectStatus: 422 });
		expect(lost.f.body!.error).toBe('unknown_taxon');
		const noPlace = await publishRecords({ recordRows: [record('rec5', { place_key: `${REGION}:Vega` })], expectStatus: 422 });
		expect(noPlace.f.body!.error).toBe('unknown_place');
		expect(await publishedCounts(SRC, REGION)).toEqual(before);
	});

	it('refuses observer names in records unless the source stores them, at the chunk and at finish', async () => {
		await queueExternalLoad({ sourceId: SRC, regionCode: REGION, requestedBy: null });
		const lease = await claim();
		const named = [record('rec7', { observers: ['Observer A', 'Observer B'] })];
		const r = await chunk(lease, 'records-1', 'records', named);
		expect(r.status).toBe(422);
		expect(r.body!.error).toBe('observer');

		await query(`UPDATE external_sources SET store_observers = true WHERE id = $1`, [SRC]);
		expect((await chunk(lease, 'records-1', 'records', named)).status).toBe(200);
		expect((await chunk(lease, 'taxa-1', 'taxa', taxa())).status).toBe(200);
		const sent = await sendAll(lease);
		sent.push({ chunk_id: 'records-1', kind: 'records', rows: 1, sha256: rowsDigest(named) });
		sent.push({ chunk_id: 'taxa-1', kind: 'taxa', rows: 3, sha256: rowsDigest(taxa()) });
		await query(`UPDATE external_sources SET store_observers = false WHERE id = $1`, [SRC]);
		const f = await finish(lease, manifest(sent));
		expect(f.status).toBe(422);
		expect(f.body!.error).toBe('observer');
	});

	it('refuses a photo credit unless the source stores names, at the chunk and at finish (CODEX1 td-769300 F2)', async () => {
		await queueExternalLoad({ sourceId: SRC, regionCode: REGION, requestedBy: null });
		const lease = await claim();
		const credited = [record('rec8', { photos: [{ url: 'https://www.artsobservasjoner.no/MediaLibrary/2026/6/y.jpg', by: 'Photographer A' }] })];
		const r = await chunk(lease, 'records-1', 'records', credited);
		expect(r.status).toBe(422);
		expect(r.body!.error).toBe('observer');

		await query(`UPDATE external_sources SET store_observers = true WHERE id = $1`, [SRC]);
		expect((await chunk(lease, 'records-1', 'records', credited)).status).toBe(200);
		expect((await chunk(lease, 'taxa-1', 'taxa', taxa())).status).toBe(200);
		const sent = await sendAll(lease);
		sent.push({ chunk_id: 'records-1', kind: 'records', rows: 1, sha256: rowsDigest(credited) });
		sent.push({ chunk_id: 'taxa-1', kind: 'taxa', rows: 3, sha256: rowsDigest(taxa()) });
		await query(`UPDATE external_sources SET store_observers = false WHERE id = $1`, [SRC]);
		const f = await finish(lease, manifest(sent));
		expect(f.status).toBe(422);
		expect(f.body!.error).toBe('observer');
	});

	it('lists a taxon held only in records as unmatched, with its record count, and takes an override for it (CODEX1 td-769300 F3)', async () => {
		const ONLY_ID = `only-${RUN}`;
		const MAGPIE_ID = `magpie-${RUN}`;
		const only = { upstream_taxon_id: ONLY_ID, canonical_name: 'Recordus onlyus', raw_name: 'Recordus onlyus', rank: 'SPECIES', local_name: null, red_list: null, red_list_url: null };
		// Matched by name and held only in records, so never listed as unmatched.
		const magpie = { upstream_taxon_id: MAGPIE_ID, canonical_name: 'Pica pica', raw_name: 'Pica pica', rank: 'SPECIES', local_name: 'skjære', red_list: 'LC', red_list_url: null };
		const rows = [
			...records(),
			record('rec10', { upstream_taxon_id: ONLY_ID, canonical_name: 'Recordus onlyus', observed_on: '2026-10-02' }),
			record('rec11', { upstream_taxon_id: ONLY_ID, canonical_name: 'Recordus onlyus', observed_on: '2026-10-03' }),
			record('rec12', { upstream_taxon_id: MAGPIE_ID, canonical_name: 'Pica pica', observed_on: '2026-10-04' })
		];
		// One of the two records is also a recent report: it must be counted once.
		const data = dataset();
		data.recent = [
			...data.recent,
			{ ...data.recent[0], upstream_record_id: `rec11-${RUN}`, upstream_taxon_id: ONLY_ID, canonical_name: 'Recordus onlyus', observed_on: '2026-10-03' }
		];
		await publishRecords({ taxaRows: [...taxa(), only, magpie], recordRows: rows, data });
		const listed = await query<{ reason: string; reports: string }>(
			`SELECT reason, reports FROM external_unmatched WHERE source_id = $1 AND region_code = $2 AND upstream_taxon_id = $3`,
			[SRC, REGION, ONLY_ID]
		);
		expect(listed.rows).toEqual([{ reason: 'no_match', reports: '2' }]);
		// The fake species keeps its window count (1), not that plus its record and recent report.
		const fake = await query<{ reports: string }>(`SELECT reports FROM external_unmatched WHERE source_id = $1 AND upstream_taxon_id = $2`, [SRC, FAKE_ID]);
		expect(fake.rows[0].reports).toBe('1');
		// The gull family is not a species and is never listed.
		expect((await query(`SELECT 1 FROM external_unmatched WHERE source_id = $1 AND upstream_taxon_id = $2`, [SRC, GULLS_ID])).rowCount).toBe(0);

		const r = await setTaxonOverride({ sourceId: SRC, upstreamTaxonId: ONLY_ID, species: otherCode, userId });
		expect(r.canonicalName).toBe('Recordus onlyus');
		expect((await query(`SELECT 1 FROM external_unmatched WHERE source_id = $1 AND upstream_taxon_id = $2`, [SRC, ONLY_ID])).rowCount).toBe(0);
		const t = await query<{ species_code: string }>(`SELECT species_code FROM external_taxa WHERE source_id = $1 AND upstream_taxon_id = $2`, [SRC, ONLY_ID]);
		expect(t.rows[0].species_code).toBe(otherCode);
		await expect(setTaxonOverride({ sourceId: SRC, upstreamTaxonId: GULLS_ID, species: otherCode, userId })).rejects.toThrow(/not in any loaded data/);
		const m = await setTaxonOverride({ sourceId: SRC, upstreamTaxonId: MAGPIE_ID, species: robin, userId });
		expect(m.canonicalName).toBe('Pica pica');
		const mt = await query<{ species_code: string; match_reason: string }>(`SELECT species_code, match_reason FROM external_taxa WHERE source_id = $1 AND upstream_taxon_id = $2`, [SRC, MAGPIE_ID]);
		expect(mt.rows[0]).toEqual({ species_code: robin, match_reason: 'override' });
	});

	it("an override updates the taxon's species code, so records join to the new species", async () => {
		await publishRecords();
		await setTaxonOverride({ sourceId: SRC, upstreamTaxonId: FAKE_ID, species: otherCode, userId });
		const joined = await query<{ species_code: string }>(
			`SELECT t.species_code FROM external_records r
			   JOIN external_taxa t USING (source_id, upstream_taxon_id, canonical_name)
			  WHERE r.source_id = $1 AND r.upstream_record_id = $2`,
			[SRC, `rec2-${RUN}`]
		);
		expect(joined.rows[0].species_code).toBe(otherCode);
		const reason = await query<{ match_reason: string }>(`SELECT match_reason FROM external_taxa WHERE source_id = $1 AND upstream_taxon_id = $2`, [SRC, FAKE_ID]);
		expect(reason.rows[0].match_reason).toBe('override');
	});

	it('Admin → Sources: Norwegian names, a suggested species, the matched list, and changing an automatic match (td-b856c7)', async () => {
		const CROW_ID = `crow-${RUN}`;
		const crow = { upstream_taxon_id: CROW_ID, canonical_name: 'Corvus corone cornix', raw_name: 'Corvus corone subsp. cornix', rank: 'SUBSPECIES', local_name: 'gråkråke', red_list: 'LC', red_list_url: null };
		const hooded = (
			await query<{ species_code: string; com_name: string }>(
				`SELECT species_code, com_name FROM taxonomy_cache WHERE category = 'species' AND sci_name = 'Corvus cornix'`
			)
		).rows[0];
		expect(hooded, 'birds_test taxonomy has Corvus cornix').toBeDefined();
		const magpieName = (await query<{ com_name: string }>(`SELECT com_name FROM taxonomy_cache WHERE species_code = $1`, [otherCode])).rows[0].com_name;
		await publishRecords({
			taxaRows: [...taxa(), crow],
			recordRows: [...records(), record('rec20', { upstream_taxon_id: CROW_ID, canonical_name: 'Corvus corone cornix', photos: null })]
		});
		const mine = async () => (await adminSources()).find((x) => x.id === SRC)!;

		// The unmatched subspecies leads with its Norwegian name and offers the eBird species it is raised to.
		let src = await mine();
		const unmatchedCrow = src.unmatched.find((u) => u.upstreamTaxonId === CROW_ID);
		expect(unmatchedCrow).toMatchObject({ localName: 'gråkråke', canonicalName: 'Corvus corone cornix', reports: 1 });
		expect(unmatchedCrow!.suggestion).toEqual({ code: hooded.species_code, comName: hooded.com_name, sciName: 'Corvus cornix' });
		// A binomial with no eBird species gets no suggestion; nothing is applied without the owner.
		expect(src.unmatched.find((u) => u.upstreamTaxonId === FAKE_ID)!.suggestion).toBeNull();

		// Matched taxa are listed with their Norwegian name, eBird name, how they matched and their reports.
		const robinRow = src.matched.find((m) => m.upstreamTaxonId === ROBIN_ID);
		expect(robinRow).toMatchObject({ localName: 'rødstrupe', speciesCode: robin, method: 'scientific', reports: 1 });
		expect(src.matched.some((m) => m.upstreamTaxonId === GULLS_ID || m.upstreamTaxonId === FAKE_ID)).toBe(false);

		// Changing an automatic match moves every derived row to the new species.
		const robinRows = async (code: string) =>
			Number((await query<{ n: string }>(`SELECT COALESCE(SUM(reports), 0) AS n FROM external_place_month_species WHERE source_id = $1 AND species_code = $2`, [SRC, code])).rows[0].n);
		const before = await robinRows(robin);
		expect(before).toBeGreaterThan(0);
		const otherBefore = await robinRows(otherCode);
		const r = await setTaxonOverride({ sourceId: SRC, upstreamTaxonId: ROBIN_ID, species: otherCode, userId });
		expect(r).toMatchObject({ speciesCode: otherCode, canonicalName: 'Erithacus rubecula', localName: 'rødstrupe', comName: magpieName });
		expect(await robinRows(robin)).toBe(0);
		expect(await robinRows(otherCode)).toBe(otherBefore + before);
		// …and the latest reports with it (CODEX1 td-b856c7 review).
		const recentCodes = async () =>
			(await query<{ species_code: string }>(`SELECT DISTINCT species_code FROM external_recent_reports WHERE source_id = $1 AND upstream_taxon_id = $2`, [SRC, ROBIN_ID])).rows.map((x) => x.species_code);
		expect(await recentCodes()).toEqual([otherCode]);
		src = await mine();
		expect(src.matched.find((m) => m.upstreamTaxonId === ROBIN_ID)).toMatchObject({ speciesCode: otherCode, method: 'override' });
		expect(src.overrides.find((o) => o.upstreamTaxonId === ROBIN_ID)).toMatchObject({ localName: 'rødstrupe', comName: magpieName });

		// Accepting the suggestion (the form sends its code) matches the subspecies.
		await setTaxonOverride({ sourceId: SRC, upstreamTaxonId: CROW_ID, species: hooded.species_code, userId });
		src = await mine();
		expect(src.unmatched.some((u) => u.upstreamTaxonId === CROW_ID)).toBe(false);
		expect(src.matched.find((m) => m.upstreamTaxonId === CROW_ID)).toMatchObject({ localName: 'gråkråke', speciesCode: hooded.species_code, method: 'override' });

		// Removing the change puts the robin back on its scientific match.
		expect(await removeTaxonOverride(SRC, ROBIN_ID)).toBe(true);
		expect(await robinRows(robin)).toBe(before);
		expect(await recentCodes()).toEqual([robin]);
	});

	it('refuses a species taxon sent under two names, but not a genus or hybrid', async () => {
		const renamed = [...taxa(), { ...taxa()[0], canonical_name: 'Erithacus rubeculus', raw_name: 'Erithacus rubeculus' }];
		const conflict = await publishRecords({ taxaRows: renamed, expectStatus: 422 });
		expect(conflict.f.body!.error).toBe('taxon_name_conflict');
		const otherTwice = [...taxa(), { ...taxa()[2], canonical_name: 'Larus' }];
		await publishRecords({ taxaRows: otherTwice });
	});
});

describe('job chip', () => {
	it("lists the requester's own active and recently finished loads in the chip's states", async () => {
		const { loadId } = await queueExternalLoad({ sourceId: SRC, regionCode: REGION, requestedBy: userId });
		let jobs = await externalLoadsForUser(userId);
		expect(jobs[0]).toMatchObject({ id: loadId, status: 'queued', presentation: { state: 'queued' } });
		expect(jobs[0].displayName).toMatch(/reports for /);
		const lease = await claim();
		await call(heartbeatRoute, lease.id, { ...fence(lease), progress: { phase: 'fetching', done: 3, total: 10 } });
		jobs = await externalLoadsForUser(userId);
		expect(jobs[0]).toMatchObject({ presentation: { state: 'running' }, progress: { unitsDone: 3, unitsTotal: 10 } });
		const sent = await sendAll(lease);
		await finish(lease, manifest(sent));
		jobs = await externalLoadsForUser(userId);
		expect(jobs[0].presentation.state).toBe('complete');
		expect(await externalLoadsForUser(-1)).toEqual([]);
	});
});

describe('CODEX1 review regressions', () => {
	it('gives one lease to two simultaneous retries of the same claim key, even with two regions queued', async () => {
		await queueExternalLoad({ sourceId: SRC, regionCode: REGION, requestedBy: null });
		await queueExternalLoad({ sourceId: SRC, regionCode: OTHER_REGION, requestedBy: null });
		const body = { contract_version: 1, idempotency_key: 'claim-same-parallel' };
		const [a, b] = await Promise.all([call(claimRoute, null, body), call(claimRoute, null, body)]);
		expect(a.status).toBe(200);
		expect(b.status).toBe(200);
		expect(b.body!.load).toEqual(a.body!.load);
		const leased = await query(`SELECT 1 FROM external_loads WHERE source_id = $1 AND status = 'leased'`, [SRC]);
		expect(leased.rowCount).toBe(1);
	});

	it('refuses a finish that was authenticated before its token was revoked', async () => {
		const c = await addConnector(SRC, 'test-revoke-race');
		await queueExternalLoad({ sourceId: SRC, regionCode: REGION, requestedBy: null });
		const lease = await claim('claim-revoke-race', c.token);
		const sent = await sendAll(lease);
		let release: () => void = () => {};
		const held = new Promise<void>((r) => (release = r));
		let locked: () => void = () => {};
		const isLocked = new Promise<void>((r) => (locked = r));
		const blocker = withTransaction(async (tx) => {
			await tx.query(`SELECT 1 FROM external_loads WHERE id = $1 FOR UPDATE`, [lease.id]);
			locked();
			await held;
		});
		await isLocked;
		// Authenticated now; it then waits for the load lock.
		const pending = finish(lease, manifest(sent), c.token);
		await new Promise((r) => setTimeout(r, 150));
		expect(await revokeConnector(c.id)).toBe(true);
		release();
		await blocker;
		const r = await pending;
		expect(r.status).toBe(401);
		expect((await publishedCounts(SRC, REGION)).external_places).toBe(0);
	});

	it('serializes a rematch with a finish of the same source', async () => {
		await queueExternalLoad({ sourceId: SRC, regionCode: REGION, requestedBy: null });
		const lease = await claim();
		const sent = await sendAll(lease);
		let release: () => void = () => {};
		const held = new Promise<void>((r) => (release = r));
		let locked: () => void = () => {};
		const isLocked = new Promise<void>((r) => (locked = r));
		const rematch = withTransaction(async (tx) => {
			await lockSourceDerived(tx, SRC);
			locked();
			await held;
		});
		await isLocked;
		const pending = finish(lease, manifest(sent));
		await new Promise((r) => setTimeout(r, 200));
		expect((await loadRow(lease.id)).status).toBe('staging');
		release();
		await rematch;
		expect((await pending).status).toBe(200);
		await rematchSource(SRC);
		expect((await publishedCounts(SRC, REGION)).external_place_month_species).toBe(3);
	});

	it('matches one upstream id per (region, name), not by whichever name a query returns last', async () => {
		await publishOnce();
		// The neighbouring region was loaded at another upstream snapshot: same id, other name.
		await queueExternalLoad({ sourceId: SRC, regionCode: OTHER_REGION, requestedBy: null });
		const lease = await claim();
		const d = dataset(OTHER_REGION);
		d.taxa = d.taxa.map((t) => (t.upstream_taxon_id === ROBIN_ID ? { ...t, canonical_name: 'Erithacus rubeculus' } : t));
		d.recent = d.recent.map((r) => (r.upstream_taxon_id === ROBIN_ID ? { ...r, canonical_name: 'Erithacus rubeculus', upstream_record_id: `${r.upstream_record_id}-19` } : { ...r, upstream_record_id: `${r.upstream_record_id}-19` }));
		const sent = await sendAll(lease, d);
		expect((await finish(lease, manifest(sent, {}, OTHER_REGION))).status).toBe(200);
		for (let i = 0; i < 3; i++) {
			await rematchSource(SRC);
			const robins = await query<{ region_code: string }>(
				`SELECT DISTINCT region_code FROM external_place_month_species WHERE source_id = $1 AND species_code = $2`,
				[SRC, robin]
			);
			expect(robins.rows.map((r) => r.region_code)).toEqual([REGION]);
			const un = await query<{ region_code: string }>(
				`SELECT region_code FROM external_unmatched WHERE source_id = $1 AND upstream_taxon_id = $2`,
				[SRC, ROBIN_ID]
			);
			expect(un.rows.map((r) => r.region_code)).toEqual([OTHER_REGION]);
		}
	});

	it('publishes unmatched totals beyond int4 instead of failing the finish', async () => {
		await queueExternalLoad({ sourceId: SRC, regionCode: REGION, requestedBy: null });
		const lease = await claim();
		const places = [{ place_key: REGION, name: 'Nordland', level: 'region', parent_key: null, lat: null, lon: null, upstream_place_id: null }];
		const big = 2147483647;
		const totals = MONTHS.map((month) => ({ place_key: REGION, month, reports: month === 1 ? big : month === 2 ? 1 : 0, unkeyed: 0 }));
		const taxa = [1, 2].map((month) => ({ place_key: REGION, month, upstream_taxon_id: FAKE_ID, canonical_name: 'Nonexistus fakeus', raw_name: 'Nonexistus fakeus', rank: 'SPECIES', reports: month === 1 ? big : 1 }));
		const sent: Sent[] = [];
		for (const [kind, rows] of [['places', places], ['totals', totals], ['taxon_month', taxa]] as const) {
			expect((await chunk(lease, `${kind}-1`, kind, rows as unknown[])).status).toBe(200);
			sent.push({ chunk_id: `${kind}-1`, kind, rows: rows.length, sha256: rowsDigest(rows as unknown[]) });
		}
		const r = await finish(lease, manifest(sent, { places: [REGION] }));
		expect(r.status, JSON.stringify(r.body)).toBe(200);
		expect(r.body!.result.unmatched_reports).toBe(2147483648);
	});

	it('answers 422, not 500, for a year PostgreSQL cannot store', async () => {
		await queueExternalLoad({ sourceId: SRC, regionCode: REGION, requestedBy: null });
		const lease = await claim();
		const r = await chunk(lease, 'recent-y0', 'recent', [{ ...dataset().recent[0], observed_on: '0000-01-01' }]);
		expect(r.status).toBe(422);
	});

	it('refuses a window that is not the latest complete months for the load', async () => {
		await queueExternalLoad({ sourceId: SRC, regionCode: REGION, requestedBy: null });
		const lease = await claim();
		const sent = await sendAll(lease);
		const old = await finish(lease, manifest(sent, { window_start: '2000-01-01', window_end: '2001-12-31' }));
		expect(old.status).toBe(422);
		expect(old.body!.message).toMatch(/must end/);
	});

	it('lists every active load even when ten newer ones have just finished', async () => {
		const regions = ['NO-01', 'NO-02', 'NO-03', 'NO-04', 'NO-05', 'NO-06', 'NO-07', 'NO-08', 'NO-09', 'NO-10', 'NO-11', 'NO-12'];
		const ids: string[] = [];
		for (const regionCode of regions) ids.push((await queueExternalLoad({ sourceId: SRC, regionCode, requestedBy: userId })).loadId);
		await query(
			`UPDATE external_loads SET status = 'failed', error = 'test', finished_at = now() WHERE id = ANY($1::uuid[])`,
			[ids.slice(2)]
		);
		const jobs = await externalLoadsForUser(userId);
		const active = jobs.filter((j) => ['queued', 'leased', 'staging'].includes(j.status)).map((j) => j.id).sort();
		expect(active).toEqual(ids.slice(0, 2).sort());
		expect(jobs.length).toBe(12);
	});

	it('creates a fresh load when the active one finishes between the conflict and the lookup', async () => {
		const first = await queueExternalLoad({ sourceId: SRC, regionCode: REGION, requestedBy: null });
		let ran = false;
		const second = await queueExternalLoad({
			sourceId: SRC,
			regionCode: REGION,
			requestedBy: null,
			afterConflictForTest: async () => {
				if (ran) return;
				ran = true;
				await query(`UPDATE external_loads SET status = 'failed', error = 'test', finished_at = now() WHERE id = $1`, [first.loadId]);
			}
		});
		expect(ran).toBe(true);
		expect(second.created).toBe(true);
		expect(second.loadId).not.toBe(first.loadId);
	});

	it('keeps every connector note, with exact per-code totals', async () => {
		await queueExternalLoad({ sourceId: SRC, regionCode: REGION, requestedBy: null });
		const lease = await claim();
		const d = dataset();
		d.diagnostics = Array.from({ length: 201 }, (_, i) => ({ code: i % 2 ? 'no_uncertainty' : 'unplaced_records', detail: `note ${i}`, count: 1 }));
		const sent = await sendAll(lease, d);
		const r = await finish(lease, manifest(sent));
		expect(r.status).toBe(200);
		expect(r.body!.result.diagnostics).toEqual([
			{ code: 'no_uncertainty', notes: 100, count: 100 },
			{ code: 'unplaced_records', notes: 101, count: 101 }
		]);
		const kept = await query(`SELECT 1 FROM external_load_diagnostics WHERE load_id = $1`, [lease.id]);
		expect(kept.rowCount).toBe(201);
	});
});

describe('window frozen at queue time (CODEX1 re-review)', () => {
	it('tells the connector the window ends a load accepts, and holds them across a month boundary', async () => {
		const { loadId } = await queueExternalLoad({ sourceId: SRC, regionCode: REGION, requestedBy: null });
		// Queued in the last second of October, claimed later.
		await query(`UPDATE external_loads SET created_at = '2026-10-31T23:59:59Z' WHERE id = $1`, [loadId]);
		const lease = await claim();
		expect((lease as Lease & { window_ends: string[] }).window_ends).toEqual(['2026-09-30', '2026-08-31']);
		const again = await call(claimRoute, null, { contract_version: 1, idempotency_key: 'claim-window-replay' });
		expect(again.status).toBe(204);
		const sent = await sendAll(lease);
		const october = await finish(lease, manifest(sent, { window_start: windowStartFor('2026-10-31', 24), window_end: '2026-10-31' }));
		expect(october.status).toBe(422);
		const ok = await finish(lease, manifest(sent, { window_start: windowStartFor('2026-09-30', 24), window_end: '2026-09-30' }));
		expect(ok.status, JSON.stringify(ok.body)).toBe(200);
		expect(ok.body!.result.window).toEqual({ start: '2024-10-01', end: '2026-09-30' });
	});

	it('returns the same window ends when a claim is replayed with its key', async () => {
		await queueExternalLoad({ sourceId: SRC, regionCode: REGION, requestedBy: null });
		const first = await claim('claim-window-same');
		const replay = await claim('claim-window-same');
		expect((replay as Lease & { window_ends: string[] }).window_ends).toEqual((first as Lease & { window_ends: string[] }).window_ends);
		expect((first as Lease & { window_ends: string[] }).window_ends[0]).toBe(WINDOW_END);
	});
});

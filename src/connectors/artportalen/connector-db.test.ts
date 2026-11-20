/**
 * The Sweden connector end to end (td-99eebf): the real connector against a
 * fake SOS and the app's real ingest route handlers, publishing into
 * birds_test under a throwaway source `xs-<run>` that only this file touches.
 * Nothing eBird-side may change.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadTestEnv, requireTestDb } from '$server/testing/test-env';
import { query, withTransaction } from '$lib/db';
import { newConnectorToken, tokenHash } from '$server/external-sources/auth';
import { resetIngestRateForTest } from '$server/external-sources/http';
import { CLOSED_FOR_LOADING, IngestError, expireLeases, queueExternalLoad } from '$server/external-sources/lifecycle';
import { externalSourcesForRegion } from '$server/external-sources/reports';
import { CLOSED_BEFORE_START, setRegionOpen } from '$server/external-sources/admin';
import * as claimRoute from '../../routes/api/ingest/loads/claim/+server';
import * as heartbeatRoute from '../../routes/api/ingest/loads/[id]/heartbeat/+server';
import * as chunksRoute from '../../routes/api/ingest/loads/[id]/chunks/+server';
import * as finishRoute from '../../routes/api/ingest/loads/[id]/finish/+server';
import * as failRoute from '../../routes/api/ingest/loads/[id]/fail/+server';
import { IngestClient, ingestBase } from '../shared/ingest';
import { SosClient } from './sos';
import { runLoad } from './run';
import { fakeSos } from './fixtures/fake-sos';
import { TODAY, jonkopingRecords } from './fixtures/scenario';

loadTestEnv();
await requireTestDb(query);

const RUN = `${process.pid.toString(36)}${Date.now().toString(36).slice(-5)}`;
const SRC = `xs-${RUN}`;
const REGION = 'SE-F';
let userId = 0;
let token = '';
const EBIRD_TABLES = ['species_frequency', 'species_month_freq', 'loc_month_samples', 'frequency_fetch'];
let ebirdBefore: Record<string, number> = {};

async function ebirdCounts(): Promise<Record<string, number>> {
	const out: Record<string, number> = {};
	for (const t of EBIRD_TABLES) out[t] = Number((await query<{ n: string }>(`SELECT COUNT(*) AS n FROM ${t}`)).rows[0].n);
	return out;
}

const PUBLISHED = [
	'external_records',
	'external_place_month_species',
	'external_unmatched',
	'external_recent_reports',
	'external_top_observers',
	'external_top_localities',
	'external_taxon_month',
	'external_place_month_totals',
	'external_places'
];

async function cleanLoads(): Promise<void> {
	for (const t of PUBLISHED) await query(`DELETE FROM ${t} WHERE source_id = $1`, [SRC]);
	await query(`DELETE FROM external_taxa WHERE source_id = $1`, [SRC]);
	await query(`DELETE FROM external_loads WHERE source_id = $1`, [SRC]);
}

type Route = { POST: (event: never) => Response | Promise<Response> };
const ROUTES: Record<string, Route> = { heartbeat: heartbeatRoute, chunks: chunksRoute, finish: finishRoute, fail: failRoute };

async function appFetch(url: string, init?: RequestInit): Promise<Response> {
	resetIngestRateForTest();
	const u = new URL(url);
	const m = /^\/api\/ingest\/loads\/(?:claim|([0-9a-f-]+)\/(heartbeat|chunks|finish|fail))$/.exec(u.pathname);
	if (!m) return new Response(null, { status: 404 });
	const route = m[2] ? ROUTES[m[2]] : claimRoute;
	const request = new Request(url, { method: 'POST', headers: init?.headers, body: init?.body });
	return route.POST({ request, params: { id: m[1] } } as never);
}

function connector() {
	const fake = fakeSos({ records: jonkopingRecords() });
	return {
		fake,
		sos: new SosClient('k'.repeat(32), { fetch: fake.fetch, sleep: async () => {} }),
		ingest: new IngestClient(ingestBase('http://app.test/api/ingest/')!, token, { fetch: appFetch, sleep: async () => {} })
	};
}

beforeAll(async () => {
	ebirdBefore = await ebirdCounts();
	userId = (
		await query<{ id: number }>(
			`INSERT INTO users (username, display_name, password_hash, role) VALUES ($1, $2, 'x', 'admin') RETURNING id`,
			[`xs-${RUN}`, `XS ${RUN}`]
		)
	).rows[0].id;
	await query(
		`INSERT INTO external_sources (id, name, publisher, license, license_url, citation, attribution, record_semantics,
		                               homepage, covers_country, geo_scheme, window_months, store_observers, locale)
		 VALUES ($1, 'Sweden connector test', 'Test publisher', 'CC0 1.0', 'https://creativecommons.org/publicdomain/zero/1.0/',
		         'Test citation', 'Test attribution', 'reports', 'https://example.org/', 'SE', 'SOS County', 12, true, 'sv')`,
		[SRC]
	);
	await query(
		`INSERT INTO external_region_map (source_id, upstream_key, region_code, queueable)
		 VALUES ($1, '6', 'SE-F', true), ($1, '12', 'SE-M', false)`,
		[SRC]
	);
});

beforeEach(async () => {
	vi.spyOn(console, 'info').mockImplementation(() => {});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	token = newConnectorToken();
	await query(`INSERT INTO external_connectors (source_id, label, token_sha256) VALUES ($1, 'test', $2)`, [SRC, tokenHash(token)]);
});

afterEach(async () => {
	vi.restoreAllMocks();
	await cleanLoads();
	await query(`DELETE FROM external_connectors WHERE source_id = $1`, [SRC]);
	expect(await ebirdCounts()).toEqual(ebirdBefore);
});

afterAll(async () => {
	await cleanLoads();
	await query(`DELETE FROM external_sources WHERE id = $1`, [SRC]);
	await query(`DELETE FROM users WHERE id = $1`, [userId]);
});

async function queue(): Promise<string> {
	const { loadId } = await queueExternalLoad({ sourceId: SRC, regionCode: REGION, requestedBy: userId });
	await query(`UPDATE external_loads SET created_at = '2026-10-22T12:00:00Z' WHERE id = $1`, [loadId]);
	return loadId;
}

describe('Sweden connector → real ingest API → birds_test', () => {
	it('publishes a county: Swedish places, species matched, blurred reports without a point', async () => {
		const loadId = await queue();
		const c = connector();
		const load = await c.ingest.claim(`xs-claim-${RUN}`, new AbortController().signal);
		expect(load?.window_months).toBe(12);
		const logs: { event: string; fields?: Record<string, unknown> }[] = [];
		const outcome = await runLoad({ sos: c.sos, ingest: c.ingest, log: (event, fields) => void logs.push({ event, fields }), now: () => TODAY }, load!, new AbortController().signal);
		expect(logs.find((l) => l.event === 'load_failed')?.fields?.error).toBeUndefined();
		expect(outcome).toBe('done');
		expect(logs.find((l) => l.event === 'preflight')?.fields).toMatchObject({ rows: expect.any(Number), finish_bytes: expect.any(Number) });

		const row = (await query<{ status: string; window_start: string; window_end: string; source_snapshot: Record<string, unknown> }>(
			`SELECT status, window_start::text, window_end::text, source_snapshot FROM external_loads WHERE id = $1`,
			[loadId]
		)).rows[0];
		expect(row).toMatchObject({ status: 'done', window_start: '2025-10-01', window_end: '2026-09-30' });
		expect(row.source_snapshot).toMatchObject({ api: 'sos-v1', county: 6, recent_from: '2026-09-30', recent_to: '2026-10-08', recent_truncated: 0 });

		const places = await query<{ place_key: string; upstream_place_id: string | null }>(
			`SELECT place_key, upstream_place_id FROM external_places WHERE source_id = $1 ORDER BY place_key`,
			[SRC]
		);
		expect(places.rows).toEqual([
			{ place_key: 'SE-F', upstream_place_id: null },
			{ place_key: 'SE-F:Jönköping', upstream_place_id: '680' },
			{ place_key: 'SE-F:Nässjö', upstream_place_id: '682' }
		]);
		const total = await query<{ n: number }>(
			`SELECT SUM(reports)::int AS n FROM external_place_month_totals WHERE source_id = $1 AND place_key = 'SE-F'`,
			[SRC]
		);
		expect(total.rows[0].n).toBe(11);

		// The blurred report is stored, counted, and has no point or locality.
		const hidden = await query<{ lat: number | null; locality: string | null }>(
			`SELECT lat, locality FROM external_records WHERE source_id = $1 AND observed_on = '2026-05-11'`,
			[SRC]
		);
		expect(hidden.rows).toEqual([{ lat: null, locality: null }]);
		// Three swan nests are a note, not "3 counted".
		const swan = await query<{ count: number | null; notes: string | null }>(
			`SELECT count, notes FROM external_records WHERE source_id = $1 AND canonical_name = 'Cygnus olor'`,
			[SRC]
		);
		expect(swan.rows).toEqual([{ count: null, notes: 'Quantity: 3 nests' }]);
		// Swedish names and the red-list link are on the source's taxa.
		const goshawk = await query<{ local_name: string; red_list: string; red_list_url: string }>(
			`SELECT local_name, red_list, red_list_url FROM external_taxa WHERE source_id = $1 AND canonical_name = 'Astur gentilis'`,
			[SRC]
		);
		expect(goshawk.rows).toEqual([{ local_name: 'duvhök', red_list: 'NT', red_list_url: 'https://artfakta.se/taxa/100001' }]);

		const state = (await externalSourcesForRegion(REGION)).find((s) => s.source.id === SRC)!;
		expect(state).toMatchObject({ queueable: true, source: { locale: 'sv' } });
		expect(state.published?.windowEnd).toBe('2026-09-30');
	});

	it('refuses to queue a county that is not open for loading, and says so to every reader', async () => {
		const err = await queueExternalLoad({ sourceId: SRC, regionCode: 'SE-M', requestedBy: userId }).catch((e) => e);
		expect(err).toBeInstanceOf(IngestError);
		expect(err.code).toBe('region_not_open');
		const state = (await externalSourcesForRegion('SE-M')).find((s) => s.source.id === SRC)!;
		expect(state.queueable).toBe(false);
		expect((await query(`SELECT 1 FROM external_loads WHERE source_id = $1`, [SRC])).rowCount).toBe(0);
	});

	it('closing a region waits for a queue in flight, then ends what it queued (CODEX1 R8)', async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		let held!: () => void;
		const holding = new Promise<void>((r) => (held = r));
		// A queue transaction mid-way: it holds the map row as queueExternalLoad does and has inserted its load.
		const queueing = withTransaction(async (c) => {
			await c.query(`SELECT queueable FROM external_region_map WHERE source_id = $1 AND region_code = 'SE-F' FOR SHARE`, [SRC]);
			const ins = await c.query<{ id: string }>(
				`INSERT INTO external_loads (source_id, region_code, requested_by, max_attempts, window_months)
				 VALUES ($1, 'SE-F', $2, 3, 12) RETURNING id`,
				[SRC, userId]
			);
			held();
			await gate;
			return ins.rows[0].id;
		});
		await holding;
		let closed = false;
		const closing = setRegionOpen(SRC, 'SE-F', false).then((r) => ((closed = true), r));
		await new Promise((r) => setTimeout(r, 300));
		expect(closed).toBe(false);
		release();
		const loadId = await queueing;
		expect(await closing).toBe(true);
		try {
			const row = (await query<{ status: string; error: string }>(`SELECT status, error FROM external_loads WHERE id = $1`, [loadId])).rows[0];
			expect(row).toEqual({ status: 'failed', error: CLOSED_BEFORE_START });
			// And nothing new can be queued while closed.
			const err = await queueExternalLoad({ sourceId: SRC, regionCode: REGION, requestedBy: userId }).catch((e) => e);
			expect(err).toBeInstanceOf(IngestError);
		} finally {
			await setRegionOpen(SRC, 'SE-F', true);
		}
	});

	it('closing waits for a lease expiry in flight, then cancels the load it re-queued (CODEX1 round 3)', async () => {
		const loadId = await queue();
		const c = connector();
		const a = (await c.ingest.claim(`xs-race-${RUN}`, new AbortController().signal))!;
		expect(a.id).toBe(loadId);
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		let held!: () => void;
		const holding = new Promise<void>((r) => (held = r));
		// An expiry mid-way: it holds the load and has put it back in the queue, not yet committed.
		const expiring = withTransaction(async (t) => {
			await t.query(`SELECT id FROM external_loads WHERE id = $1 FOR UPDATE`, [loadId]);
			await t.query(
				`UPDATE external_loads SET status = 'queued', lease_token = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
				        claim_idempotency_key = NULL WHERE id = $1`,
				[loadId]
			);
			held();
			await gate;
		});
		await holding;
		let closed = false;
		const closing = setRegionOpen(SRC, 'SE-F', false).then((r) => ((closed = true), r));
		await new Promise((r) => setTimeout(r, 300));
		expect(closed).toBe(false);
		release();
		await expiring;
		try {
			expect(await closing).toBe(true);
			expect((await query(`SELECT status, error FROM external_loads WHERE id = $1`, [loadId])).rows[0]).toEqual({
				status: 'failed',
				error: CLOSED_FOR_LOADING
			});
		} finally {
			await setRegionOpen(SRC, 'SE-F', true);
		}
	});

	it('an expiry that locked first finishes first; the close then cancels what it re-queued (CODEX1 round 4)', async () => {
		const loadId = await queue();
		const c = connector();
		const a = (await c.ingest.claim(`xs-exp-first-${RUN}`, new AbortController().signal))!;
		expect(a.id).toBe(loadId);
		await query(`UPDATE external_loads SET lease_expires_at = now() - interval '1 minute' WHERE id = $1`, [loadId]);
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		let locked!: () => void;
		const holding = new Promise<void>((r) => (locked = r));
		const expiring = withTransaction((t) =>
			expireLeases(t, SRC, async () => {
				locked();
				await gate;
			})
		);
		await holding;
		let closed = false;
		const closing = setRegionOpen(SRC, 'SE-F', false).then((r) => ((closed = true), r));
		await new Promise((r) => setTimeout(r, 300));
		expect(closed).toBe(false);
		release();
		expect(await expiring).toBe(1);
		try {
			expect(await closing).toBe(true);
			expect((await query(`SELECT status, error FROM external_loads WHERE id = $1`, [loadId])).rows[0]).toEqual({
				status: 'failed',
				error: CLOSED_FOR_LOADING
			});
		} finally {
			await setRegionOpen(SRC, 'SE-F', true);
		}
	});

	it('a closed region never retries: a retryable fail or an expired lease ends the load (CODEX1 round 2)', async () => {
		const c = connector();
		try {
			// Retryable fail after closing: failed, not queued again.
			const first = await queue();
			const a = (await c.ingest.claim(`xs-retry-${RUN}`, new AbortController().signal))!;
			expect(a.id).toBe(first);
			await setRegionOpen(SRC, 'SE-F', false);
			await c.ingest.fail(a, 'SOS answered 503', true, new AbortController().signal);
			expect((await query(`SELECT status, error FROM external_loads WHERE id = $1`, [first])).rows[0]).toEqual({ status: 'failed', error: CLOSED_FOR_LOADING });

			// Expired lease after closing: failed, not queued again.
			await setRegionOpen(SRC, 'SE-F', true);
			const second = await queue();
			const b = (await c.ingest.claim(`xs-expire-${RUN}`, new AbortController().signal))!;
			expect(b.id).toBe(second);
			await setRegionOpen(SRC, 'SE-F', false);
			await query(`UPDATE external_loads SET lease_expires_at = now() - interval '1 minute' WHERE id = $1`, [second]);
			await withTransaction((t) => expireLeases(t, SRC));
			expect((await query(`SELECT status, error FROM external_loads WHERE id = $1`, [second])).rows[0]).toEqual({ status: 'failed', error: CLOSED_FOR_LOADING });

			// A load somehow left queued in a closed region is never claimed.
			await query(
				`INSERT INTO external_loads (source_id, region_code, requested_by, max_attempts, window_months) VALUES ($1, 'SE-F', $2, 3, 12)`,
				[SRC, userId]
			);
			expect(await c.ingest.claim(`xs-closed-${RUN}`, new AbortController().signal)).toBeNull();
		} finally {
			await setRegionOpen(SRC, 'SE-F', true);
		}
	});
});

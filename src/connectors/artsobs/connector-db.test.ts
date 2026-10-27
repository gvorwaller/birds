/**
 * Norway connector end to end (td-eec7db Phase 2 rev B): the real connector
 * code reads a fake Artskart (recorded records) and talks to the REAL ingest
 * route handlers, which write to birds_test.
 *
 * Fixture ownership (docs/agent-development-guide.md §3): one source
 * `xc-<run>` with its own region-map row, connector and loads, and one user.
 * Regions and taxonomy are only read. Cleanup deletes by those exact ids.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadTestEnv, requireTestDb } from '$server/testing/test-env';
import { query } from '$lib/db';
import { newConnectorToken, tokenHash } from '$server/external-sources/auth';
import { resetIngestRateForTest } from '$server/external-sources/http';
import { queueExternalLoad } from '$server/external-sources/lifecycle';
import * as claimRoute from '../../routes/api/ingest/loads/claim/+server';
import * as heartbeatRoute from '../../routes/api/ingest/loads/[id]/heartbeat/+server';
import * as chunksRoute from '../../routes/api/ingest/loads/[id]/chunks/+server';
import * as finishRoute from '../../routes/api/ingest/loads/[id]/finish/+server';
import * as failRoute from '../../routes/api/ingest/loads/[id]/fail/+server';
import { ArtskartClient } from './artskart';
import { IngestClient, ingestBase } from './ingest';
import { runLoad } from './run';
import { fakeArtskart } from './fixtures/fake-artskart';
import { TODAY, nordlandRecords } from './fixtures/scenario';

loadTestEnv();
await requireTestDb(query);

const RUN = `${process.pid.toString(36)}${Date.now().toString(36).slice(-5)}`;
const SRC = `xc-${RUN}`;
const REGION = 'NO-18';
let userId = 0;
let connectorId = 0;
let token = '';
const EBIRD_TABLES = ['species_frequency', 'species_month_freq', 'loc_month_samples', 'frequency_fetch'];
let ebirdBefore: Record<string, number> = {};

async function ebirdCounts(): Promise<Record<string, number>> {
	const out: Record<string, number> = {};
	for (const t of EBIRD_TABLES) out[t] = Number((await query<{ n: string }>(`SELECT COUNT(*) AS n FROM ${t}`)).rows[0].n);
	return out;
}

const PUBLISHED = [
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
	await query(`DELETE FROM external_loads WHERE source_id = $1`, [SRC]);
}

type Route = { POST: (event: never) => Response | Promise<Response> };
const ROUTES: Record<string, Route> = { heartbeat: heartbeatRoute, chunks: chunksRoute, finish: finishRoute, fail: failRoute };

/** The app, as the connector sees it over HTTP: the real route handlers. */
async function appFetch(url: string, init?: RequestInit): Promise<Response> {
	resetIngestRateForTest();
	const u = new URL(url);
	const m = /^\/api\/ingest\/loads\/(?:claim|([0-9a-f-]+)\/(heartbeat|chunks|finish|fail))$/.exec(u.pathname);
	if (!m) return new Response(null, { status: 404 });
	const route = m[2] ? ROUTES[m[2]] : claimRoute;
	const request = new Request(url, { method: 'POST', headers: init?.headers, body: init?.body });
	return route.POST({ request, params: { id: m[1] } } as never);
}

function connector(intercept?: Parameters<typeof fakeArtskart>[0]['intercept']) {
	const fake = fakeArtskart({ records: nordlandRecords(), intercept });
	return {
		fake,
		artskart: new ArtskartClient({ fetch: fake.fetch, sleep: async () => {} }),
		ingest: new IngestClient(ingestBase('http://app.test/api/ingest/')!, token, { fetch: appFetch, sleep: async () => {} })
	};
}

beforeAll(async () => {
	ebirdBefore = await ebirdCounts();
	userId = (
		await query<{ id: number }>(
			`INSERT INTO users (username, display_name, password_hash, role) VALUES ($1, $2, 'x', 'admin') RETURNING id`,
			[`xc-${RUN}`, `XC ${RUN}`]
		)
	).rows[0].id;
	await query(
		`INSERT INTO external_sources (id, name, publisher, license, license_url, citation, attribution, record_semantics,
		                               homepage, covers_country, geo_scheme, window_months, store_observers)
		 VALUES ($1, 'Connector test', 'Test publisher', 'CC BY 4.0', 'https://creativecommons.org/licenses/by/4.0/', 'Test citation',
		         'Test attribution', 'reports', 'https://example.org/', 'NO', 'Artskart counties (pre-2020)', 24, true)`,
		[SRC]
	);
	await query(`INSERT INTO external_region_map (source_id, upstream_key, region_code) VALUES ($1, '18', $2)`, [SRC, REGION]);
});

beforeEach(async () => {
	vi.spyOn(console, 'info').mockImplementation(() => {});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	token = newConnectorToken();
	connectorId = Number(
		(
			await query<{ id: string }>(`INSERT INTO external_connectors (source_id, label, token_sha256) VALUES ($1, 'test', $2) RETURNING id`, [
				SRC,
				tokenHash(token)
			])
		).rows[0].id
	);
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
	const left = await query<{ n: string }>(
		`SELECT (SELECT COUNT(*) FROM external_sources WHERE id = $1) + (SELECT COUNT(*) FROM users WHERE id = $2) AS n`,
		[SRC, userId]
	);
	expect(Number(left.rows[0].n)).toBe(0);
});

/**
 * Queue a load as if on 2026-10-22, the day before the scenario's "today":
 * its frozen window ends are then Sep 30 / Aug 31 2026, so the fixture never
 * ages out.
 */
async function queue(): Promise<string> {
	const { loadId } = await queueExternalLoad({ sourceId: SRC, regionCode: REGION, requestedBy: userId });
	await query(`UPDATE external_loads SET created_at = '2026-10-22T12:00:00Z' WHERE id = $1`, [loadId]);
	return loadId;
}

async function claimAndRun(c: ReturnType<typeof connector>, stop = new AbortController().signal) {
	const load = await c.ingest.claim(`xc-claim-${Math.random().toString(36).slice(2, 10)}`, stop);
	expect(load).not.toBeNull();
	const logs: { event: string; fields?: Record<string, unknown> }[] = [];
	const outcome = await runLoad({ artskart: c.artskart, ingest: c.ingest, log: (event, fields) => void logs.push({ event, fields }), now: () => TODAY }, load!, stop);
	return { load: load!, outcome, logs };
}

describe('Norway connector → real ingest API → birds_test', () => {
	it('publishes a county whose rows add up, with species matched and nothing guessed', async () => {
		const loadId = await queue();
		const { outcome, logs } = await claimAndRun(connector());
		const failed = logs.find((l) => l.event === 'load_failed');
		expect(failed?.fields?.error).toBeUndefined();
		expect(outcome).toBe('done');
		const stats = logs.find((l) => l.event === 'load_done')!.fields!.stats as { records: number; unkeyed: number };

		const load = (await query<{ status: string; window_end: string; result: Record<string, unknown> }>(
			`SELECT status, window_end::text, result FROM external_loads WHERE id = $1`,
			[loadId]
		)).rows[0];
		expect(load.status).toBe('done');
		expect(load.window_end).toBe('2026-09-30');
		expect(stats).toMatchObject({ records: 54, unkeyed: 1 });
		const totals = await query<{ place_key: string; reports: number; unkeyed: number }>(
			`SELECT place_key, SUM(reports)::int AS reports, SUM(unkeyed)::int AS unkeyed
			   FROM external_place_month_totals WHERE source_id = $1 AND region_code = $2 GROUP BY place_key`,
			[SRC, REGION]
		);
		const byPlace = Object.fromEntries(totals.rows.map((r) => [r.place_key, r]));
		expect(byPlace[REGION].reports).toBe(stats.records);
		expect(byPlace[REGION].unkeyed).toBe(stats.unkeyed);
		expect(Object.keys(byPlace).sort()).toEqual(
			['NO-18', 'NO-18:Bodø', 'NO-18:Lurøy', 'NO-18:Narvik', 'NO-18:Nesna', 'NO-18:Rana', 'NO-18:Røst', 'NO-18:Saltdal'].sort()
		);
		// Species rows: species match by name, the teal subspecies through eBird's
		// report_as (Green-winged Teal), the trailing-space goshawk after trimming;
		// the family never appears and nothing is unmatched.
		const species = await query<{ species_code: string; reports: number }>(
			`SELECT species_code, SUM(reports)::int AS reports FROM external_place_month_species
			  WHERE source_id = $1 AND region_code = $2 AND place_key = $2 GROUP BY species_code`,
			[SRC, REGION]
		);
		const codes = await query<{ sci_name: string; species_code: string }>(
			`SELECT sci_name, species_code FROM taxonomy_cache
			  WHERE category = 'species' AND sci_name IN ('Anser anser', 'Turdus pilaris', 'Regulus regulus', 'Anas crecca', 'Astur gentilis')`
		);
		expect(codes.rows).toHaveLength(5);
		for (const c of codes.rows) expect(species.rows.map((r) => r.species_code)).toContain(c.species_code);
		const teal = codes.rows.find((c) => c.sci_name === 'Anas crecca')!.species_code;
		expect(species.rows.find((r) => r.species_code === teal)!.reports).toBe(1);
		const unmatched = await query(`SELECT canonical_name FROM external_unmatched WHERE source_id = $1`, [SRC]);
		expect(unmatched.rows).toEqual([]);
		expect((await query(`SELECT 1 FROM external_taxon_month WHERE source_id = $1 AND canonical_name = 'Laridae'`, [SRC])).rowCount).toBe(0);
		// Observers: published per place, ranked by days out.
		const observers = await query<{ observer: string; days: number; rank: number }>(
			`SELECT observer, days, rank FROM external_top_observers WHERE source_id = $1 AND place_key = $2 ORDER BY rank`,
			[SRC, REGION]
		);
		expect(observers.rows.map((o) => o.observer)).toEqual(['Observer D', 'Observer A', 'Observer B', 'Observer C']);
		expect(observers.rows[0].days).toBe(40);
		// Recent reports name the party; connector notes are kept.
		const recent = await query<{ observed_on: string; observer: string | null }>(
			`SELECT observed_on::text, observer FROM external_recent_reports WHERE source_id = $1 ORDER BY observed_on DESC`,
			[SRC]
		);
		expect(recent.rows).toEqual([
			{ observed_on: '2026-10-08', observer: 'Observer A' },
			{ observed_on: '2026-10-01', observer: 'Observer A' }
		]);
		const notes = await query<{ code: string }>(`SELECT DISTINCT code FROM external_load_diagnostics WHERE load_id = $1`, [loadId]);
		expect(notes.rows.map((r) => r.code)).toEqual(expect.arrayContaining(['non_species_taxon', 'no_municipality', 'no_uncertainty']));
		// Localities: pins carry coordinates, text rows never do.
		const locs = await query<{ placement: string; lat: number | null }>(
			`SELECT placement, lat FROM external_top_localities WHERE source_id = $1`,
			[SRC]
		);
		expect(locs.rows.length).toBeGreaterThan(0);
		expect(locs.rows.every((l) => (l.placement === 'pin') === (l.lat !== null))).toBe(true);
	});

	it('a source that does not store observers refuses the load; nothing is published', async () => {
		await query(`UPDATE external_sources SET store_observers = false WHERE id = $1`, [SRC]);
		try {
			const loadId = await queue();
			const { outcome, logs } = await claimAndRun(connector());
			expect(outcome).toBe('failed');
			expect(String(logs.find((l) => l.event === 'load_failed')?.fields?.error)).toMatch(/observer/);
			expect((await query(`SELECT 1 FROM external_place_month_totals WHERE source_id = $1`, [SRC])).rowCount).toBe(0);
			const load = (await query<{ status: string }>(`SELECT status FROM external_loads WHERE id = $1`, [loadId])).rows[0];
			expect(load.status).toBe('failed');
		} finally {
			await query(`UPDATE external_sources SET store_observers = true WHERE id = $1`, [SRC]);
		}
	});

	it('a token revoked mid-load stops the connector; nothing is published', async () => {
		const loadId = await queue();
		let revoked = false;
		const c = connector((url) => {
			if (!revoked && url.pathname.endsWith('/observations/list')) {
				revoked = true;
				void query(`UPDATE external_connectors SET revoked_at = now() WHERE id = $1`, [connectorId]);
			}
			return null;
		});
		const { outcome } = await claimAndRun(c);
		expect(revoked).toBe(true);
		expect(outcome).toBe('lease_lost');
		const published = await query(`SELECT 1 FROM external_place_month_totals WHERE source_id = $1`, [SRC]);
		expect(published.rowCount).toBe(0);
		const load = (await query<{ status: string }>(`SELECT status FROM external_loads WHERE id = $1`, [loadId])).rows[0];
		expect(['leased', 'staging']).toContain(load.status);
	});

	it('a connector stopped mid-load hands the load back to the queue', async () => {
		const loadId = await queue();
		const stop = new AbortController();
		const c = connector((url) => {
			if (url.pathname.endsWith('/observations/list')) stop.abort(new Error('shutdown'));
			return null;
		});
		const { outcome } = await claimAndRun(c, stop.signal);
		expect(outcome).toBe('stopped');
		const load = (await query<{ status: string; error: string | null; attempt: number }>(
			`SELECT status, error, attempt FROM external_loads WHERE id = $1`,
			[loadId]
		)).rows[0];
		expect(load.status).toBe('queued');
		expect(load.error).toMatch(/back to the queue/);
	});
});

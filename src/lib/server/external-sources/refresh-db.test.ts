/**
 * td-9fe839: automatic refresh and owner alerts against birds_test — the
 * new-unmatched diff at finish, failure alerts from failLoad and
 * expireLeases, the refresh pass's choice of region, and push delivery.
 *
 * Fixture ownership (docs/agent-development-guide.md §3): a source
 * `xr-<run>` with its own connector, region map rows (NO-18, NO-19, read-only
 * borrowed regions) and loads; one admin user `xr-<run>` with fixture push
 * subscriptions. Every pass is scoped to that source and that admin, so the
 * owner's account, devices and the real sources are never touched. Cleanup
 * deletes by those exact ids.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadTestEnv, requireTestDb } from '$server/testing/test-env';
import { query, withTransaction } from '$lib/db';
import { PushError, type PushMessage, type PushSubscriptionRow } from '$server/push';
import { ALERT_MAX_ATTEMPTS } from '$lib/external-refresh-policy';
import { newConnectorToken, tokenHash } from './auth';
import { allowedWindowEnds, rowsDigest, windowStartFor } from './contract';
import { resetIngestRateForTest } from './http';
import { expireLeases, finishLoad, queueExternalLoad } from './lifecycle';
import { reloadLoadedRegions, removeTaxonOverride, setTaxonOverride } from './admin';
import { actions as adminActions } from '../../../routes/admin/+page.server';
import { AUTO_LOAD_GAVE_UP, AUTO_LOAD_SOURCE_OFF, runRefreshPass } from './refresh';
import * as claimRoute from '../../../routes/api/ingest/loads/claim/+server';
import * as chunksRoute from '../../../routes/api/ingest/loads/[id]/chunks/+server';
import * as finishRoute from '../../../routes/api/ingest/loads/[id]/finish/+server';
import * as failRoute from '../../../routes/api/ingest/loads/[id]/fail/+server';

loadTestEnv();
await requireTestDb(query);

const RUN = `${process.pid.toString(36)}${Date.now().toString(36).slice(-5)}`;
const SRC = `xr-${RUN}`;
const A = 'NO-18';
const B = 'NO-19';
const ROBIN_ID = `robin-${RUN}`;
const FAKE_ID = `fake-${RUN}`;
const FAKE2_ID = `fake2-${RUN}`;
const FAKE3_ID = `fake3-${RUN}`;
const NOMINATE_ID = `pica-${RUN}`;
const ENDPOINTS = [`https://fcm.googleapis.com/fcm/send/xr-${RUN}-1`, `https://fcm.googleapis.com/fcm/send/xr-${RUN}-2`];

let adminId = 0;
let token = '';
let tokenId = 0;
let robin = '';
let magpie = '';
let WINDOW_END = '';
let WINDOW_START = '';
const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const pass = (send?: (s: PushSubscriptionRow, m: PushMessage) => Promise<void>) =>
	runRefreshPass({ origin: 'https://birds.test', sourceIds: [SRC], admins: [adminId], send: send ?? (async () => {}) });

beforeAll(async () => {
	const dbNow = (await query<{ now: Date }>('SELECT now() AS now')).rows[0].now;
	WINDOW_END = allowedWindowEnds(dbNow)[0];
	WINDOW_START = windowStartFor(WINDOW_END, 24);
	const sp = await query<{ species_code: string; sci_name: string }>(
		`SELECT species_code, sci_name FROM taxonomy_cache WHERE category = 'species' AND sci_name IN ('Erithacus rubecula', 'Pica pica')`
	);
	const bySci = new Map(sp.rows.map((r) => [r.sci_name, r.species_code]));
	robin = bySci.get('Erithacus rubecula') ?? '';
	magpie = bySci.get('Pica pica') ?? '';
	if (!robin || !magpie) throw new Error('birds_test taxonomy lacks the fixture species (robin, magpie)');
	adminId = (
		await query<{ id: number }>(
			`INSERT INTO users (username, display_name, password_hash, role) VALUES ($1, $2, 'x', 'admin') RETURNING id`,
			[`xr-${RUN}`, `XR ${RUN}`]
		)
	).rows[0].id;
	await query(
		`INSERT INTO external_sources (id, name, publisher, license, license_url, citation, attribution, record_semantics,
		                               homepage, covers_country, geo_scheme, window_months, refresh_days)
		 VALUES ($1, $2, 'Test publisher', 'CC BY 4.0', 'https://creativecommons.org/licenses/by/4.0/', 'Test citation',
		         'Test attribution', 'reports', 'https://example.org/', 'NO', 'TEST', 24, 7)`,
		[SRC, `Test source ${SRC}`]
	);
	await query(`INSERT INTO external_region_map (source_id, upstream_key, region_code) VALUES ($1, 'T.18', $2), ($1, 'T.19', $3)`, [SRC, A, B]);
	const t = newConnectorToken();
	const r = await query<{ id: string }>(
		`INSERT INTO external_connectors (source_id, label, token_sha256) VALUES ($1, 'xr', $2) RETURNING id`,
		[SRC, tokenHash(t)]
	);
	token = t;
	tokenId = Number(r.rows[0].id);
});

beforeEach(() => resetIngestRateForTest());

async function clean(): Promise<void> {
	for (const table of [
		'external_records',
		'external_place_month_species',
		'external_unmatched',
		'external_recent_reports',
		'external_top_observers',
		'external_top_localities',
		'external_taxon_month',
		'external_place_month_totals',
		'external_places',
		'external_taxon_overrides',
		'external_taxa',
		'external_alerts',
		'external_loads'
	]) {
		await query(`DELETE FROM ${table} WHERE source_id = $1`, [SRC]);
	}
	await query(`DELETE FROM push_subscriptions WHERE user_id = $1`, [adminId]);
	await query(`UPDATE external_sources SET active = true, refresh_days = 7 WHERE id = $1`, [SRC]);
	await query(`UPDATE external_region_map SET queueable = true WHERE source_id = $1`, [SRC]);
}

afterEach(clean);

afterAll(async () => {
	await clean();
	await query(`DELETE FROM external_sources WHERE id = $1`, [SRC]);
	await query(`DELETE FROM users WHERE id = $1`, [adminId]);
	const left = await query<{ n: string }>(
		`SELECT (SELECT COUNT(*) FROM external_sources WHERE id = $1) + (SELECT COUNT(*) FROM external_connectors WHERE source_id = $1)
		      + (SELECT COUNT(*) FROM users WHERE id = $2) + (SELECT COUNT(*) FROM external_alerts WHERE source_id = $1) AS n`,
		[SRC, adminId]
	);
	expect(Number(left.rows[0].n)).toBe(0);
});

// ── Fake connector ─────────────────────────────────────────────────────────

type Route = { POST: (event: never) => Response | Promise<Response> };
interface Lease {
	id: string;
	lease_token: string;
	attempt: number;
}

async function call(route: Route, loadId: string | null, body: unknown): Promise<{ status: number; body: any }> {
	resetIngestRateForTest();
	const request = new Request('http://localhost/api/ingest/x', {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
		body: JSON.stringify(body)
	});
	const res = await route.POST({ request, params: { id: loadId ?? undefined } } as never);
	const text = await res.text();
	return { status: res.status, body: text ? JSON.parse(text) : null };
}

const fence = (l: Lease) => ({ contract_version: 1, lease_token: l.lease_token, attempt: l.attempt });

async function claim(): Promise<Lease> {
	const r = await call(claimRoute, null, { contract_version: 1, idempotency_key: `claim-${Math.random().toString(36).slice(2, 10)}` });
	expect(r.status, JSON.stringify(r.body)).toBe(200);
	return r.body.load as Lease;
}

/** One region's data with the given extra (unmatched or nominate) taxa. */
function dataset(region: string, extra: { id: string; name: string }[]) {
	const places = [{ place_key: region, name: 'County', level: 'region', parent_key: null, lat: null, lon: null, upstream_place_id: null }];
	const taxa = [
		{ place_key: region, month: 6, upstream_taxon_id: ROBIN_ID, canonical_name: 'Erithacus rubecula', raw_name: 'Erithacus rubecula', rank: 'SPECIES', reports: 10 },
		...extra.map((x) => ({ place_key: region, month: 6, upstream_taxon_id: x.id, canonical_name: x.name, raw_name: x.name, rank: 'SPECIES', reports: 1 }))
	];
	const totals = MONTHS.map((month) => ({ place_key: region, month, reports: month === 6 ? 10 + extra.length : 0, unkeyed: 0 }));
	return { places, totals, taxon_month: taxa };
}

/** Claim (the load must already be queued), send and finish. */
async function publish(region: string, extra: { id: string; name: string }[]): Promise<Lease> {
	const lease = await claim();
	const d = dataset(region, extra);
	const sent: { chunk_id: string; kind: string; rows: number; sha256: string }[] = [];
	for (const [kind, rows] of Object.entries(d)) {
		const r = await call(chunksRoute, lease.id, { ...fence(lease), chunk_id: `${kind}-1`, kind, sha256: rowsDigest(rows), rows });
		expect(r.status, JSON.stringify(r.body)).toBe(200);
		sent.push({ chunk_id: `${kind}-1`, kind, rows: rows.length, sha256: rowsDigest(rows) });
	}
	const counts: Record<string, number> = {};
	for (const s of sent) counts[s.kind] = s.rows;
	const manifest = {
		window_start: WINDOW_START,
		window_end: WINDOW_END,
		retrieved_at: new Date().toISOString(),
		source_snapshot: { through: WINDOW_END },
		filter_fingerprint: 'd'.repeat(64),
		chunks: sent,
		counts,
		places: [region],
		months: MONTHS
	};
	const f = await call(finishRoute, lease.id, { ...fence(lease), manifest });
	expect(f.status, JSON.stringify(f.body)).toBe(200);
	return lease;
}

async function load(region: string, extra: { id: string; name: string }[] = []): Promise<Lease> {
	await queueExternalLoad({ sourceId: SRC, regionCode: region, requestedBy: adminId });
	return publish(region, extra);
}

const FAKE = { id: FAKE_ID, name: 'Nonexistus fakeus' };
const FAKE2 = { id: FAKE2_ID, name: 'Nonexistus alterus' };
const FAKE3 = { id: FAKE3_ID, name: 'Nonexistus tertius' };

async function alerts() {
	return (
		await query<{ kind: string; region_code: string; taxa: { id: string }[] | null; status: string; attempts: number; load_id: string }>(
			`SELECT kind, region_code, taxa, status, attempts, load_id FROM external_alerts WHERE source_id = $1 ORDER BY id`,
			[SRC]
		)
	).rows;
}

async function regionName(code: string): Promise<string> {
	return (await query<{ name: string }>(`SELECT name FROM regions WHERE code = $1`, [code])).rows[0].name;
}

async function addSubs(n = 2): Promise<void> {
	for (const e of ENDPOINTS.slice(0, n)) {
		await query(`INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth) VALUES ($1, $2, 'p', 'a')`, [e, adminId]);
	}
}

/** Makes the region's published data `days` old. */
async function age(region: string, days: number): Promise<void> {
	await query(
		`UPDATE external_loads SET retrieved_at = now() - make_interval(days => $3), created_at = now() - make_interval(days => $3)
		  WHERE source_id = $1 AND region_code = $2 AND status = 'done'`,
		[SRC, region, days]
	);
}

// ── New unmatched taxa ─────────────────────────────────────────────────────

describe('new unmatched taxa at finish', () => {
	it('records the taxa no region of the source had outstanding, and only those', async () => {
		const first = await load(A, [FAKE]);
		expect(await alerts()).toEqual([
			{ kind: 'new_unmatched', region_code: A, taxa: [{ id: FAKE_ID, name: FAKE.name, reports: 1 }], status: 'pending', attempts: 0, load_id: first.id }
		]);
		// Unchanged reload: nothing new.
		await load(A, [FAKE]);
		// The same taxon in another county: already on the owner's list.
		await load(B, [FAKE]);
		expect((await alerts()).length).toBe(1);
		// A genuinely new one.
		const third = await load(A, [FAKE, FAKE2]);
		const all = await alerts();
		expect(all.length).toBe(2);
		expect(all[1]).toMatchObject({ load_id: third.id, taxa: [{ id: FAKE2_ID }] });
	});

	it('matches a nominate subspecies on its own, so it never needs an alert', async () => {
		await load(A, [{ id: NOMINATE_ID, name: 'Pica pica pica' }]);
		expect(await alerts()).toEqual([]);
		const sp = await query<{ species_code: string }>(
			`SELECT DISTINCT species_code FROM external_place_month_species WHERE source_id = $1 ORDER BY species_code`,
			[SRC]
		);
		expect(sp.rows.map((x) => x.species_code).sort()).toEqual([magpie, robin].sort());
		const un = await query(`SELECT 1 FROM external_unmatched WHERE source_id = $1`, [SRC]);
		expect(un.rowCount).toBe(0);
	});

	it('leaves no alert behind when the finish rolls back', async () => {
		await queueExternalLoad({ sourceId: SRC, regionCode: A, requestedBy: adminId });
		const lease = await claim();
		const d = dataset(A, [FAKE]);
		const sent = [];
		for (const [kind, rows] of Object.entries(d)) {
			await call(chunksRoute, lease.id, { ...fence(lease), chunk_id: `${kind}-1`, kind, sha256: rowsDigest(rows), rows });
			sent.push({ chunk_id: `${kind}-1`, kind, rows: rows.length, sha256: rowsDigest(rows) });
		}
		const counts = Object.fromEntries(sent.map((s) => [s.kind, s.rows]));
		const manifest = {
			window_start: WINDOW_START,
			window_end: WINDOW_END,
			retrieved_at: new Date().toISOString(),
			source_snapshot: { through: WINDOW_END },
			filter_fingerprint: 'd'.repeat(64),
			chunks: sent,
			counts,
			places: [A],
			months: MONTHS
		};
		await expect(
			finishLoad({ connectorId: tokenId, sourceId: SRC, storeObservers: false }, lease.id, fence(lease), manifest, { failAfterSwapForTest: true })
		).rejects.toThrow(/middle of the swap/);
		expect(await alerts()).toEqual([]);
	});
});

// ── Failed automatic refresh ───────────────────────────────────────────────

describe('failed automatic refresh', () => {
	it('alerts for an automatic load that failed for good, not for a manual one or a close', async () => {
		await queueExternalLoad({ sourceId: SRC, regionCode: A, requestedBy: adminId, origin: 'auto' });
		let lease = await claim();
		await call(failRoute, lease.id, { ...fence(lease), reason: 'provider said no', retryable: false });
		expect(await alerts()).toMatchObject([{ kind: 'refresh_failed', region_code: A, load_id: lease.id }]);

		await query(`DELETE FROM external_alerts WHERE source_id = $1`, [SRC]);
		await queueExternalLoad({ sourceId: SRC, regionCode: A, requestedBy: adminId });
		lease = await claim();
		await call(failRoute, lease.id, { ...fence(lease), reason: 'provider said no', retryable: false });
		expect(await alerts()).toEqual([]);

		await queueExternalLoad({ sourceId: SRC, regionCode: B, requestedBy: adminId, origin: 'auto' });
		lease = await claim();
		await query(`UPDATE external_region_map SET queueable = false WHERE source_id = $1 AND region_code = $2`, [SRC, B]);
		await call(failRoute, lease.id, { ...fence(lease), reason: 'stopped', retryable: true });
		expect(await alerts()).toEqual([]);
	});

	it('alerts when an automatic load is given up by lease expiry (the connector died)', async () => {
		const q = await queueExternalLoad({ sourceId: SRC, regionCode: A, requestedBy: adminId, origin: 'auto' });
		await claim();
		await query(`UPDATE external_loads SET attempt = max_attempts, lease_expires_at = now() - interval '1 minute' WHERE id = $1`, [q.loadId]);
		await withTransaction((c) => expireLeases(c, SRC));
		expect(await alerts()).toMatchObject([{ kind: 'refresh_failed', region_code: A, load_id: q.loadId }]);
	});
});

// ── The refresh pass: which region, when ───────────────────────────────────

describe('refresh pass: queueing', () => {
	it('queues the stalest loaded region once, then waits while it is active', async () => {
		await load(A);
		await load(B);
		expect((await pass()).queued).toBeNull();
		await age(A, 8);
		await age(B, 9);
		const r = await pass();
		expect(r.queued).toMatchObject({ sourceId: SRC, regionCode: B });
		const row = await query<{ origin: string; requested_by: number }>(`SELECT origin, requested_by FROM external_loads WHERE id = $1`, [r.queued!.loadId]);
		expect(row.rows[0]).toEqual({ origin: 'auto', requested_by: adminId });
		// One automatic load at a time: A waits.
		const again = await pass();
		expect(again.queued).toBeNull();
		expect(again.skipped).toEqual(['an automatic load is already queued or running']);
	});

	it('does not retry an automatic failure until the next interval', async () => {
		await load(A);
		await age(A, 8);
		const r = await pass();
		const lease = await claim();
		expect(lease.id).toBe(r.queued!.loadId);
		await call(failRoute, lease.id, { ...fence(lease), reason: 'down', retryable: false });
		expect((await pass()).queued).toBeNull();
		await query(`UPDATE external_loads SET created_at = now() - interval '8 days' WHERE id = $1`, [lease.id]);
		expect((await pass()).queued).toMatchObject({ regionCode: A });
	});

	it('skips a source switched off, refresh Off, a closed region, and a region never loaded', async () => {
		await load(A);
		await age(A, 8);
		await query(`UPDATE external_sources SET refresh_days = NULL WHERE id = $1`, [SRC]);
		expect((await pass()).queued).toBeNull();
		await query(`UPDATE external_sources SET refresh_days = 7, active = false WHERE id = $1`, [SRC]);
		expect((await pass()).queued).toBeNull();
		await query(`UPDATE external_sources SET active = true WHERE id = $1`, [SRC]);
		await query(`UPDATE external_region_map SET queueable = false WHERE source_id = $1 AND region_code = $2`, [SRC, A]);
		expect((await pass()).queued).toBeNull();
		const left = await query(`SELECT 1 FROM external_loads WHERE source_id = $1 AND region_code = $2`, [SRC, B]);
		expect(left.rowCount).toBe(0);
	});

	it('passes over a source whose data is being published right now', async () => {
		await load(A);
		await age(A, 8);
		const r = await withTransaction(async (c) => {
			await c.query(`SELECT pg_advisory_xact_lock(hashtext('external-source:' || $1))`, [SRC]);
			return pass();
		});
		expect(r.queued).toBeNull();
		expect(r.skipped).toEqual([`${SRC}/${A}: busy`]);
		expect((await pass()).queued).toMatchObject({ regionCode: A });
	});

	it('queues nothing for a source whose connector has gone quiet', async () => {
		await load(A);
		await age(A, 8);
		await query(`UPDATE external_connectors SET last_seen_at = now() - interval '1 hour' WHERE id = $1`, [tokenId]);
		expect((await pass()).queued).toBeNull();
		await query(`UPDATE external_connectors SET last_seen_at = now() WHERE id = $1`, [tokenId]);
		expect((await pass()).queued).toMatchObject({ regionCode: A });
	});

	it('gives up an automatic load nobody claimed for hours, with an alert, and frees the slot', async () => {
		await load(A);
		await load(B);
		const stuck = await queueExternalLoad({ sourceId: SRC, regionCode: B, requestedBy: adminId, origin: 'auto' });
		await age(A, 8);
		expect((await pass()).queued).toBeNull();
		await query(`UPDATE external_loads SET created_at = now() - interval '7 hours' WHERE id = $1`, [stuck.loadId]);
		const r = await pass();
		expect(r.gaveUp).toBe(1);
		expect(r.queued).toMatchObject({ regionCode: A });
		const row = await query<{ status: string; error: string }>(`SELECT status, error FROM external_loads WHERE id = $1`, [stuck.loadId]);
		expect(row.rows[0]).toEqual({ status: 'failed', error: AUTO_LOAD_GAVE_UP });
		expect((await alerts()).filter((x) => x.kind === 'refresh_failed')).toMatchObject([{ region_code: B, load_id: stuck.loadId }]);
	});

	it('drops a queued automatic load quietly when its source is switched off, freeing the slot', async () => {
		await load(A);
		const q = await queueExternalLoad({ sourceId: SRC, regionCode: B, requestedBy: adminId, origin: 'auto' });
		await query(`UPDATE external_sources SET active = false WHERE id = $1`, [SRC]);
		const r = await pass();
		expect(r.gaveUp).toBe(1);
		const row = await query<{ status: string; error: string }>(`SELECT status, error FROM external_loads WHERE id = $1`, [q.loadId]);
		expect(row.rows[0]).toEqual({ status: 'failed', error: AUTO_LOAD_SOURCE_OFF });
		expect(await alerts()).toEqual([]);
	});

	it("expires a dead connector's automatic lease so it stops blocking", async () => {
		await load(A);
		const q = await queueExternalLoad({ sourceId: SRC, regionCode: B, requestedBy: adminId, origin: 'auto' });
		await claim();
		await query(`UPDATE external_loads SET attempt = max_attempts, lease_expires_at = now() - interval '1 minute' WHERE id = $1`, [q.loadId]);
		await age(A, 8);
		const r = await pass();
		expect(r.expired).toBe(1);
		expect(r.queued).toMatchObject({ regionCode: A });
	});
});

// ── Delivery ───────────────────────────────────────────────────────────────

describe('refresh pass: alerts', () => {
	it('pushes to every device of the admin once, with the still-unmatched taxa', async () => {
		await addSubs();
		await load(A, [FAKE, FAKE2]);
		await setTaxonOverride({ sourceId: SRC, upstreamTaxonId: FAKE2_ID, species: robin, userId: adminId });
		const got: { endpoint: string; msg: PushMessage }[] = [];
		const r = await pass(async (s, msg) => void got.push({ endpoint: s.endpoint, msg }));
		expect(r.alerts).toMatchObject({ sent: 1 });
		expect(got.map((g) => g.endpoint)).toEqual(ENDPOINTS);
		expect(got[0].msg).toMatchObject({
			title: 'Norway: 1 new taxon to match',
			body: `Nordland: ${FAKE.name}`,
			url: `https://birds.test/admin?tab=sources&unmatched=${SRC}#source-${SRC}-unmatched`,
			tag: `ext-${SRC}-${A}-new_unmatched`
		});
		expect((await alerts())[0].status).toBe('sent');
		got.length = 0;
		await pass(async (s, msg) => void got.push({ endpoint: s.endpoint, msg }));
		expect(got).toEqual([]);
	});

	it('drops an alert with nothing left to say', async () => {
		await addSubs();
		await load(A, [FAKE]);
		await setTaxonOverride({ sourceId: SRC, upstreamTaxonId: FAKE_ID, species: robin, userId: adminId });
		const sent: unknown[] = [];
		const r = await pass(async (_s, m) => void sent.push(m));
		expect(r.alerts).toMatchObject({ dropped: 1, sent: 0 });
		expect(sent).toEqual([]);
		expect((await alerts())[0].status).toBe('dropped');
	});

	it('drops a failed-refresh alert once a newer load has published', async () => {
		await addSubs();
		await queueExternalLoad({ sourceId: SRC, regionCode: A, requestedBy: adminId, origin: 'auto' });
		const lease = await claim();
		await call(failRoute, lease.id, { ...fence(lease), reason: 'down', retryable: false });
		await load(A);
		const r = await pass();
		expect(r.alerts).toMatchObject({ dropped: 1 });
	});

	it('pushes a taxon that left the list and came back only once, from its newer alert', async () => {
		await addSubs(1);
		await load(A, [FAKE]);
		await load(A);
		await load(B, [FAKE]);
		const got: PushMessage[] = [];
		const r = await pass(async (_s, m) => void got.push(m));
		expect(r.alerts).toMatchObject({ sent: 1, dropped: 1 });
		expect(got.map((m) => m.tag)).toEqual([`ext-${SRC}-${B}-new_unmatched`]);
	});

	it('settles the alert on the first device that takes it, before the next is contacted', async () => {
		await addSubs(2);
		await load(A, [FAKE]);
		const seen: string[] = [];
		await pass(async (s) => {
			if (s.endpoint === ENDPOINTS[1]) seen.push((await alerts())[0].status);
		});
		expect(seen).toEqual(['sent']);
	});

	it('forgets a taxon matched and unmatched again by hand before the push went out', async () => {
		await addSubs(1);
		await load(A, [FAKE, FAKE2]);
		await setTaxonOverride({ sourceId: SRC, upstreamTaxonId: FAKE_ID, species: robin, userId: adminId });
		expect(await removeTaxonOverride(SRC, FAKE_ID)).toBe(true);
		expect((await query(`SELECT 1 FROM external_unmatched WHERE source_id = $1 AND upstream_taxon_id = $2`, [SRC, FAKE_ID])).rowCount).toBe(1);
		expect((await alerts())[0].taxa).toEqual([{ id: FAKE2_ID, name: FAKE2.name, reports: 1 }]);
		const got: PushMessage[] = [];
		await pass(async (_s, m) => void got.push(m));
		expect(got.map((m) => m.body)).toEqual([`Nordland: ${FAKE2.name}`]);
	});

	it("reads a later alert's taxa as they are when it is sent, not when the pass began", async () => {
		await addSubs(1);
		await load(A, [FAKE]);
		await load(B, [FAKE2, FAKE3]);
		const bodies: string[] = [];
		let edited = false;
		await pass(async (_s, m) => {
			bodies.push(m.body);
			if (!edited) {
				edited = true;
				// While the first alert is being sent: match FAKE2, then undo it.
				await setTaxonOverride({ sourceId: SRC, upstreamTaxonId: FAKE2_ID, species: robin, userId: adminId });
				expect(await removeTaxonOverride(SRC, FAKE2_ID)).toBe(true);
			}
		});
		expect(bodies).toEqual([`Nordland: ${FAKE.name}`, `${await regionName(B)}: ${FAKE3.name}`]);
	});

	it('rebuilds the push for the next device while no device has taken it yet', async () => {
		await addSubs(2);
		await load(A, [FAKE, FAKE2]);
		const got: { endpoint: string; body: string }[] = [];
		const r = await pass(async (s, m) => {
			got.push({ endpoint: s.endpoint, body: m.body });
			if (s.endpoint === ENDPOINTS[0]) {
				// The owner matches FAKE while device 1's push fails.
				await setTaxonOverride({ sourceId: SRC, upstreamTaxonId: FAKE_ID, species: robin, userId: adminId });
				throw new PushError('push service unavailable', 503, false);
			}
		});
		expect(got).toEqual([
			{ endpoint: ENDPOINTS[0], body: `Nordland: ${FAKE2.name}, ${FAKE.name}` },
			{ endpoint: ENDPOINTS[1], body: `Nordland: ${FAKE2.name}` }
		]);
		expect(r.alerts).toMatchObject({ sent: 1 });
	});

	it('drops the push midway when the owner matched everything before any device took it', async () => {
		await addSubs(2);
		await load(A, [FAKE]);
		const got: string[] = [];
		const r = await pass(async (s) => {
			got.push(s.endpoint);
			await setTaxonOverride({ sourceId: SRC, upstreamTaxonId: FAKE_ID, species: robin, userId: adminId });
			throw new PushError('push service unavailable', 503, false);
		});
		expect(got).toEqual([ENDPOINTS[0]]);
		expect(r.alerts).toMatchObject({ dropped: 1, sent: 0 });
		expect((await alerts())[0].status).toBe('dropped');
	});

	it('ends a resolved alert as dropped, not gave_up, when its last try fails', async () => {
		await addSubs(1);
		await load(A, [FAKE]);
		await query(`UPDATE external_alerts SET attempts = $2 WHERE source_id = $1`, [SRC, ALERT_MAX_ATTEMPTS - 1]);
		const r = await pass(async () => {
			await setTaxonOverride({ sourceId: SRC, upstreamTaxonId: FAKE_ID, species: robin, userId: adminId });
			throw new PushError('push service unavailable', 503, false);
		});
		expect(r.alerts).toMatchObject({ dropped: 1, gaveUp: 0 });
		expect((await alerts())[0].status).toBe('dropped');
	});

	it('skips a device re-keyed or moved while another was being sent to', async () => {
		await addSubs(2);
		await load(A, [FAKE]);
		const got: string[] = [];
		await pass(async (s) => {
			got.push(s.endpoint);
			if (s.endpoint === ENDPOINTS[0]) {
				await query(`UPDATE push_subscriptions SET p256dh = 'rekeyed' WHERE endpoint = $1`, [ENDPOINTS[1]]);
			}
		});
		expect(got).toEqual([ENDPOINTS[0]]);
	});

	it('with no devices, ends every alert with nothing left to say, due or not', async () => {
		await load(A, [FAKE]);
		await load(B, [FAKE2]);
		await setTaxonOverride({ sourceId: SRC, upstreamTaxonId: FAKE_ID, species: robin, userId: adminId });
		await query(`UPDATE external_alerts SET next_attempt_at = now() + interval '1 day' WHERE source_id = $1`, [SRC]);
		await query(`UPDATE external_alerts SET next_attempt_at = now() WHERE source_id = $1 AND region_code = $2`, [SRC, B]);
		const r = await pass();
		expect(r.alerts).toMatchObject({ dropped: 1, waiting: 1 });
		expect((await alerts()).map((x) => [x.region_code, x.status])).toEqual([
			[A, 'dropped'],
			[B, 'pending']
		]);
	});

	it('with no devices, ends a resolved alert even while it waits out a retry', async () => {
		await load(A, [FAKE]);
		await setTaxonOverride({ sourceId: SRC, upstreamTaxonId: FAKE_ID, species: robin, userId: adminId });
		await query(`UPDATE external_alerts SET next_attempt_at = now() + interval '1 day' WHERE source_id = $1`, [SRC]);
		expect((await pass()).alerts).toMatchObject({ dropped: 1 });
		expect((await alerts())[0].status).toBe('dropped');
	});

	it('ends a resolved alert when its only device turns out to be gone', async () => {
		await addSubs(1);
		await load(A, [FAKE]);
		const r = await pass(async () => {
			await setTaxonOverride({ sourceId: SRC, upstreamTaxonId: FAKE_ID, species: robin, userId: adminId });
			throw new PushError('gone', 410, true);
		});
		expect(r.alerts).toMatchObject({ dropped: 1, waiting: 0 });
	});

	it('keeps a failure alert when a load finished earlier in the same millisecond', async () => {
		await addSubs(1);
		await queueExternalLoad({ sourceId: SRC, regionCode: A, requestedBy: adminId, origin: 'auto' });
		const lease = await claim();
		await call(failRoute, lease.id, { ...fence(lease), reason: 'down', retryable: false });
		// A's done load finishes 0.4 ms BEFORE the alert, inside the same millisecond.
		await load(A);
		await query(
			`UPDATE external_alerts SET created_at = '2026-11-27 12:00:00.000900+00' WHERE source_id = $1 AND kind = 'refresh_failed'`,
			[SRC]
		);
		await query(
			`UPDATE external_loads SET finished_at = '2026-11-27 12:00:00.000500+00' WHERE source_id = $1 AND region_code = $2 AND status = 'done'`,
			[SRC, A]
		);
		const sent: PushMessage[] = [];
		const r = await pass(async (_s, m) => void sent.push(m));
		expect(r.alerts).toMatchObject({ sent: 1 });
		expect(sent[0].title).toBe('Norway: Nordland refresh failed');
	});

	it('prunes a gone device even when a later device throws', async () => {
		await addSubs(2);
		await load(A, [FAKE]);
		await expect(
			pass(async (s) => {
				if (s.endpoint === ENDPOINTS[0]) throw new PushError('gone', 410, true);
				throw new Error('boom');
			})
		).rejects.toThrow('boom');
		const left = await query<{ endpoint: string }>(`SELECT endpoint FROM push_subscriptions WHERE user_id = $1`, [adminId]);
		expect(left.rows.map((x) => x.endpoint)).toEqual([ENDPOINTS[1]]);
	});

	it('records a push a device took even if a later device throws something unexpected', async () => {
		await addSubs(2);
		await load(A, [FAKE]);
		await expect(
			pass(async (s) => {
				if (s.endpoint === ENDPOINTS[1]) throw new Error('boom');
			})
		).rejects.toThrow('boom');
		expect((await alerts())[0].status).toBe('sent');
	});

	it('waits without spending attempts while the admin has no devices', async () => {
		await load(A, [FAKE]);
		const r = await pass();
		expect(r.alerts).toMatchObject({ waiting: 1, sent: 0 });
		expect((await alerts())[0]).toMatchObject({ status: 'pending', attempts: 0 });
	});

	it('retries a push no device accepted, then gives up', async () => {
		await addSubs(1);
		await load(A, [FAKE]);
		const fail = async () => {
			throw new PushError('push service unavailable', 503, false);
		};
		expect((await pass(fail)).alerts).toMatchObject({ retrying: 1 });
		expect((await alerts())[0]).toMatchObject({ status: 'pending', attempts: 1 });
		// Not due again until its backoff passes.
		expect((await pass(fail)).alerts).toMatchObject({ retrying: 0 });
		await query(`UPDATE external_alerts SET attempts = $2, next_attempt_at = now() WHERE source_id = $1`, [SRC, ALERT_MAX_ATTEMPTS - 1]);
		expect((await pass(fail)).alerts).toMatchObject({ gaveUp: 1 });
		expect((await alerts())[0].status).toBe('gave_up');
	});

	it("prunes a device the push service says is gone, and only the fixture admin's", async () => {
		await addSubs(2);
		await load(A, [FAKE]);
		const r = await pass(async (s) => {
			if (s.endpoint === ENDPOINTS[0]) throw new PushError('gone', 410, true);
		});
		expect(r.alerts).toMatchObject({ sent: 1 });
		const left = await query<{ endpoint: string }>(`SELECT endpoint FROM push_subscriptions WHERE user_id = $1`, [adminId]);
		expect(left.rows.map((x) => x.endpoint)).toEqual([ENDPOINTS[1]]);
	});
});

describe('Reload loaded regions', () => {
	it('queues every loaded open region, and says so plainly for a switched-off source (409)', async () => {
		await load(A);
		await load(B);
		expect(await reloadLoadedRegions(SRC, adminId)).toBe(2);
		await query(`UPDATE external_loads SET status = 'failed', finished_at = now() WHERE source_id = $1 AND status = 'queued'`, [SRC]);
		await query(`UPDATE external_sources SET active = false WHERE id = $1`, [SRC]);
		const body = new FormData();
		body.set('source_id', SRC);
		const r = await (adminActions as any).reload_loaded_regions({
			locals: { user: { id: adminId, role: 'admin' } },
			request: new Request('http://localhost/admin', { method: 'POST', body })
		});
		expect(r.status).toBe(409);
		expect(r.data).toMatchObject({ ok: false, message: 'This source is switched off.' });
	});
});

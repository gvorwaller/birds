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
import { recordCheckIn } from './auth';
import { connectorHealth } from './connector-health';
import { enqueueJob } from '$server/jobs';
import { pullForwardRecurring } from '$server/job-handlers';
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
/** A believable reported process start: an hour before the test runs (CODEX1 code review #7). */
const STARTED = new Date(Math.floor(Date.now() / 1000) * 1000 - 3_600_000).toISOString();
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
		'external_connector_outages',
		'external_loads'
	]) {
		await query(`DELETE FROM ${table} WHERE source_id = $1`, [SRC]);
	}
	// td-afba28: the fixture token back to usable, and any extra token gone.
	await query(`DELETE FROM external_connectors WHERE source_id = $1 AND id <> $2`, [SRC, tokenId]);
	await query(`UPDATE external_connectors SET revoked_at = NULL, version = NULL, started_at = NULL WHERE id = $1`, [tokenId]);
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

async function call(
	route: Route,
	loadId: string | null,
	body: unknown,
	headers: Record<string, string> = {}
): Promise<{ status: number; body: any }> {
	resetIngestRateForTest();
	const request = new Request('http://localhost/api/ingest/x', {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
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
		// Started an hour ago, so the hourly admission gate (td-afba28) is open again.
		await query(
			`UPDATE external_loads SET attempt = max_attempts, lease_expires_at = now() - interval '1 minute',
			        created_at = now() - interval '1 hour' WHERE id = $1`,
			[q.loadId]
		);
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

// ── Connector watch (td-afba28) ─────────────────────────────────────────────

/** The connector last checked in `minutes` ago, and the source has been on for a day. */
async function silence(minutes: number): Promise<void> {
	await query(`UPDATE external_connectors SET last_seen_at = now() - make_interval(mins => $2) WHERE source_id = $1`, [SRC, minutes]);
	await query(`UPDATE external_sources SET active_changed_at = now() - interval '1 day' WHERE id = $1`, [SRC]);
}

/** Resolves once some backend is waiting on a lock held by `pid` (CODEX1 round 7: no timers). */
async function blockedBy(pid: number): Promise<void> {
	for (let i = 0; i < 200; i++) {
		const r = await query(`SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`, [pid]);
		if (r.rowCount) return;
		await new Promise((res) => setTimeout(res, 25));
	}
	throw new Error(`nothing became blocked by backend ${pid}`);
}

/** A check-in: an empty claim, as a polling connector makes every 10 s. */
async function checkIn(headers: Record<string, string> = {}): Promise<void> {
	const r = await call(claimRoute, null, { contract_version: 1, idempotency_key: `poll-${Math.random().toString(36).slice(2, 10)}` }, headers);
	expect([200, 204]).toContain(r.status);
}

async function outages() {
	return (
		await query<{ id: string; closed_reason: string | null; closed_at: Date | null; last_seen_at: Date }>(
			`SELECT id, closed_reason, closed_at, last_seen_at FROM external_connector_outages WHERE source_id = $1 ORDER BY id`,
			[SRC]
		)
	).rows;
}

async function connectorAlerts() {
	return (
		await query<{ kind: string; status: string; outage_id: string; attempts: number }>(
			`SELECT kind, status, outage_id, attempts FROM external_alerts WHERE source_id = $1 AND outage_id IS NOT NULL ORDER BY id`,
			[SRC]
		)
	).rows;
}

function recorder() {
	const got: { endpoint: string; msg: PushMessage }[] = [];
	return { got, send: async (s: PushSubscriptionRow, msg: PushMessage) => void got.push({ endpoint: s.endpoint, msg }) };
}

describe('connector watch: outages', () => {
	it('opens an outage only after 15 silent minutes, once, and pushes it once to each device', async () => {
		await addSubs();
		await silence(10);
		expect((await pass()).connectors.opened).toBe(0);
		await silence(20);
		const rec = recorder();
		const r = await pass(rec.send);
		expect(r.connectors.opened).toBe(1);
		expect(r.alerts.sent).toBe(1);
		expect(rec.got.map((g) => g.endpoint)).toEqual(ENDPOINTS);
		expect(rec.got[0].msg).toMatchObject({
			title: 'Norway connector offline',
			url: 'https://birds.test/admin?tab=health#sys-connectors',
			tag: `ext-${SRC}-connector`
		});
		expect(rec.got[0].msg.body).toMatch(/^Last heard from 20 min ago\. Loads wait until it's back\.$/);
		rec.got.length = 0;
		const again = await pass(rec.send);
		expect(again.connectors.opened).toBe(0);
		expect(rec.got).toEqual([]);
		expect(await outages()).toHaveLength(1);
		expect((await connectorAlerts()).map((a) => [a.kind, a.status])).toEqual([['connector_offline', 'sent']]);
	});

	it('opens nothing for a token that never checked in, or within 15 minutes of the source being switched on', async () => {
		await query(`UPDATE external_connectors SET last_seen_at = NULL WHERE source_id = $1`, [SRC]);
		await query(`UPDATE external_sources SET active_changed_at = now() - interval '1 day' WHERE id = $1`, [SRC]);
		expect((await pass()).connectors.opened).toBe(0);
		await silence(60);
		// Switched off and on again: the trigger dates the switch-on now.
		await query(`UPDATE external_sources SET active = false WHERE id = $1`, [SRC]);
		await query(`UPDATE external_sources SET active = true WHERE id = $1`, [SRC]);
		const on = await query<{ recent: boolean }>(`SELECT active_changed_at > now() - interval '1 minute' AS recent FROM external_sources WHERE id = $1`, [SRC]);
		expect(on.rows[0].recent).toBe(true);
		expect((await pass()).connectors.opened).toBe(0);
		expect(await outages()).toEqual([]);
	});

	it('says nothing about a gap that ended between two checks', async () => {
		await silence(20);
		await checkIn();
		const r = await pass();
		expect(r.connectors.opened).toBe(0);
		expect(await outages()).toEqual([]);
	});

	it('closes the outage at the check-in, then sends exactly one back-online push', async () => {
		await addSubs();
		await silence(20);
		await pass();
		await checkIn();
		const [o] = await outages();
		expect(o.closed_reason).toBe('back_online');
		expect(Date.now() - o.closed_at!.getTime()).toBeLessThan(60_000);
		const rec = recorder();
		const r = await pass(rec.send);
		expect(r.connectors.backOnline).toBe(1);
		expect(rec.got).toHaveLength(2);
		expect(rec.got[0].msg).toMatchObject({
			title: 'Norway connector back online',
			body: 'It was offline for 20 min.',
			url: 'https://birds.test/admin?tab=health#sys-connectors',
			tag: `ext-${SRC}-connector`
		});
		rec.got.length = 0;
		const again = await pass(rec.send);
		expect(again.connectors.backOnline).toBe(0);
		expect(rec.got).toEqual([]);
		expect((await connectorAlerts()).map((a) => [a.kind, a.status])).toEqual([
			['connector_offline', 'sent'],
			['connector_online', 'sent']
		]);
	});

	it('back before the offline push went out: neither push is sent', async () => {
		await silence(20);
		const first = await pass();
		expect(first.connectors.opened).toBe(1);
		expect(first.alerts.waiting).toBe(1); // no device yet
		await checkIn();
		await addSubs();
		const rec = recorder();
		const r = await pass(rec.send);
		expect(r.connectors.backOnline).toBe(0);
		expect(rec.got).toEqual([]);
		expect((await connectorAlerts()).map((a) => [a.kind, a.status])).toEqual([['connector_offline', 'dropped']]);
	});

	it('a check-in after the alert was picked but before any device took it drops it', async () => {
		await addSubs();
		await silence(20);
		let sends = 0;
		const r = await pass(async () => {
			sends++;
			await checkIn();
			throw new PushError('push service unavailable', 503, false);
		});
		expect(sends).toBe(1); // the second device's rebuild saw the check-in
		expect(r.alerts.dropped).toBe(1);
		expect((await connectorAlerts()).map((a) => a.status)).toEqual(['dropped']);
	});

	it('a recovery during the accepted offline send still gets its one back-online push', async () => {
		await addSubs(1);
		await silence(20);
		// The check-in commits while the push is in flight; the device then accepts.
		await pass(async () => {
			await checkIn();
		});
		expect((await outages())[0].closed_reason).toBe('back_online');
		expect((await connectorAlerts()).map((a) => [a.kind, a.status])).toEqual([['connector_offline', 'sent']]);
		const rec = recorder();
		const r = await pass(rec.send);
		expect(r.connectors.backOnline).toBe(1);
		expect(rec.got.map((g) => g.msg.title)).toEqual(['Norway connector back online']);
	});

	it('closes quietly when the source is switched off, and when its last usable token is revoked', async () => {
		await silence(20);
		await pass();
		await query(`UPDATE external_sources SET active = false WHERE id = $1`, [SRC]);
		// The switch itself ends it (0105's trigger), before any pass.
		expect((await outages())[0].closed_reason).toBe('source_off');
		const off = await pass();
		expect(off.connectors.closed).toBe(0);
		expect((await connectorAlerts()).map((a) => a.status)).toEqual(['dropped']);

		await query(`UPDATE external_sources SET active = true WHERE id = $1`, [SRC]);
		await silence(20);
		await pass();
		// Revoke-and-replace: the new token has not checked in yet.
		await query(`UPDATE external_connectors SET revoked_at = now() WHERE id = $1`, [tokenId]);
		await query(`INSERT INTO external_connectors (source_id, label, token_sha256) VALUES ($1, 'xr-new', $2)`, [SRC, tokenHash(newConnectorToken())]);
		const revoked = await pass();
		expect(revoked.connectors.closed).toBe(1);
		expect((await outages()).map((o) => o.closed_reason)).toEqual(['source_off', 'no_token']);
		expect((await connectorAlerts()).map((a) => a.status)).toEqual(['dropped', 'dropped']);
	});

	it('a back-online push is dropped once the connector is quiet again or a newer outage opened', async () => {
		await addSubs(1);
		await silence(20);
		await pass();
		await checkIn();
		// Quiet again before the back-online push went out.
		await query(`UPDATE external_connectors SET last_seen_at = now() - interval '10 minutes' WHERE source_id = $1`, [SRC]);
		const rec = recorder();
		const quiet = await pass(rec.send);
		expect(quiet.connectors.backOnline).toBe(1);
		expect(rec.got).toEqual([]);
		expect((await connectorAlerts()).map((a) => [a.kind, a.status])).toEqual([
			['connector_offline', 'sent'],
			['connector_online', 'dropped']
		]);
	});

	it('a check-in that is followed by a new silence makes two outages, never one', async () => {
		await addSubs(1);
		await silence(20);
		await pass();
		await checkIn();
		await silence(20);
		const rec = recorder();
		const r = await pass(rec.send);
		expect(r.connectors.opened).toBe(1);
		expect(await outages()).toHaveLength(2);
		// The new offline goes out; the first outage's back-online is stale (a newer outage) and dropped.
		expect(rec.got.map((g) => g.msg.title)).toEqual(['Norway connector offline']);
		expect((await connectorAlerts()).map((a) => [a.kind, a.status])).toEqual([
			['connector_offline', 'sent'],
			['connector_offline', 'sent'],
			['connector_online', 'dropped']
		]);
	});

	it('records the reported version and start, keeping them through calls without or with bad headers', async () => {
		await silence(1);
		await checkIn({ 'x-connector-version': 'abc1234', 'x-connector-started': STARTED });
		const read = async () =>
			(await query<{ version: string | null; started_at: Date | null }>(`SELECT version, started_at FROM external_connectors WHERE id = $1`, [tokenId]))
				.rows[0];
		expect(await read()).toEqual({ version: 'abc1234', started_at: new Date(STARTED) });
		await silence(1);
		await checkIn({ 'x-connector-version': 'not a sha!', 'x-connector-started': '2099-01-01T00:00:00Z' });
		await silence(1);
		await checkIn();
		expect(await read()).toEqual({ version: 'abc1234', started_at: new Date(STARTED) });
	});

	it('refuses an alert that names another source than its outage', async () => {
		const other = `${SRC}-b`;
		await query(
			`INSERT INTO external_sources (id, name, publisher, license, license_url, citation, attribution, record_semantics,
			                               homepage, covers_country, geo_scheme, window_months)
			 VALUES ($1, $1, 'p', 'l', 'https://example.org/', 'c', 'a', 'reports', 'https://example.org/', 'NO', 'TEST', 24)`,
			[other]
		);
		try {
			const o = await query<{ id: string }>(`INSERT INTO external_connector_outages (source_id, last_seen_at) VALUES ($1, now()) RETURNING id`, [SRC]);
			await expect(
				query(`INSERT INTO external_alerts (source_id, kind, outage_id) VALUES ($1, 'connector_offline', $2)`, [other, o.rows[0].id])
			).rejects.toMatchObject({ code: '23503' });
			// A connector alert with a region, or a load alert without one, is refused too.
			await expect(
				query(`INSERT INTO external_alerts (source_id, kind, outage_id, region_code) VALUES ($1, 'connector_offline', $2, $3)`, [SRC, o.rows[0].id, A])
			).rejects.toMatchObject({ code: '23514' });
		} finally {
			await query(`DELETE FROM external_sources WHERE id = $1`, [other]);
		}
	});
});

describe('connector watch: hourly admission and the card', () => {
	it('starts at most one automatic load an hour', async () => {
		await load(A);
		await load(B);
		await age(A, 8);
		await age(B, 9);
		const first = await pass();
		expect(first.queued).toMatchObject({ regionCode: B });
		const lease = await claim();
		await call(failRoute, lease.id, { ...fence(lease), reason: 'test', retryable: false });
		const soon = await pass();
		expect(soon.queued).toBeNull();
		expect(soon.skipped).toContain('an automatic load was started within the hour');
		await query(`UPDATE external_loads SET created_at = now() - interval '56 minutes' WHERE source_id = $1 AND origin = 'auto'`, [SRC]);
		const later = await pass();
		expect(later.queued).toMatchObject({ regionCode: A });
	});

	it('pulls a waiting run scheduled an hour out forward to one tick', async () => {
		const key = `refresh_external_sources:xr-${RUN}`;
		const { jobId } = await enqueueJob({ type: 'refresh_external_sources', payload: {}, dedupKey: key, requestedBy: adminId, label: 'hourly', runAfterMs: 3_600_000 });
		try {
			expect(await pullForwardRecurring(key, 5 * 60_000, 'every 5 min')).toBe(1);
			const j = await query<{ label: string; soon: boolean }>(
				`SELECT label, next_retry_at <= now() + interval '5 minutes' AS soon FROM jobs WHERE id = $1`,
				[jobId]
			);
			expect(j.rows[0]).toEqual({ label: 'every 5 min', soon: true });
			// Already within a tick: left alone.
			expect(await pullForwardRecurring(key, 5 * 60_000, 'every 5 min')).toBe(0);
		} finally {
			await query(`DELETE FROM job_events WHERE job_id = $1`, [jobId]);
			await query(`DELETE FROM jobs WHERE id = $1`, [jobId]);
		}
	});

	it('the Server health card reads the source as it is', async () => {
		await addSubs(1);
		await load(A);
		await silence(1); // past the 5 s check-in throttle the load's calls just used
		await checkIn({ 'x-connector-version': 'abc1234', 'x-connector-started': STARTED });
		let row = (await connectorHealth(5_000)).rows.find((x) => x.sourceId === SRC)!;
		expect(row).toMatchObject({ state: 'online', version: 'abc1234', queued: 0, loading: [], outage: null, refreshDays: 7 });
		expect(row.lastLoad).toMatchObject({ regionName: 'Nordland', status: 'done', origin: 'manual' });
		expect(row.oldestLoaded).toMatchObject({ regionName: 'Nordland' });
		await silence(20);
		await pass(async () => {});
		row = (await connectorHealth(5_000)).rows.find((x) => x.sourceId === SRC)!;
		expect(row.state).toBe('offline');
		expect(row.outage).toMatchObject({ notice: 'sent' });
		await query(`UPDATE external_sources SET active = false WHERE id = $1`, [SRC]);
		row = (await connectorHealth(5_000)).rows.find((x) => x.sourceId === SRC)!;
		expect(row.state).toBe('off');
	});
});

describe('connector watch: code review fixes (CODEX1 td-afba28)', () => {
	it('an off/on cycle ends an open outage, so its offline alert is never sent into the new activation', async () => {
		await silence(20);
		const first = await pass();
		expect(first.connectors.opened).toBe(1);
		// Switched off and straight back on between two passes; then a device appears.
		await query(`UPDATE external_sources SET active = false WHERE id = $1`, [SRC]);
		await query(`UPDATE external_sources SET active = true WHERE id = $1`, [SRC]);
		expect((await outages()).map((o) => o.closed_reason)).toEqual(['source_off']);
		await addSubs(1);
		const rec = recorder();
		const r = await pass(rec.send);
		expect(rec.got).toEqual([]);
		expect(r.connectors.opened).toBe(0); // inside 15 min of the switch-on
		expect((await connectorAlerts()).map((a) => a.status)).toEqual(['dropped']);
		// Silent past 15 min of the new activation: a new outage, and its push.
		await silence(20);
		const next = await pass(rec.send);
		expect(next.connectors.opened).toBe(1);
		expect(rec.got.map((g) => g.msg.title)).toEqual(['Norway connector offline']);
	});

	it('a switch off and on while an outage is being opened waits for it, ends it, and the next silence gets its own push (two connections)', async () => {
		await silence(20);
		let switching: Promise<unknown> | null = null;
		let settled = false;
		const r = await runRefreshPass({
			origin: 'https://birds.test',
			sourceIds: [SRC],
			admins: [adminId],
			send: async () => {},
			afterOutageOpened: async (_id, pid) => {
				// Another connection switches the source off and on while the outage
				// is opened but not committed: it must wait for this transaction.
				switching = (async () => {
					await query(`UPDATE external_sources SET active = false WHERE id = $1`, [SRC]);
					await query(`UPDATE external_sources SET active = true WHERE id = $1`, [SRC]);
				})().finally(() => (settled = true));
				await blockedBy(pid);
				expect(settled).toBe(false);
			}
		});
		expect(r.connectors.opened).toBe(1);
		await switching;
		// The switch's trigger saw the committed outage and ended it.
		expect((await outages()).map((o) => o.closed_reason)).toEqual(['source_off']);
		// Silent past the new activation's grace: exactly one new outage and one push.
		await addSubs(1);
		await silence(20);
		const rec = recorder();
		const next = await pass(rec.send);
		expect(next.connectors.opened).toBe(1);
		expect(rec.got.map((g) => g.msg.title)).toEqual(['Norway connector offline']);
		expect((await connectorAlerts()).map((a) => a.status)).toEqual(['dropped', 'sent']);
	});

	it('a recovery committed inside a long switch transaction is from before the switch: no back-online push after it (two connections)', async () => {
		await addSubs(1);
		await silence(20);
		await pass(); // offline sent
		await withTransaction(async (c) => {
			await c.query('SELECT 1'); // the switch transaction starts here
			await checkIn(); // another connection: back online, closing the outage
			await c.query(`UPDATE external_sources SET active = false WHERE id = $1`, [SRC]);
			await c.query(`UPDATE external_sources SET active = true WHERE id = $1`, [SRC]);
		});
		expect((await outages()).map((o) => o.closed_reason)).toEqual(['back_online']);
		const rec = recorder();
		await pass(rec.send);
		expect(rec.got).toEqual([]);
		expect((await connectorAlerts()).map((a) => [a.kind, a.status])).toEqual([
			['connector_offline', 'sent'],
			['connector_online', 'dropped']
		]);
	});

	it('an outage opened inside a long switch transaction ends no earlier than it was detected (two connections)', async () => {
		await silence(20);
		await withTransaction(async (c) => {
			await c.query('SELECT 1'); // the switch transaction starts here
			expect((await pass()).connectors.opened).toBe(1); // the worker, on another connection
			await c.query(`UPDATE external_sources SET active = false WHERE id = $1`, [SRC]);
		});
		const o = await query<{ closed_reason: string; ordered: boolean }>(
			`SELECT closed_reason, closed_at >= detected_at AS ordered FROM external_connector_outages WHERE source_id = $1`,
			[SRC]
		);
		expect(o.rows).toEqual([{ closed_reason: 'source_off', ordered: true }]);
	});

	it.each([
		['its token', false],
		['a token issued during the pass', true]
	])('a check-in by %s, paused after its source lock, makes the worker skip the source: no outage is decided mid-check-in (two connections)', async (_name, fresh) => {
		await silence(20);
		let id = String(tokenId);
		if (fresh) {
			id = (
				await query<{ id: string }>(`INSERT INTO external_connectors (source_id, label, token_sha256) VALUES ($1, 'xr-new', $2) RETURNING id`, [
					SRC,
					tokenHash(newConnectorToken())
				])
			).rows[0].id;
		}
		let during: Awaited<ReturnType<typeof pass>> | null = null;
		await recordCheckIn(id, SRC, { version: null, startedAt: null }, async () => {
			during = await pass();
		});
		expect(during!.connectors.opened).toBe(0);
		expect(await outages()).toEqual([]);
		// Checked in: the next pass sees a live connector.
		expect((await pass()).connectors.opened).toBe(0);
		expect(await outages()).toEqual([]);
	});

	it('a token issued after the worker scanned the tokens waits to check in, then closes the outage at its own moment (two connections)', async () => {
		await silence(20);
		let checking: Promise<void> | null = null;
		let newId = '';
		const r = await runRefreshPass({
			origin: 'https://birds.test',
			sourceIds: [SRC],
			admins: [adminId],
			send: async () => {},
			afterOutageOpened: async (_id, pid) => {
				// Another connection issues a token and checks in with it while the
				// outage is opened but not committed: the check-in must wait.
				newId = (
					await query<{ id: string }>(`INSERT INTO external_connectors (source_id, label, token_sha256) VALUES ($1, 'xr-new', $2) RETURNING id`, [
						SRC,
						tokenHash(newConnectorToken())
					])
				).rows[0].id;
				checking = recordCheckIn(newId, SRC, { version: null, startedAt: null });
				await blockedBy(pid);
				expect(await outages()).toEqual([]); // not committed yet: nothing visible elsewhere
			}
		});
		expect(r.connectors.opened).toBe(1);
		await checking;
		const o = await query<{ closed_reason: string; same: boolean; ordered: boolean }>(
			`SELECT o.closed_reason, k.last_seen_at = o.closed_at AS same, o.closed_at >= o.detected_at AS ordered
			   FROM external_connector_outages o JOIN external_connectors k ON k.id = $2
			  WHERE o.source_id = $1`,
			[SRC, newId]
		);
		expect(o.rows).toEqual([{ closed_reason: 'back_online', same: true, ordered: true }]);
	});

	it('a check-in that closes an outage records one moment for both, inside the episode', async () => {
		await silence(20);
		await pass();
		await silence(1); // past the throttle, still in the episode
		await query(`UPDATE external_sources SET active_changed_at = now() - interval '1 day' WHERE id = $1`, [SRC]);
		await recordCheckIn(String(tokenId), SRC, { version: null, startedAt: null });
		const o = await query<{ closed_reason: string; ordered: boolean; same: boolean }>(
			`SELECT o.closed_reason, o.closed_at >= o.detected_at AS ordered, k.last_seen_at = o.closed_at AS same
			   FROM external_connector_outages o JOIN external_connectors k ON k.id = $2
			  WHERE o.source_id = $1`,
			[SRC, tokenId]
		);
		expect(o.rows).toEqual([{ closed_reason: 'back_online', ordered: true, same: true }]);
	});

	it('a check-in that waits for its token row records the time after the wait, not before (two connections)', async () => {
		await silence(20);
		let checkIn: Promise<void> | null = null;
		let releasedAt = new Date(0);
		await withTransaction(async (c) => {
			// A load step on another connection holds the token row, as assertConnectorLive does.
			await c.query(`SELECT 1 FROM external_connectors WHERE id = $1 FOR SHARE`, [tokenId]);
			checkIn = recordCheckIn(String(tokenId), SRC, { version: null, startedAt: null });
			await blockedBy((await c.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0].pid);
			releasedAt = (await c.query<{ t: Date }>(`SELECT clock_timestamp() AS t`)).rows[0].t;
		});
		await checkIn;
		const seen = (await query<{ last_seen_at: Date }>(`SELECT last_seen_at FROM external_connectors WHERE id = $1`, [tokenId])).rows[0];
		expect(seen.last_seen_at.getTime()).toBeGreaterThanOrEqual(releasedAt.getTime());
	});

	it('a check-in by a token revoked, or for a source switched off, after it was looked up counts for nothing', async () => {
		await silence(20);
		await pass();
		const before = (await query<{ last_seen_at: Date }>(`SELECT last_seen_at FROM external_connectors WHERE id = $1`, [tokenId])).rows[0].last_seen_at;
		await query(`UPDATE external_connectors SET revoked_at = now() WHERE id = $1`, [tokenId]);
		await recordCheckIn(String(tokenId), SRC, { version: null, startedAt: null });
		await query(`UPDATE external_connectors SET revoked_at = NULL WHERE id = $1`, [tokenId]);
		expect((await outages())[0].closed_at).toBeNull();
		const after = (await query<{ last_seen_at: Date }>(`SELECT last_seen_at FROM external_connectors WHERE id = $1`, [tokenId])).rows[0].last_seen_at;
		expect(after).toEqual(before);
		// Switched off after the lookup: nothing recorded either (the trigger closed the outage as source_off).
		await query(`UPDATE external_sources SET active = false WHERE id = $1`, [SRC]);
		await recordCheckIn(String(tokenId), SRC, { version: null, startedAt: null });
		expect((await outages())[0].closed_reason).toBe('source_off');
		expect((await query<{ last_seen_at: Date }>(`SELECT last_seen_at FROM external_connectors WHERE id = $1`, [tokenId])).rows[0].last_seen_at).toEqual(before);
	});

	it('a device that accepted the offline push wins over a takeover drop, the rest are not told, and back-online follows', async () => {
		await addSubs(2);
		await silence(20);
		const sentTo: string[] = [];
		await pass(async (sub) => {
			sentTo.push(sub.endpoint);
			// While this push is in flight, the connector comes back and a worker that
			// took over drops the alert; then this device accepts it.
			await checkIn();
			await query(`UPDATE external_alerts SET status = 'dropped', finished_at = now() WHERE source_id = $1 AND status = 'pending'`, [SRC]);
		});
		expect(sentTo).toEqual([ENDPOINTS[0]]); // the second device saw the connector back
		expect((await connectorAlerts()).map((a) => [a.kind, a.status])).toEqual([['connector_offline', 'sent']]);
		const rec = recorder();
		const r = await pass(rec.send);
		expect(r.connectors.backOnline).toBe(1);
		expect(rec.got.map((g) => g.msg.title)).toEqual(['Norway connector back online', 'Norway connector back online']);
	});

	it('a push no device took is tried again on the pass after its hourly delay, not before', async () => {
		await addSubs(1);
		await silence(20);
		const fail = async () => {
			throw new PushError('push service unavailable', 503, false);
		};
		const r = await pass(fail);
		expect(r.alerts.retrying).toBe(1);
		const due = await query<{ mins: number }>(
			`SELECT extract(epoch FROM next_attempt_at - now()) / 60 AS mins FROM external_alerts WHERE source_id = $1`,
			[SRC]
		);
		expect(Number(due.rows[0].mins)).toBeGreaterThan(54);
		expect(Number(due.rows[0].mins)).toBeLessThan(56);
		// The next 5-minute pass leaves it alone.
		let tries = 0;
		await pass(async () => void tries++);
		expect(tries).toBe(0);
		// Once the delay has passed, the next pass sends it.
		await query(`UPDATE external_alerts SET next_attempt_at = now() - interval '1 second' WHERE source_id = $1`, [SRC]);
		const later = await pass(async () => void tries++);
		expect(tries).toBe(1);
		expect(later.alerts.sent).toBe(1);
	});
});

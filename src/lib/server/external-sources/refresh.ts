/**
 * External sources: automatic refresh and owner alerts (td-9fe839, plan
 * docs/2026-11-27-external-refresh-plan-CC.md). One pass of the worker's
 * hourly `refresh_external_sources` job:
 *
 *   1. expire overdue leases, so a dead connector's automatic load never
 *      blocks the queue until the daily sweep, and give up an automatic load
 *      still not done after AUTO_LOAD_GIVE_UP_HOURS (its connector is offline
 *      or keeps dying), with a failed-refresh alert;
 *   2. queue at most ONE automatic reload in the whole app — the loaded,
 *      open region whose published data is oldest past its source's refresh
 *      interval, with no automatic attempt inside that interval (the
 *      cooldown: a failed one waits for the next interval), and only for a
 *      source whose connector has been heard from in the last few minutes;
 *   3. push the pending owner alerts (new unmatched taxa, a failed automatic
 *      refresh) to every current admin's devices.
 *
 * `sourceIds` scopes every step to those sources and `admins` the requester
 * and recipients to those admin accounts (tests own theirs, so a fixture
 * never queues under the owner's account or prunes his devices); the worker
 * passes neither.
 */
import type pg from 'pg';
import { query } from '$lib/db';
import { assertClaimHeld, claimFencedQuery, withClaimTx } from '$server/job-claim';
import { PushError, sendWebPush, type PushMessage, type PushSubscriptionRow } from '$server/push';
import {
	ALERT_MAX_ATTEMPTS,
	AUTO_LOAD_GIVE_UP_HOURS,
	CONNECTOR_ALIVE_MINUTES,
	alertPath,
	alertPush,
	alertRetryDelayMs
} from '$lib/external-refresh-policy';
import { expireLeases, IngestError, insertAlert, queueExternalLoadTx, type AlertTaxon } from './lifecycle';

type Db = pg.PoolClient;

export interface RefreshPassOptions {
	/** Absolute origin for the push click URL, e.g. https://birds.gaylon.photos. */
	origin: string;
	/** Tests: only these sources. */
	sourceIds?: readonly string[];
	/** Tests: only these admin accounts request loads and receive alerts. */
	admins?: readonly number[];
	/** Tests: a stub push. */
	send?: (sub: PushSubscriptionRow, msg: PushMessage) => Promise<void>;
}

export interface RefreshPassResult {
	expired: number;
	/** Automatic loads given up for taking longer than AUTO_LOAD_GIVE_UP_HOURS. */
	gaveUp: number;
	queued: { sourceId: string; regionCode: string; loadId: string } | null;
	/** Why due regions were passed over, e.g. "artportalen/SE-AB: busy". */
	skipped: string[];
	alerts: { sent: number; dropped: number; retrying: number; gaveUp: number; waiting: number };
}

export async function runRefreshPass(opts: RefreshPassOptions): Promise<RefreshPassResult> {
	const scope = opts.sourceIds ? [...opts.sourceIds] : null;
	const expired = await withClaimTx(
		async (c) => {
			if (!scope) return expireLeases(c, null);
			let n = 0;
			for (const id of scope) n += await expireLeases(c, id);
			return n;
		},
		{ where: 'external refresh expiry' }
	);
	const gaveUp = await withClaimTx((c) => giveUpStuckAutoLoads(c, scope), { where: 'external refresh give-up' });
	const admins = opts.admins ? [...opts.admins] : null;
	const { queued, skipped } = await queueOneDue(scope, admins);
	const alerts = await deliverAlerts(scope, opts);
	return { expired, gaveUp, queued, skipped, alerts };
}

export const AUTO_LOAD_GAVE_UP = 'This automatic refresh did not finish in time (its connector may be offline), so it was given up.';
/** A queued automatic load of a source that was switched off: dropped quietly, no alert (AGY4). */
export const AUTO_LOAD_SOURCE_OFF = 'The source was switched off, so this automatic refresh was dropped.';

/**
 * An automatic load that is still waiting in the queue after
 * AUTO_LOAD_GIVE_UP_HOURS — its connector never claimed it, or kept losing
 * it — ends here, so it can't hold the one automatic slot and keep every other
 * source stale (CODEX1 td-9fe839 #1). A load a connector is working on right
 * now (a live lease) is left alone. Locked like a close: the load row first.
 */
async function giveUpStuckAutoLoads(c: Db, scope: string[] | null): Promise<number> {
	// Also, at once, a queued automatic load of a source switched off since:
	// no connector can claim it, so it would only hold the slot (AGY4).
	const stuck = await c.query<{ id: string; active: boolean }>(
		`SELECT l.id, s.active FROM external_loads l JOIN external_sources s ON s.id = l.source_id
		  WHERE l.origin = 'auto' AND l.status = 'queued'
		    AND (l.created_at < now() - make_interval(hours => $2) OR NOT s.active)
		    AND ($1::text[] IS NULL OR l.source_id = ANY($1::text[]))
		  FOR UPDATE OF l SKIP LOCKED`,
		[scope, AUTO_LOAD_GIVE_UP_HOURS]
	);
	if (stuck.rows.length === 0) return 0;
	const off = new Set(stuck.rows.filter((x) => !x.active).map((x) => x.id));
	const r = await c.query<{ id: string; source_id: string; region_code: string }>(
		`UPDATE external_loads
		    SET status = 'failed', error = CASE WHEN id = ANY($2::uuid[]) THEN $4 ELSE $3 END,
		        finished_at = now(), updated_at = now()
		  WHERE id = ANY($1::uuid[]) AND status = 'queued'
		 RETURNING id, source_id, region_code`,
		[stuck.rows.map((x) => x.id), [...off], AUTO_LOAD_GAVE_UP, AUTO_LOAD_SOURCE_OFF]
	);
	for (const x of r.rows) {
		// A deliberate switch-off is not a failure to tell anyone about.
		if (off.has(x.id)) continue;
		await insertAlert(c, { kind: 'refresh_failed', sourceId: x.source_id, regionCode: x.region_code, loadId: x.id, error: AUTO_LOAD_GAVE_UP });
	}
	return r.rows.length;
}

// ── Automatic reload ───────────────────────────────────────────────────────

/**
 * Due regions, oldest data first. `region` narrows to one (the re-check
 * inside the admitting transaction).
 */
function dueSql(narrow: boolean): string {
	return `SELECT s.id AS source_id, m.region_code, d.id AS done_id
	   FROM external_sources s
	   JOIN external_region_map m ON m.source_id = s.id AND m.queueable
	   JOIN external_loads d ON d.source_id = s.id AND d.region_code = m.region_code AND d.status = 'done'
	  WHERE s.active AND s.refresh_days IS NOT NULL
	    AND ($1::text[] IS NULL OR s.id = ANY($1::text[]))
	    -- A connector that is polling (every 10 s) can take the load at once.
	    AND EXISTS (SELECT 1 FROM external_connectors k
	                 WHERE k.source_id = s.id AND k.revoked_at IS NULL
	                   AND k.last_seen_at > now() - make_interval(mins => ${CONNECTOR_ALIVE_MINUTES}))
	    AND d.retrieved_at < now() - make_interval(days => s.refresh_days)
	    AND NOT EXISTS (SELECT 1 FROM external_loads a
	                     WHERE a.source_id = s.id AND a.region_code = m.region_code AND a.origin = 'auto'
	                       AND a.created_at > now() - make_interval(days => s.refresh_days))
	    AND NOT EXISTS (SELECT 1 FROM external_loads q
	                     WHERE q.source_id = s.id AND q.region_code = m.region_code
	                       AND q.status IN ('queued', 'leased', 'staging'))
	    ${narrow ? 'AND s.id = $2 AND m.region_code = $3 AND d.id = $4' : ''}
	  ORDER BY d.retrieved_at, s.id, m.region_code`;
}

/** An automatic load holding the one slot: queued or running, for a source still switched on. */
const AUTO_ACTIVE_SQL = `SELECT 1 FROM external_loads l JOIN external_sources s ON s.id = l.source_id AND s.active
  WHERE l.origin = 'auto' AND l.status IN ('queued', 'leased', 'staging')
    AND ($1::text[] IS NULL OR l.source_id = ANY($1::text[]))
  LIMIT 1`;

async function queueOneDue(scope: string[] | null, admins: number[] | null): Promise<Pick<RefreshPassResult, 'queued' | 'skipped'>> {
	const skipped: string[] = [];
	// One automatic load at a time across every source: Norway and Sweden have
	// connectors of their own, so a per-connector limit would let both run.
	if ((await query(AUTO_ACTIVE_SQL, [scope])).rowCount) {
		return { queued: null, skipped: ['an automatic load is already queued or running'] };
	}
	const due = await query<{ source_id: string; region_code: string; done_id: string }>(dueSql(false), [scope]);
	for (const d of due.rows) {
		const where = `${d.source_id}/${d.region_code}`;
		const outcome = await withClaimTx(
			async (c): Promise<{ loadId: string } | string> => {
				// Lock order as finishLoad: the source row, then the source's
				// derived-data lock (try only: a finish holding it is publishing
				// this source right now, so look again next hour), then the
				// region map row inside queueExternalLoadTx.
				await c.query(`SELECT 1 FROM external_sources WHERE id = $1 FOR SHARE`, [d.source_id]);
				const lock = await c.query<{ ok: boolean }>(
					`SELECT pg_try_advisory_xact_lock(hashtext('external-source:' || $1)) AS ok`,
					[d.source_id]
				);
				if (!lock.rows[0]?.ok) return 'busy';
				const still = await c.query(dueSql(true), [scope, d.source_id, d.region_code, d.done_id]);
				if (!still.rowCount) return 'no longer due';
				if ((await c.query(AUTO_ACTIVE_SQL, [scope])).rowCount) return 'an automatic load is already queued or running';
				const admin = await c.query<{ id: number }>(
					`SELECT id FROM users WHERE role = 'admin' AND ($1::int[] IS NULL OR id = ANY($1::int[])) ORDER BY id LIMIT 1`,
					[admins]
				);
				if (!admin.rows[0]) return 'no admin account';
				try {
					const q = await queueExternalLoadTx(c, {
						sourceId: d.source_id,
						regionCode: d.region_code,
						requestedBy: admin.rows[0].id,
						origin: 'auto'
					});
					return q.created ? { loadId: q.loadId } : 'a load is already queued or running';
				} catch (err) { // stale-safe: maps only the queue's own refusals (closed, off, unmapped); rethrows the rest
					if (err instanceof IngestError) return err.code;
					throw err;
				}
			},
			{ where: 'external refresh queue' }
		);
		if (typeof outcome !== 'string') {
			return { queued: { sourceId: d.source_id, regionCode: d.region_code, loadId: outcome.loadId }, skipped };
		}
		skipped.push(`${where}: ${outcome}`);
	}
	return { queued: null, skipped };
}

// ── Owner alerts ───────────────────────────────────────────────────────────

/** Events handled per pass; the rest wait an hour. */
const ALERTS_PER_PASS = 20;

interface AlertRow {
	id: string;
	source_id: string;
	region_code: string;
	kind: 'new_unmatched' | 'refresh_failed';
	taxa: AlertTaxon[] | null;
	attempts: number;
	created_at: Date;
	country_name: string | null;
	region_name: string | null;
}

async function deliverAlerts(
	scope: string[] | null,
	opts: RefreshPassOptions
): Promise<RefreshPassResult['alerts']> {
	const out = { sent: 0, dropped: 0, retrying: 0, gaveUp: 0, waiting: 0 };
	const send = opts.send ?? sendWebPush;
	const pending = await query<AlertRow>(
		`SELECT a.id, a.source_id, a.region_code, a.kind, a.taxa, a.attempts, a.created_at,
		        c.name AS country_name, r.name AS region_name
		   FROM external_alerts a
		   JOIN external_sources s ON s.id = a.source_id
		   LEFT JOIN regions c ON c.code = s.covers_country
		   LEFT JOIN regions r ON r.code = a.region_code
		  WHERE a.status = 'pending' AND a.next_attempt_at <= now()
		    AND ($1::text[] IS NULL OR a.source_id = ANY($1::text[]))
		  ORDER BY a.id LIMIT ${ALERTS_PER_PASS}`,
		[scope]
	);
	const admins = opts.admins ? [...opts.admins] : null;
	if (!(await adminHasDevice(admins))) {
		// Nowhere to send. Alerts with something to say stay pending without
		// spending attempts or writing every hour; ones with nothing left to
		// say end now, all of them, so they can't hold the batch (CODEX1 round 6).
		const dropped = await claimFencedQuery<{ id: string }>(
			`UPDATE external_alerts a SET status = 'dropped', finished_at = now()
			  WHERE a.status = 'pending' AND ($1::text[] IS NULL OR a.source_id = ANY($1::text[]))
			    AND NOT (${STILL_SAYS})
			 RETURNING a.id`,
			[scope],
			'external alerts dropped'
		);
		out.dropped += dropped.rowCount ?? 0;
		const waiting = await query<{ n: string }>(
			`SELECT COUNT(*) AS n FROM external_alerts a
			  WHERE a.status = 'pending' AND a.next_attempt_at <= now() AND ($1::text[] IS NULL OR a.source_id = ANY($1::text[]))`,
			[scope]
		);
		out.waiting += Number(waiting.rows[0].n);
		return out;
	}
	if (pending.rows.length === 0) return out;

	for (const a of pending.rows) {
		await assertClaimHeld('external alert');
		// Still worth saying? Taxa matched since, or a failure a newer load
		// replaced. (Rebuilt again before each device until one takes it.)
		let msg = await messageFor(a, opts.origin);
		if (!msg) {
			await finish(a.id, 'dropped');
			out.dropped++;
			continue;
		}

		// Every device of every CURRENT admin, read fresh per event.
		const subs = await query<PushSubscriptionRow & { user_id: number }>(
			`SELECT p.endpoint, p.p256dh, p.auth, p.user_id FROM push_subscriptions p
			   JOIN users u ON u.id = p.user_id
			  WHERE u.role = 'admin' AND ($1::int[] IS NULL OR u.id = ANY($1::int[]))
			  ORDER BY p.user_id, p.endpoint`,
			[opts.admins ? [...opts.admins] : null]
		);
		// No devices left (the last one removed since the check above): the empty
		// loop below falls through to the locked "nothing delivered" check, which
		// keeps it pending without spending an attempt, or drops it if resolved.
		let delivered = 0;
		let lastErr: string | null = null;
		const gone: (PushSubscriptionRow & { user_id: number })[] = [];
		let droppedMidway = false;
		try {
			for (const sub of subs.rows) {
				// Every send is its own outbound effect: a reclaimed run sends no more (CODEX1 #2).
				await assertClaimHeld('external alert send');
				// Until a device has taken it, the alert is still open to edits
				// (the owner matching its taxa meanwhile): say what is true right
				// before each attempt, or nothing (CODEX1 rounds 4–5). A moment
				// between this read and the send remains; it can't be closed.
				if (delivered === 0) {
					const now = await messageFor(a, opts.origin);
					if (!now) {
						droppedMidway = true;
						break;
					}
					msg = now;
				}
				// The device must still be this admin's, with the same keys: one moved
				// to another account or re-keyed meanwhile is skipped (CODEX1 round 6).
				const still = await query(
					`SELECT 1 FROM push_subscriptions p JOIN users u ON u.id = p.user_id
					  WHERE p.endpoint = $1 AND p.user_id = $2 AND p.p256dh = $3 AND p.auth = $4 AND u.role = 'admin'`,
					[sub.endpoint, sub.user_id, sub.p256dh, sub.auth]
				);
				if (!still.rowCount) continue;
				try {
					await send(sub, msg);
				} catch (err) { // stale-safe: classifies only push-service errors; rethrows everything else
					if (err instanceof PushError && err.gone) gone.push(sub);
					else if (err instanceof PushError) lastErr = err.message;
					else throw err;
					continue;
				}
				// The first device that takes it settles the alert at once, before
				// the next device is contacted: a worker that takes over meanwhile
				// then finds nothing pending and can't send it again (CODEX1 re-review).
				// Not claim-fenced on purpose — the device already showed it.
				if (delivered++ === 0) await markSent(a.id);
			}
		} finally {
			// Exactly the rows we saw fail, so a device re-enrolled since (new
			// keys, or moved to another account) is kept (CODEX1 #7) — pruned on
			// every exit, a later error or a lost claim included.
			if (gone.length > 0) await pruneGone(gone);
		}
		if (droppedMidway) {
			await finish(a.id, 'dropped');
			out.dropped++;
		} else if (delivered > 0) {
			out.sent++;
		} else if (lastErr === null) {
			// Every device was gone or skipped: like having none — it waits
			// without spending an attempt, unless it was resolved meanwhile
			// (checked under the source lock, as below; CODEX1 round 7).
			const r = await withClaimTx(
				async (c) => {
					await c.query(`SELECT pg_advisory_xact_lock(hashtext('external-source:' || $1))`, [a.source_id]);
					return c.query(
						`UPDATE external_alerts a SET status = 'dropped', finished_at = now()
						  WHERE a.id = $1 AND a.status = 'pending' AND NOT (${STILL_SAYS})`,
						[a.id]
					);
				},
				{ where: 'external alert undeliverable' }
			);
			if (r.rowCount) out.dropped++;
			else out.waiting++;
		} else {
			// No device took it. Decided in one statement under the source's
			// derived-data lock, so a match or publish committing meanwhile is
			// seen: resolved → dropped; else a retry, or gave_up after the last
			// try (CODEX1 rounds 5–6).
			const gaveUp = a.attempts + 1 >= ALERT_MAX_ATTEMPTS;
			const r = await withClaimTx(
				async (c) => {
					await c.query(`SELECT pg_advisory_xact_lock(hashtext('external-source:' || $1))`, [a.source_id]);
					return c.query<{ status: string }>(
						`UPDATE external_alerts a
						    SET status = CASE WHEN NOT (${STILL_SAYS}) THEN 'dropped' WHEN $4 THEN 'gave_up' ELSE 'pending' END,
						        finished_at = CASE WHEN NOT (${STILL_SAYS}) OR $4 THEN now() END,
						        attempts = attempts + 1, last_error = $2,
						        next_attempt_at = now() + make_interval(secs => $3)
						  WHERE a.id = $1 AND a.status = 'pending'
						 RETURNING a.status`,
						[a.id, lastErr.slice(0, 500), alertRetryDelayMs(a.attempts + 1) / 1000, gaveUp]
					);
				},
				{ where: 'external alert not delivered' }
			);
			const status = r.rows[0]?.status;
			if (status === 'dropped') out.dropped++;
			else if (status === 'gave_up') out.gaveUp++;
			else if (status === 'pending') out.retrying++;
		}
	}
	return out;
}

/**
 * SQL over an external_alerts row `a`: true while the alert still has
 * something to say — a taxon waiting for a match somewhere in its source that
 * no newer alert names, or a failed refresh no newer load has replaced. The
 * set-based twin of messageFor.
 */
const STILL_SAYS = `(
	(a.kind = 'new_unmatched' AND EXISTS (
	   SELECT 1 FROM jsonb_array_elements(a.taxa) e(t)
	    WHERE EXISTS (SELECT 1 FROM external_unmatched u WHERE u.source_id = a.source_id AND u.upstream_taxon_id = e.t->>'id')
	      AND NOT EXISTS (SELECT 1 FROM external_alerts n, jsonb_array_elements(n.taxa) x
	                       WHERE n.source_id = a.source_id AND n.kind = 'new_unmatched' AND n.id > a.id
	                         AND x->>'id' = e.t->>'id')))
	OR (a.kind = 'refresh_failed' AND NOT EXISTS (
	   SELECT 1 FROM external_loads d
	    WHERE d.source_id = a.source_id AND d.region_code = a.region_code AND d.status = 'done' AND d.finished_at > a.created_at))
)`;

async function adminHasDevice(admins: number[] | null): Promise<boolean> {
	const r = await query(
		`SELECT 1 FROM push_subscriptions p JOIN users u ON u.id = p.user_id
		  WHERE u.role = 'admin' AND ($1::int[] IS NULL OR u.id = ANY($1::int[])) LIMIT 1`,
		[admins]
	);
	return (r.rowCount ?? 0) > 0;
}

/**
 * The push for a pending alert as it stands now, or null when there's
 * nothing left to say: its taxa all matched (or now named by a newer alert),
 * or its failed refresh replaced by a newer load.
 */
async function messageFor(a: AlertRow, origin: string): Promise<PushMessage | null> {
	let taxa: AlertTaxon[] | undefined;
	if (a.kind === 'new_unmatched') {
		// The alert's taxa as they are NOW (a rebuild may have edited them
		// since the batch was read — CODEX1 round 3), keeping each that still
		// waits for a match somewhere in the source and that no newer alert
		// names: one that left the list and came back is a new episode with
		// its own, newer alert (CODEX1 #3).
		const current = await query<{ taxon: AlertTaxon }>(
			`SELECT e.t AS taxon
			   FROM external_alerts a, jsonb_array_elements(a.taxa) WITH ORDINALITY AS e(t, o)
			  WHERE a.id = $1 AND a.status = 'pending'
			    AND EXISTS (SELECT 1 FROM external_unmatched u
			                 WHERE u.source_id = a.source_id AND u.upstream_taxon_id = e.t->>'id')
			    AND NOT EXISTS (SELECT 1 FROM external_alerts n, jsonb_array_elements(n.taxa) x
			                     WHERE n.source_id = a.source_id AND n.kind = 'new_unmatched' AND n.id > a.id
			                       AND x->>'id' = e.t->>'id')
			  ORDER BY e.o`,
			[a.id]
		);
		taxa = current.rows.map((x) => x.taxon);
		if (taxa.length === 0) return null;
	} else {
		// Compared in SQL against the stored row: a JavaScript Date would round
		// created_at to the millisecond (CODEX1 round 7).
		const still = await query(`SELECT 1 FROM external_alerts a WHERE a.id = $1 AND a.status = 'pending' AND ${STILL_SAYS}`, [
			a.id
		]);
		if (!still.rowCount) return null;
	}
	const text = alertPush({
		kind: a.kind,
		countryName: a.country_name ?? a.source_id,
		regionName: a.region_name ?? a.region_code,
		taxa
	});
	return {
		...text,
		url: `${origin}${alertPath(a.kind, a.source_id)}`,
		// One per region and kind: Stockholm never replaces Jönköping.
		tag: `ext-${a.source_id}-${a.region_code}-${a.kind}`
	};
}

async function pruneGone(gone: readonly (PushSubscriptionRow & { user_id: number })[]): Promise<void> {
	await query(
		`DELETE FROM push_subscriptions p
		  USING unnest($1::text[], $2::int[], $3::text[], $4::text[]) AS g(endpoint, user_id, p256dh, auth)
		  WHERE p.endpoint = g.endpoint AND p.user_id = g.user_id AND p.p256dh = g.p256dh AND p.auth = g.auth`,
		[gone.map((g) => g.endpoint), gone.map((g) => g.user_id), gone.map((g) => g.p256dh), gone.map((g) => g.auth)]
	);
}

/** Not claim-fenced on purpose: it records a push a device already accepted. */
async function markSent(id: string): Promise<void> {
	await query(
		`UPDATE external_alerts SET status = 'sent', finished_at = now(), attempts = attempts + 1, last_error = NULL
		  WHERE id = $1 AND status = 'pending'`,
		[id]
	);
}

async function finish(id: string, status: 'dropped'): Promise<void> {
	await claimFencedQuery(
		`UPDATE external_alerts SET status = $2, finished_at = now() WHERE id = $1 AND status = 'pending'`,
		[id, status],
		'external alert dropped'
	);
}

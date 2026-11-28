/**
 * External sources: automatic refresh and owner alerts (td-9fe839, plan
 * docs/2026-11-27-external-refresh-plan-CC.md) and connector watch (td-afba28,
 * docs/2026-11-27-connector-health-plan-CC.md). One pass of the worker's
 * `refresh_external_sources` job, every REFRESH_TICK_MS (5 min):
 *
 *   0. watch the connectors: open an outage for a source whose connectors
 *      have been silent past CONNECTOR_ALERT_AFTER_MS (with an offline
 *      alert), close one quietly when the source is switched off or loses its
 *      usable tokens, and add the back-online alert for an outage that closed
 *      after its offline alert went out (a check-in closes it: auth.ts);
 *   1. expire overdue leases, so a dead connector's automatic load never
 *      blocks the queue until the daily sweep, and give up an automatic load
 *      still not done after AUTO_LOAD_GIVE_UP_HOURS (its connector is offline
 *      or keeps dying), with a failed-refresh alert;
 *   2. queue at most ONE automatic reload in the whole app, and start at most
 *      one per AUTO_ADMIT_EVERY_MS (hourly, as before the faster tick) — the loaded,
 *      open region whose published data is oldest past its source's refresh
 *      interval, with no automatic attempt inside that interval (the
 *      cooldown: a failed one waits for the next interval), and only for a
 *      source whose connector has been heard from in the last few minutes;
 *   3. push the pending owner alerts (new unmatched taxa, a failed automatic
 *      refresh, a connector offline / back online) to every current admin's
 *      devices.
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
	AUTO_ADMIT_EVERY_MS,
	AUTO_LOAD_GIVE_UP_HOURS,
	CONNECTOR_ALIVE_MINUTES,
	alertPath,
	alertPush,
	alertRetryDelayMs
} from '$lib/external-refresh-policy';
import {
	CONNECTOR_ALERT_AFTER_MS,
	CONNECTOR_ALERT_PATH,
	CONNECTOR_OFFLINE_MS,
	CONNECTOR_ONLINE_RECONCILE_MS,
	connectorAlertTag,
	connectorPush
} from '$lib/connector-health-policy';
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
	/** Tests: runs inside the connector-watch transaction once an outage is opened, before it commits; gets that backend's pid. */
	afterOutageOpened?: (sourceId: string, backendPid: number) => Promise<void>;
}

export interface RefreshPassResult {
	/** Connector outages opened / closed quietly, and back-online events added, this pass. */
	connectors: { opened: number; closed: number; backOnline: number };
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
	const connectors = await watchConnectors(scope, opts.afterOutageOpened);
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
	return { connectors, expired, gaveUp, queued, skipped, alerts };
}

// ── Connector watch (td-afba28) ────────────────────────────────────────────

/**
 * A source's connector state, read inside the deciding transaction. Its
 * "last check-in" is the newest among its non-revoked tokens; a source is
 * eligible to be watched while it is switched on and one of those tokens has
 * checked in.
 */
interface WatchRow {
	active: boolean;
	seen: boolean;
	silent: boolean;
	open_id: string | null;
	/** A check-in newer than the open outage's last one. */
	seen_since: boolean;
}

/**
 * Step 0 of a pass, one transaction per source (plan §3):
 *
 * - The source's non-revoked token rows are locked first. A check-in's
 *   last_seen_at UPDATE (auth.ts) on one of them then waits for this
 *   decision: either it committed before, and is seen here, or it runs after,
 *   and its own close statement sees the outage opened here and closes it.
 *   Either way an outage that is over is never left open.
 * - Candidates are the switched-on sources AND every source with an open
 *   outage, so one switched off meanwhile still gets its outage closed.
 * - The source row is held FOR NO KEY UPDATE to commit, so a switch or a
 *   check-in waits for the decision (a switch's trigger then ends any outage
 *   opened here; a check-in's close sees it).
 * - No lock is waited for — the source row, the token rows or the source's
 *   derived-data lock (a finish holding one is publishing right now, and so
 *   the connector is alive; a switch is in progress): the next pass looks
 *   again.
 */
async function watchConnectors(
	scope: string[] | null,
	afterOpened?: (sourceId: string, backendPid: number) => Promise<void>
): Promise<RefreshPassResult['connectors']> {
	const out = { opened: 0, closed: 0, backOnline: 0 };
	const candidates = await query<{ id: string }>(
		`SELECT s.id FROM external_sources s
		  WHERE (s.active OR EXISTS (SELECT 1 FROM external_connector_outages o WHERE o.source_id = s.id AND o.closed_at IS NULL))
		    AND ($1::text[] IS NULL OR s.id = ANY($1::text[]))
		  ORDER BY s.id`,
		[scope]
	);
	for (const { id } of candidates.rows) {
		const step = await withClaimTx(
			async (c): Promise<'opened' | 'closed' | null> => {
				// The source row first, held to commit, FOR NO KEY UPDATE: a switch
				// off or on waits for this decision, so its trigger sees (and ends) an
				// outage opened here (CODEX1 round 2); and it conflicts with every
				// check-in's FOR SHARE — a token issued after the token scan below
				// included — so no check-in can be half-written while an outage is
				// decided (CODEX1 round 7). Busy (a switch or a check-in in progress,
				// or a load step holding it): look again next pass.
				const src = await c.query(`SELECT 1 FROM external_sources WHERE id = $1 FOR NO KEY UPDATE SKIP LOCKED`, [id]);
				if (!src.rowCount) return null;
				// Never waits on any lock: a load finish holds its token row
				// (FOR SHARE) and then waits for the source's derived-data lock, so
				// waiting here for the token rows while holding that lock — or for
				// it while holding them — could deadlock with it.
				const tokens = await c.query<{ locked: string; total: string }>(
					`SELECT (SELECT count(*) FROM (SELECT 1 FROM external_connectors
					                                WHERE source_id = $1 AND revoked_at IS NULL
					                                  FOR UPDATE SKIP LOCKED) x) AS locked,
					        (SELECT count(*) FROM external_connectors WHERE source_id = $1 AND revoked_at IS NULL) AS total`,
					[id]
				);
				if (tokens.rows[0].locked !== tokens.rows[0].total) return null;
				const lock = await c.query<{ ok: boolean }>(
					`SELECT pg_try_advisory_xact_lock(hashtext('external-source:' || $1)) AS ok`,
					[id]
				);
				if (!lock.rows[0]?.ok) return null;
				const r = await c.query<WatchRow>(
					`SELECT s.active, k.last_seen IS NOT NULL AS seen,
					        -- Silent past the alert threshold, counted from the later of the last
					        -- check-in and the last switch-on (an old check-in can't raise an
					        -- outage the moment a source is switched back on).
					        coalesce(greatest(k.last_seen, s.active_changed_at) < now() - make_interval(secs => $2), false) AS silent,
					        o.id AS open_id,
					        -- Compared here, never in JavaScript: a Date drops the microseconds.
					        coalesce(k.last_seen > o.last_seen_at, false) AS seen_since
					   FROM external_sources s
					   CROSS JOIN LATERAL (SELECT max(last_seen_at) AS last_seen FROM external_connectors
					                        WHERE source_id = s.id AND revoked_at IS NULL) k
					   LEFT JOIN external_connector_outages o ON o.source_id = s.id AND o.closed_at IS NULL
					  WHERE s.id = $1`,
					[id, CONNECTOR_ALERT_AFTER_MS / 1000]
				);
				const w = r.rows[0];
				if (!w) return null;
				const eligible = w.active && w.seen;
				if (w.open_id) {
					if (!eligible) {
						// Switched off, or every usable token revoked (revoke-and-replace
						// with the new one not seen yet): nothing to tell; its pending
						// offline alert drops at delivery.
						await c.query(
							`UPDATE external_connector_outages SET closed_at = clock_timestamp(), closed_reason = $2 WHERE id = $1 AND closed_at IS NULL`,
							[w.open_id, w.active ? 'no_token' : 'source_off']
						);
						return 'closed';
					}
					if (w.seen_since) {
						// A check-in the auth close didn't cover (an app version without
						// it served the call during a deploy): back now.
						await c.query(
							`UPDATE external_connector_outages SET closed_at = clock_timestamp(), closed_reason = 'back_online' WHERE id = $1 AND closed_at IS NULL`,
							[w.open_id]
						);
					}
					return null;
				}
				if (!eligible || !w.silent) return null;
				// Decided again in the INSERT itself, so the silence test and the
				// check-in it records come from one snapshot, microseconds and all
				// (CODEX1 code review #2). No check-in can be written meanwhile: each
				// needs the source row FOR SHARE, which this transaction holds
				// against it — a token issued after the token scan above included.
				// Such a check-in waits for this commit, then closes the outage at
				// its own moment (auth.ts recordCheckIn; CODEX1 rounds 7–8).
				const o = await c.query<{ id: string }>(
					`INSERT INTO external_connector_outages (source_id, last_seen_at, detected_at)
					 SELECT s.id, k.last_seen, clock_timestamp() FROM external_sources s
					  CROSS JOIN LATERAL (SELECT max(last_seen_at) AS last_seen FROM external_connectors
					                       WHERE source_id = s.id AND revoked_at IS NULL) k
					  WHERE s.id = $1 AND s.active AND k.last_seen IS NOT NULL
					    AND greatest(k.last_seen, s.active_changed_at) < now() - make_interval(secs => $2)
					    AND NOT EXISTS (SELECT 1 FROM external_connector_outages x WHERE x.source_id = s.id AND x.closed_at IS NULL)
					 RETURNING id`,
					[id, CONNECTOR_ALERT_AFTER_MS / 1000]
				);
				if (!o.rows[0]) return null;
				await c.query(
					`INSERT INTO external_alerts (source_id, kind, outage_id, created_at) VALUES ($1, 'connector_offline', $2, clock_timestamp())
					 ON CONFLICT (outage_id, kind) DO NOTHING`,
					[id, o.rows[0].id]
				);
				if (afterOpened) await afterOpened(id, (await c.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0].pid);
				return 'opened';
			},
			{ where: 'external connector watch' }
		);
		if (step === 'opened') out.opened++;
		else if (step === 'closed') out.closed++;
	}
	// Back online: an outage closed by a check-in whose offline alert went out
	// gets its one back-online event, whichever of the two committed first
	// (CODEX1 [C-3]); the unique (outage_id, kind) makes it once.
	const back = await claimFencedQuery<{ id: string }>(
		`INSERT INTO external_alerts (source_id, kind, outage_id, created_at)
		 SELECT o.source_id, 'connector_online', o.id, clock_timestamp() FROM external_connector_outages o
		  WHERE o.closed_reason = 'back_online' AND o.closed_at > now() - make_interval(secs => $2)
		    AND ($1::text[] IS NULL OR o.source_id = ANY($1::text[]))
		    AND EXISTS (SELECT 1 FROM external_alerts f
		                 WHERE f.outage_id = o.id AND f.kind = 'connector_offline' AND f.status = 'sent')
		 ON CONFLICT (outage_id, kind) DO NOTHING
		 RETURNING id`,
		[scope, CONNECTOR_ONLINE_RECONCILE_MS / 1000],
		'external connector back online'
	);
	out.backOnline = back.rowCount ?? 0;
	return out;
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

/**
 * An automatic load started within AUTO_ADMIT_EVERY_MS: the next waits, so the
 * 5-minute pass starts no more than the hourly one did (CODEX1 [C-4]).
 */
const AUTO_RECENT_SQL = `SELECT 1 FROM external_loads l
  WHERE l.origin = 'auto' AND l.created_at > now() - make_interval(secs => ${AUTO_ADMIT_EVERY_MS / 1000})
    AND ($1::text[] IS NULL OR l.source_id = ANY($1::text[]))
  LIMIT 1`;

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
	if ((await query(AUTO_RECENT_SQL, [scope])).rowCount) {
		return { queued: null, skipped: ['an automatic load was started within the hour'] };
	}
	const due = await query<{ source_id: string; region_code: string; done_id: string }>(dueSql(false), [scope]);
	for (const d of due.rows) {
		const where = `${d.source_id}/${d.region_code}`;
		const outcome = await withClaimTx(
			async (c): Promise<{ loadId: string } | string> => {
				// Lock order as finishLoad: the source row, then the source's
				// derived-data lock (try only: a finish holding it is publishing
				// this source right now, so look again next pass), then the
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
				if ((await c.query(AUTO_RECENT_SQL, [scope])).rowCount) return 'an automatic load was started within the hour';
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

/** Events handled per pass; the rest wait for the next. */
const ALERTS_PER_PASS = 20;

type AlertKind = 'new_unmatched' | 'refresh_failed' | 'connector_offline' | 'connector_online';

interface AlertRow {
	id: string;
	source_id: string;
	/** Null for a connector alert. */
	region_code: string | null;
	kind: AlertKind;
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
			`UPDATE external_alerts a SET status = 'dropped', finished_at = clock_timestamp()
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
				} else if (a.kind === 'connector_offline' || a.kind === 'connector_online') {
					// A device took it already; a connector that came back (or went
					// quiet again) meanwhile isn't announced to the rest (CODEX1 code
					// review #4). The alert stays sent.
					const now = await connectorMessageFor(a, opts.origin, true);
					if (!now) break;
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
						`UPDATE external_alerts a SET status = 'dropped', finished_at = clock_timestamp()
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
						        finished_at = CASE WHEN NOT (${STILL_SAYS}) OR $4 THEN clock_timestamp() END,
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
 * no newer alert names, a failed refresh no newer load has replaced, a
 * connector still silent, or a connector still back. The set-based twin of
 * messageFor, which uses it for the connector kinds as written, so selection,
 * the no-device sweep, each device's rebuild and the locked disposition all
 * judge the same live facts (CODEX1 [C-2]).
 *
 * - connector_offline: its outage is open, the source is switched on with a
 *   usable token that has checked in, and no such token has checked in since
 *   the outage's last check-in (a check-in after detection makes it false at
 *   once, before auth's close commits).
 * - connector_online: its outage closed by a check-in after the offline alert
 *   went out, no newer outage, the source still switched on, and a usable
 *   token checked in within CONNECTOR_OFFLINE_MS (never "back" while it is
 *   quiet again).
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
	OR (a.kind = 'connector_offline' AND EXISTS (
	   SELECT 1 FROM external_connector_outages o JOIN external_sources s ON s.id = o.source_id
	    WHERE o.id = a.outage_id AND o.closed_at IS NULL AND s.active
	      -- Of the current activation (CODEX1 code review #1).
	      AND o.detected_at >= s.active_changed_at
	      AND EXISTS (SELECT 1 FROM external_connectors k
	                   WHERE k.source_id = o.source_id AND k.revoked_at IS NULL AND k.last_seen_at IS NOT NULL)
	      AND NOT EXISTS (SELECT 1 FROM external_connectors k
	                       WHERE k.source_id = o.source_id AND k.revoked_at IS NULL AND k.last_seen_at > o.last_seen_at)))
	OR (a.kind = 'connector_online' AND EXISTS (
	   SELECT 1 FROM external_connector_outages o JOIN external_sources s ON s.id = o.source_id
	    WHERE o.id = a.outage_id AND o.closed_reason = 'back_online' AND s.active
	      AND o.closed_at >= s.active_changed_at
	      AND EXISTS (SELECT 1 FROM external_alerts f
	                   WHERE f.outage_id = o.id AND f.kind = 'connector_offline' AND f.status = 'sent')
	      AND NOT EXISTS (SELECT 1 FROM external_connector_outages n WHERE n.source_id = o.source_id AND n.id > o.id)
	      AND EXISTS (SELECT 1 FROM external_connectors k
	                   WHERE k.source_id = o.source_id AND k.revoked_at IS NULL
	                     AND k.last_seen_at > now() - make_interval(secs => ${CONNECTOR_OFFLINE_MS / 1000}))))
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
	if (a.kind === 'connector_offline' || a.kind === 'connector_online') return connectorMessageFor(a, origin);
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
		regionName: a.region_name ?? a.region_code ?? '',
		taxa
	});
	return {
		...text,
		url: `${origin}${alertPath(a.kind, a.source_id)}`,
		// One per region and kind: Stockholm never replaces Jönköping.
		tag: `ext-${a.source_id}-${a.region_code}-${a.kind}`
	};
}

/**
 * A connector alert as it stands now, from live rows and the shared
 * predicate, or null. `settled`: a device already took it, so its status is
 * no longer pending — the connector facts are still checked before each
 * further device (CODEX1 code review #4).
 */
async function connectorMessageFor(a: AlertRow, origin: string, settled = false): Promise<PushMessage | null> {
	const r = await query<{ last_seen_at: Date; closed_at: Date | null; now: Date }>(
		`SELECT o.last_seen_at, o.closed_at, now() AS now
		   FROM external_alerts a JOIN external_connector_outages o ON o.id = a.outage_id
		  WHERE a.id = $1 AND ${settled ? "a.status = 'sent'" : "a.status = 'pending'"} AND ${STILL_SAYS}`,
		[a.id]
	);
	const o = r.rows[0];
	if (!o) return null;
	const countryName = a.country_name ?? a.source_id;
	const text =
		a.kind === 'connector_offline'
			? connectorPush({ kind: 'connector_offline', countryName, lastSeenAt: o.last_seen_at, now: o.now })
			: connectorPush({ kind: 'connector_online', countryName, lastSeenAt: o.last_seen_at, closedAt: o.closed_at! });
	return { ...text, url: `${origin}${CONNECTOR_ALERT_PATH}`, tag: connectorAlertTag(a.source_id) };
}

async function pruneGone(gone: readonly (PushSubscriptionRow & { user_id: number })[]): Promise<void> {
	await query(
		`DELETE FROM push_subscriptions p
		  USING unnest($1::text[], $2::int[], $3::text[], $4::text[]) AS g(endpoint, user_id, p256dh, auth)
		  WHERE p.endpoint = g.endpoint AND p.user_id = g.user_id AND p.p256dh = g.p256dh AND p.auth = g.auth`,
		[gone.map((g) => g.endpoint), gone.map((g) => g.user_id), gone.map((g) => g.p256dh), gone.map((g) => g.auth)]
	);
}

/**
 * Not claim-fenced on purpose: it records a push a device already accepted.
 * That fact wins over a drop or give-up a worker that took over wrote while
 * this send was in flight (CODEX1 code review #4): a back-online event then
 * still follows an offline push a device showed.
 */
async function markSent(id: string): Promise<void> {
	await query(
		`UPDATE external_alerts SET status = 'sent', finished_at = clock_timestamp(), attempts = attempts + 1, last_error = NULL
		  WHERE id = $1 AND status IN ('pending', 'dropped', 'gave_up')`,
		[id]
	);
}

async function finish(id: string, status: 'dropped'): Promise<void> {
	await claimFencedQuery(
		`UPDATE external_alerts SET status = $2, finished_at = clock_timestamp() WHERE id = $1 AND status = 'pending'`,
		[id, status],
		'external alert dropped'
	);
}

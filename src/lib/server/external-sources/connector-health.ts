/**
 * Server health's "Sightings connectors" card (td-afba28, plan
 * docs/2026-11-27-connector-health-plan-CC.md §6): one row per registered
 * source — its connectors' last check-in and what they last reported, what
 * they are doing, the last load, the refresh line and any open outage with the
 * state of its notification. Local database reads only.
 */
import { queryTimed } from '$lib/db';
import { connectorState, type ConnectorState } from '$lib/connector-health-policy';
import { sanitizeErrorText } from '$server/job-policy';

export type ConnectorRowState = ConnectorState | 'off' | 'no_token';

export interface ConnectorHealth {
	sourceId: string;
	name: string;
	countryName: string | null;
	active: boolean;
	state: ConnectorRowState;
	/** Newest check-in among the non-revoked tokens, with what that same token last reported. */
	lastSeenAt: string | null;
	version: string | null;
	startedAt: string | null;
	/**
	 * Loads a connector has taken (distinct regions can run at once). `expired`:
	 * its lease ran out without word from the connector; the next pass returns it
	 * to the queue or fails it (CODEX1 code review #5).
	 */
	loading: {
		regionName: string;
		status: 'leased' | 'staging';
		progress: { phase: string; done: number; total: number } | null;
		startedAt: string | null;
		expired: boolean;
	}[];
	queued: number;
	lastLoad: { regionName: string; status: 'done' | 'failed'; origin: 'manual' | 'auto'; finishedAt: string; error: string | null } | null;
	refreshDays: number | null;
	oldestLoaded: { regionName: string; retrievedAt: string } | null;
	/** An open outage and how its offline notification stands. */
	outage: {
		since: string;
		detectedAt: string;
		notice: 'sent' | 'pending' | 'gave_up' | 'dropped' | 'none';
	} | null;
}

export interface ConnectorsCard {
	rows: ConnectorHealth[];
	/** False when no admin has a device enrolled for notifications. */
	adminHasDevice: boolean;
}

interface Row {
	id: string;
	name: string;
	country_name: string | null;
	active: boolean;
	refresh_days: number | null;
	tokens: number;
	last_seen_at: Date | null;
	version: string | null;
	started_at: Date | null;
	active_loads: { region_name: string; status: 'leased' | 'staging'; progress: { phase: string; done: number; total: number } | null; started_at: string | null; expired: boolean }[];
	queued: number;
	last_status: 'done' | 'failed' | 'superseded' | null;
	last_origin: 'manual' | 'auto' | null;
	last_finished: Date | null;
	last_error: string | null;
	last_region: string | null;
	oldest_region: string | null;
	oldest_retrieved: Date | null;
	outage_since: Date | null;
	outage_detected: Date | null;
	outage_notice: 'pending' | 'sent' | 'dropped' | 'gave_up' | null;
	now: Date;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export async function connectorHealth(timeoutMs: number): Promise<ConnectorsCard> {
	const r = await queryTimed<Row>(
		`SELECT s.id, s.name, c.name AS country_name, s.active, s.refresh_days,
		        (SELECT count(*)::int FROM external_connectors k WHERE k.source_id = s.id AND k.revoked_at IS NULL) AS tokens,
		        t.last_seen_at, t.version, t.started_at,
		        coalesce(a.loads, '[]'::jsonb) AS active_loads,
		        (SELECT count(*)::int FROM external_loads q WHERE q.source_id = s.id AND q.status = 'queued') AS queued,
		        f.status AS last_status, f.origin AS last_origin, f.finished_at AS last_finished, f.error AS last_error,
		        f.region_name AS last_region,
		        d.region_name AS oldest_region, d.retrieved_at AS oldest_retrieved,
		        o.last_seen_at AS outage_since, o.detected_at AS outage_detected,
		        (SELECT x.status FROM external_alerts x WHERE x.outage_id = o.id AND x.kind = 'connector_offline') AS outage_notice,
		        now() AS now
		   FROM external_sources s
		   LEFT JOIN regions c ON c.code = s.covers_country
		   -- One token row for check-in, version and start alike (CODEX1 [C-6]).
		   LEFT JOIN LATERAL (SELECT k.last_seen_at, k.version, k.started_at FROM external_connectors k
		                       WHERE k.source_id = s.id AND k.revoked_at IS NULL
		                       ORDER BY k.last_seen_at DESC NULLS LAST, k.id DESC LIMIT 1) t ON true
		   LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object(
		                               'region_name', coalesce(rg.name, l.region_code), 'status', l.status, 'progress', l.progress,
		                               'started_at', l.started_at, 'expired', l.lease_expires_at <= now())
		                             ORDER BY l.started_at NULLS LAST, l.region_code) AS loads
		                        FROM external_loads l LEFT JOIN regions rg ON rg.code = l.region_code
		                       WHERE l.source_id = s.id AND l.status IN ('leased', 'staging')) a ON true
		   LEFT JOIN LATERAL (SELECT l.status, l.origin, l.finished_at, l.error, coalesce(rg.name, l.region_code) AS region_name
		                        FROM external_loads l LEFT JOIN regions rg ON rg.code = l.region_code
		                       WHERE l.source_id = s.id AND l.status IN ('done', 'failed', 'superseded') AND l.finished_at IS NOT NULL
		                       ORDER BY l.finished_at DESC LIMIT 1) f ON true
		   LEFT JOIN LATERAL (SELECT coalesce(rg.name, l.region_code) AS region_name, l.retrieved_at
		                        FROM external_loads l
		                        JOIN external_region_map m ON m.source_id = l.source_id AND m.region_code = l.region_code AND m.queueable
		                        LEFT JOIN regions rg ON rg.code = l.region_code
		                       WHERE l.source_id = s.id AND l.status = 'done'
		                       ORDER BY l.retrieved_at LIMIT 1) d ON true
		   LEFT JOIN external_connector_outages o ON o.source_id = s.id AND o.closed_at IS NULL
		  ORDER BY s.active DESC, s.name`,
		undefined,
		timeoutMs
	);
	const devices = await queryTimed(
		`SELECT 1 FROM push_subscriptions p JOIN users u ON u.id = p.user_id WHERE u.role = 'admin' LIMIT 1`,
		undefined,
		timeoutMs
	);
	return { rows: r.rows.map(toHealth), adminHasDevice: (devices.rowCount ?? 0) > 0 };
}

export function toHealth(x: Row): ConnectorHealth {
	const state: ConnectorRowState = !x.active ? 'off' : x.tokens === 0 ? 'no_token' : connectorState(x.last_seen_at, x.now);
	return {
		sourceId: x.id,
		name: x.name,
		countryName: x.country_name,
		active: x.active,
		state,
		lastSeenAt: iso(x.last_seen_at),
		version: x.version,
		startedAt: iso(x.started_at),
		loading: x.active_loads.map((l) => ({
			regionName: l.region_name,
			status: l.status,
			progress: l.progress,
			startedAt: l.started_at ? new Date(l.started_at).toISOString() : null,
			expired: l.expired
		})),
		queued: x.queued,
		lastLoad:
			x.last_status && x.last_finished && x.last_region
				? {
						regionName: x.last_region,
						status: x.last_status === 'failed' ? 'failed' : 'done',
						origin: x.last_origin ?? 'manual',
						finishedAt: x.last_finished.toISOString(),
						error: x.last_error ? sanitizeErrorText(x.last_error) : null
					}
				: null,
		refreshDays: x.refresh_days,
		oldestLoaded: x.oldest_region && x.oldest_retrieved ? { regionName: x.oldest_region, retrievedAt: x.oldest_retrieved.toISOString() } : null,
		outage:
			x.outage_since && x.outage_detected
				? { since: x.outage_since.toISOString(), detectedAt: x.outage_detected.toISOString(), notice: x.outage_notice ?? 'none' }
				: null
	};
}


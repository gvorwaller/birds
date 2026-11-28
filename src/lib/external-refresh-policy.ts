/**
 * External sources refresh and owner alerts (td-9fe839): the pure parts —
 * the refresh choices, the push wording and the retry schedule. The worker
 * side is $server/external-sources/refresh.ts.
 */
import { CONNECTOR_OFFLINE_MS } from './connector-health-policy';

/** Must match external_sources_refresh_days_check (migration 0104). */
export const REFRESH_DAYS_OPTIONS = [7, 14, 30] as const;
export type RefreshDays = (typeof REFRESH_DAYS_OPTIONS)[number];

export function isRefreshDays(n: unknown): n is RefreshDays {
	return typeof n === 'number' && (REFRESH_DAYS_OPTIONS as readonly number[]).includes(n);
}

export function refreshLabel(days: number | null): string {
	switch (days) {
		case null:
			return 'Off';
		case 7:
			return 'Weekly';
		case 14:
			return 'Every 2 weeks';
		case 30:
			return 'Monthly';
		default:
			return `Every ${days} days`;
	}
}

/**
 * How often the worker's refresh job runs: lease expiry, give-up, connector
 * outage checks and alert delivery every pass (td-afba28; it was hourly).
 */
export const REFRESH_TICK_MS = 5 * 60_000;

/** The job's label in Admin, matching REFRESH_TICK_MS. */
export const REFRESH_TICK_LABEL = 'every 5 min';

/**
 * At most one automatic load is started in this long, app-wide, so the
 * faster tick doesn't press the providers harder than the hourly pass did
 * (CODEX1 td-afba28 [C-4]). Five minutes short of an hour, so the pass that
 * lands near the hour still counts.
 */
export const AUTO_ADMIT_EVERY_MS = 55 * 60_000;

/** The base of the alert retry schedule (hourly), separate from the tick. */
export const ALERT_RETRY_BASE_MS = 60 * 60_000;

/**
 * An automatic load still queued this long after it was created is given up
 * with a failed-refresh alert, so an offline connector can't hold the one
 * automatic slot (a county load takes minutes).
 */
export const AUTO_LOAD_GIVE_UP_HOURS = 6;

/** A source gets an automatic load only if a connector was heard from this recently (they poll every 10 s). */
export const CONNECTOR_ALIVE_MINUTES = CONNECTOR_OFFLINE_MS / 60_000;

/** A push that reached no device is tried this many times in all. */
export const ALERT_MAX_ATTEMPTS = 5;

/**
 * Wait before the next try after `attempts` failed ones: the 1st, 2nd, 4th
 * and 8th hour after it. Five minutes short of whole hours, so a pass that
 * runs a little early still counts (AGY4); with 5-minute passes the retry
 * goes out within 5 minutes of that.
 */
export function alertRetryDelayMs(attempts: number): number {
	return ALERT_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1) - 5 * 60_000;
}

/** Names shown in a push body before "+N more". */
const BODY_NAMES = 3;

export function alertPush(a: {
	kind: 'new_unmatched' | 'refresh_failed';
	countryName: string;
	regionName: string;
	taxa?: readonly { name: string }[];
}): { title: string; body: string } {
	if (a.kind === 'refresh_failed') {
		return { title: `${a.countryName}: ${a.regionName} refresh failed`, body: 'Previous data kept.' };
	}
	const taxa = a.taxa ?? [];
	const n = taxa.length;
	const shown = taxa.slice(0, BODY_NAMES).map((t) => t.name);
	const more = n > BODY_NAMES ? ` +${n - BODY_NAMES} more` : '';
	return {
		title: `${a.countryName}: ${n} new ${n === 1 ? 'taxon' : 'taxa'} to match`,
		body: `${a.regionName}: ${shown.join(', ')}${more}`
	};
}

/** Where a tap on the alert lands: the Unmatched section, or the source card. */
export function alertPath(kind: 'new_unmatched' | 'refresh_failed', sourceId: string): string {
	const id = encodeURIComponent(sourceId);
	return kind === 'new_unmatched'
		? `/admin?tab=sources&unmatched=${id}#source-${sourceId}-unmatched`
		: `/admin?tab=sources#source-${sourceId}`;
}

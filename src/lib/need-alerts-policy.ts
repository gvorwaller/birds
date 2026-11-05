/**
 * Pure need-alert policy (plan A0/A3) — no DB, no network, unit-tested.
 *
 * A candidate = a notable observation of a species the user NEEDS (not on
 * their life list) that hasn't been alerted within the rolling re-alert
 * window. One candidate per species per scan (closest observation wins,
 * "and N more" for the rest); per-scan burst cap so a first enable against
 * a rich feed never fires a dozen pushes at once (GROK §2). ALL reports get
 * FULL location detail regardless of eBird's locationPrivate flag — Gaylon
 * ruling 2026-08-18 ("Of course I want ALL reports… this app of all places
 * should give me that advantage"); the earlier redaction was never his call.
 * eBird already shows him these locations; do not reintroduce redaction.
 */
import { haversineKm } from '$lib/geo';

/**
 * Per-account check interval (Gaylon 2026-11-05: configurable in Settings,
 * shorter and longer than the original fixed 30 min). Must match the CHECK
 * on user_alert_prefs.scan_interval_min (migration 0102).
 */
export const SCAN_INTERVAL_OPTIONS_MIN = [15, 30, 60, 120, 180, 360] as const;
export type ScanIntervalMin = (typeof SCAN_INTERVAL_OPTIONS_MIN)[number];
export const DEFAULT_SCAN_INTERVAL_MIN: ScanIntervalMin = 30;

/**
 * The one global scan job runs at the SHORTEST choice; each tick checks only
 * the accounts whose own interval has come round (isScanDue).
 */
export const SCAN_TICK_MS = SCAN_INTERVAL_OPTIONS_MIN[0] * 60_000;

/**
 * Cadence is approximate, not exact. An account is stamped when ITS check
 * finishes, while the next tick is scheduled from the end of the WHOLE scan
 * — so ticks land at varying offsets from an account's stamp. The slack lets
 * an account be checked up to 5 min early rather than a whole tick (15 min)
 * late: e.g. a 30-min account is due on any tick 25+ min after its last
 * check. Kept under one tick, so the early margin never reaches a full tick.
 */
export const SCAN_DUE_SLACK_MS = 5 * 60_000;

export const PER_SCAN_CAP = 5;

export function isScanIntervalMin(n: number): n is ScanIntervalMin {
	return (SCAN_INTERVAL_OPTIONS_MIN as readonly number[]).includes(n);
}

/** "15 min", "30 min", "1 hour", "6 hours". */
export function scanIntervalLabel(min: number): string {
	if (min < 60) return `${min} min`;
	const h = min / 60;
	return h === 1 ? '1 hour' : `${h} hours`;
}

/**
 * Whether an account is due a check on this tick. Never checked (or never
 * successfully checked) → due.
 */
export function isScanDue(lastScannedAt: Date | null, intervalMin: number, now: Date): boolean {
	if (lastScannedAt == null) return true;
	return now.getTime() - lastScannedAt.getTime() >= intervalMin * 60_000 - SCAN_DUE_SLACK_MS;
}

export interface AlertObs {
	speciesCode: string;
	comName: string;
	locId: string;
	locName: string;
	obsDt: string; // "YYYY-MM-DD HH:mm"
	howMany?: number;
	lat: number;
	lng: number;
	obsValid: boolean;
	obsReviewed: boolean;
	locationPrivate: boolean;
	subId?: string;
}

export interface AlertReport {
	subId: string | null;
	locName: string;
	obsDt: string;
	distanceMi: number;
}

export interface AlertCandidate {
	speciesCode: string;
	comName: string;
	title: string;
	body: string;
	/** Audit of the triggering observation (for need_alerts_sent). */
	obs: { locId: string; obsDt: string; subId: string | null };
	/** ALL triggering observations, closest-first, UNCAPPED — "and N more
	 * locations" in the body must equal what history can show (CODEX1:
	 * no silent truncation; the no-hidden-data-reduction rule). */
	reports: AlertReport[];
	distanceMi: number;
}

const KM_TO_MI = 0.621371;

function fmtWhen(obsDt: string, now: Date): string {
	// obsDt is eBird's "YYYY-MM-DD HH:mm" in the observation's LOCAL time
	// (no zone). Show it as given; only the day word is computed.
	const [datePart, timePart] = obsDt.split(' ');
	const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
	const day =
		datePart === todayStr
			? 'today'
			: new Date(`${datePart}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short' });
	return timePart ? `${day} ${timePart}` : day;
}

/**
 * Filter + rank + compose. `sentAt` maps speciesCode → last alert epoch ms.
 * Distances are FROM HOME (spelled out in the body — a birder mid-field must
 * not read them as from-me, GROK §2). Returns at most `cap` candidates,
 * nearest species first.
 */
export function alertCandidates(opts: {
	notable: readonly AlertObs[];
	seen: ReadonlySet<string>;
	sentAt: ReadonlyMap<string, number>;
	now: Date;
	realertDays: number;
	home: { lat: number; lng: number };
	cap?: number;
}): AlertCandidate[] {
	const { notable, seen, sentAt, now, realertDays, home } = opts;
	const cap = opts.cap ?? PER_SCAN_CAP;
	const windowMs = realertDays * 24 * 60 * 60 * 1000;

	const bySpecies = new Map<string, AlertObs[]>();
	for (const o of notable) {
		if (seen.has(o.speciesCode)) continue;
		const last = sentAt.get(o.speciesCode);
		if (last != null && now.getTime() - last < windowMs) continue;
		const list = bySpecies.get(o.speciesCode) ?? [];
		list.push(o);
		bySpecies.set(o.speciesCode, list);
	}

	const candidates: AlertCandidate[] = [];
	for (const [speciesCode, obsList] of bySpecies) {
		const ranked = [...obsList].sort(
			(a, b) =>
				haversineKm(home.lat, home.lng, a.lat, a.lng) -
				haversineKm(home.lat, home.lng, b.lat, b.lng)
		);
		const best = ranked[0];
		const others = ranked.length - 1;
		const unconfirmed = !best.obsValid || !best.obsReviewed;
		const title = `Lifer nearby: ${best.comName}${unconfirmed ? ' (unconfirmed)' : ''}`;
		const distanceMi = Math.round(haversineKm(home.lat, home.lng, best.lat, best.lng) * KM_TO_MI);
		const parts = [
			best.locName,
			`${distanceMi} mi from home`,
			fmtWhen(best.obsDt, now)
		];
		if (best.howMany != null && best.howMany > 1) parts.push(`${best.howMany} seen`);
		if (others > 0) parts.push(`and ${others} more location${others === 1 ? '' : 's'}`);
		const body = parts.join(' · ');
		candidates.push({
			speciesCode,
			comName: best.comName,
			title,
			body,
			obs: { locId: best.locId, obsDt: best.obsDt, subId: best.subId ?? null },
			reports: ranked.map((o) => ({
				subId: o.subId ?? null,
				locName: o.locName,
				obsDt: o.obsDt,
				distanceMi: Math.round(haversineKm(home.lat, home.lng, o.lat, o.lng) * KM_TO_MI)
			})),
			distanceMi
		});
	}

	candidates.sort((a, b) => a.distanceMi - b.distanceMi);
	return candidates.slice(0, cap);
}

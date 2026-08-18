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

export const SCAN_INTERVAL_MS = 30 * 60_000; // = OBS_TTL_MIN — faster is waste
export const PER_SCAN_CAP = 5;

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

/** Reports listed per alert (closest-first) — bounds the log row size. */
export const MAX_ALERT_REPORTS = 10;

export interface AlertCandidate {
	speciesCode: string;
	comName: string;
	title: string;
	body: string;
	/** Audit of the triggering observation (for need_alerts_sent). */
	obs: { locId: string; obsDt: string; subId: string | null };
	/** ALL triggering observations, closest-first, capped — the alert links
	 * to these (td-78a7b1). Full detail for every report per Gaylon's
	 * 2026-08-18 ruling. */
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
			reports: ranked.slice(0, MAX_ALERT_REPORTS).map((o) => ({
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

/**
 * LocID → coordinates for the life-list map (td-2fbfc1 Commit B).
 *
 * The life-list CSV has no coordinates. Most lifer loc_ids already exist in
 * ebird_locations (fed by observation feeds); this resolves the remainder:
 *
 * 1. Hotspot-info (API key, official) — public hotspots → ebird_locations.
 * 2. Owner checklist HTML (CAS session, unofficial) — personal L-ids →
 *    user-scoped lifer_loc_coords (never the communal ebird_locations).
 *
 * Fail-soft by contract: runs after a successful import, capped per
 * invocation, tolerates expected 404/empty-200 as data states, stops
 * (without recording anything) on transient API trouble, and persists
 * negatives in lifer_loc_attempts with a reason column. Multi-SubID
 * (≤3 per loc) so one deleted/hidden sibling does not poison the loc.
 */
import { query } from '$lib/db';
import { EbirdError, ebirdFetchOrNull, getEbirdApiKey } from '$server/ebird';
import { fetchAuthenticatedEbird, EbirdLoginError, EbirdUpstreamError } from '$server/ebird-account';

export const LIFER_LOC_TOTAL_CAP = 40;
export const LIFER_LOC_CAS_CAP = 25;

export interface LiferLocResolution {
	candidates: number;
	resolved: number;
	negative: number;
	capped: boolean;
	stopped: boolean;
	stopReason?: 'auth' | 'upstream' | 'timeout' | 'cancel';
}

interface HotspotInfo {
	locId?: string;
	name?: string;
	latitude?: number;
	longitude?: number;
}

type Fetcher = typeof fetch;
type OwnerFetcher = (userId: number, url: string, opts?: { timeout?: number }) => Promise<string>;

/**
 * Tight lat/lng extract from owner checklist HTML (td-2fbfc1 §1).
 * The JSP embeds "lat":N,"lng":N as JSON keys. Take the first valid pair.
 * Range-check lat ∈ [−90,90], lng ∈ [−180,180]. No general HTML parsing.
 */
export function extractLatLng(html: string): { lat: number; lng: number } | null {
	// Adjacent pair match — "lat":N,"lng":N as a single unit (GROK review).
	const m = html.match(/"lat"\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*"lng"\s*:\s*(-?\d+(?:\.\d+)?)/);
	if (!m) return null;
	const lat = parseFloat(m[1]);
	const lng = parseFloat(m[2]);
	if (isNaN(lat) || isNaN(lng)) return null;
	if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
	return { lat, lng };
}

function callTimeout(deadlineAt?: number): number | undefined {
	if (!deadlineAt) return undefined;
	return Math.max(0, Math.min(30_000, deadlineAt - Date.now()));
}

async function lookupHotspot(
	locId: string,
	apiKey: string,
	opts?: { fetcher?: Fetcher; deadlineAt?: number }
): Promise<{ name: string | null; lat: number; lng: number } | null> {
	const t = callTimeout(opts?.deadlineAt);
	const signal = t != null ? AbortSignal.timeout(t) : undefined;
	const hs = await ebirdFetchOrNull<HotspotInfo>(
		`/ref/hotspot/info/${encodeURIComponent(locId)}`,
		apiKey,
		{ fetcher: opts?.fetcher, nullOn: [404], signal }
	);
	if (hs && typeof hs.latitude === 'number' && typeof hs.longitude === 'number') {
		return { name: hs.name ?? null, lat: hs.latitude, lng: hs.longitude };
	}
	return null;
}

type StopSignal = { stop: 'auth' | 'upstream' | 'timeout' };

async function lookupOwnerHtml(
	userId: number,
	subId: string,
	ownerFetcher: OwnerFetcher,
	deadlineAt?: number
): Promise<{ lat: number; lng: number; locName: string | null } | StopSignal | null> {
	const t = callTimeout(deadlineAt);
	try {
		const html = await ownerFetcher(userId, `https://ebird.org/checklist/${subId}`, t != null ? { timeout: t } : undefined);
		const coords = extractLatLng(html);
		if (!coords) {
			if (!/"(?:checklistId|subId)"\s*:/.test(html)) return { stop: 'auth' };
			return null;
		}
		return { ...coords, locName: null };
	} catch (err) {
		if (err instanceof EbirdLoginError) return { stop: 'auth' };
		if (err instanceof EbirdUpstreamError) {
			if (err.status === 404) return null;
			// 504 = fetchAuthenticatedEbird wraps timeout/abort as EbirdUpstreamError(504)
			if (err.status === 504) return { stop: 'timeout' };
			return { stop: 'upstream' };
		}
		throw err;
	}
}

export async function resolveLiferLocations(
	userId: number,
	opts: {
		fetcher?: Fetcher;
		ownerFetcher?: OwnerFetcher;
		cap?: number;
		casCap?: number;
		deadlineAt?: number;
		heartbeat?: () => Promise<{ cancel: boolean }>;
	} = {}
): Promise<LiferLocResolution> {
	const out: LiferLocResolution = {
		candidates: 0,
		resolved: 0,
		negative: 0,
		capped: false,
		stopped: false
	};
	const apiKey = await getEbirdApiKey(userId);

	const totalCap = opts.cap ?? LIFER_LOC_TOTAL_CAP;
	let casBudget = opts.casCap ?? LIFER_LOC_CAS_CAP;
	let httpBudget = totalCap;
	const oFetcher = opts.ownerFetcher ?? fetchAuthenticatedEbird;

	// Candidate SQL: loc_ids not yet in ebird_locations, not in
	// lifer_loc_coords (CC1 pin A), and no trusted attempt. NULL and
	// 'legacy_untrusted' reasons are distrusted (retry them).
	const rows = await query<{ loc_id: string; sub_id: string | null }>(
		`SELECT loc_id, sub_id FROM (
		   SELECT DISTINCT ss.loc_id, ss.sub_id, ss.first_seen
		     FROM seen_species ss
		    WHERE ss.user_id = $1
		      AND ss.loc_id IS NOT NULL
		      AND NOT EXISTS (SELECT 1 FROM ebird_locations el WHERE el.loc_id = ss.loc_id)
		      AND NOT EXISTS (SELECT 1 FROM lifer_loc_coords llc
		                       WHERE llc.user_id = ss.user_id AND llc.source_loc_id = ss.loc_id)
		      AND NOT EXISTS (SELECT 1 FROM lifer_loc_attempts la
		                       WHERE la.user_id = ss.user_id AND la.loc_id = ss.loc_id
		                         AND la.reason IN ('no_coords', 'gone'))
		 ) sub
		 ORDER BY loc_id, first_seen DESC NULLS LAST`,
		[userId]
	);

	// Group by loc_id, collect up to 3 distinct non-null sub_ids per loc
	// (newest first_seen first — GROK §4).
	const candidates = new Map<string, string[]>();
	for (const r of rows.rows) {
		if (!candidates.has(r.loc_id)) candidates.set(r.loc_id, []);
		const subs = candidates.get(r.loc_id)!;
		if (r.sub_id && !subs.includes(r.sub_id) && subs.length < 3) {
			subs.push(r.sub_id);
		}
	}
	out.candidates = candidates.size;

	const stop = (reason: LiferLocResolution['stopReason']) => {
		out.stopped = true;
		out.stopReason = reason;
	};

	const locIds = [...candidates.keys()];
	for (const locId of locIds) {
		if (opts.heartbeat) {
			const hb = await opts.heartbeat();
			if (hb.cancel) {
				stop('cancel');
				break;
			}
		}
		if (httpBudget <= 0) {
			out.capped = true;
			break;
		}
		if (opts.deadlineAt && Date.now() >= opts.deadlineAt) {
			stop('timeout');
			break;
		}

		// --- Step 1: Hotspot-info (API key, public hotspots) ---
		let hotspotHit = false;
		if (apiKey) {
			httpBudget--;
			try {
				const loc = await lookupHotspot(locId, apiKey, {
					fetcher: opts.fetcher,
					deadlineAt: opts.deadlineAt
				});
				if (loc) {
					await query(
						`INSERT INTO ebird_locations (loc_id, loc_name, lat, lng)
						 VALUES ($1, $2, $3, $4)
						 ON CONFLICT (loc_id) DO NOTHING`,
						[locId, loc.name ?? locId, loc.lat, loc.lng]
					);
					out.resolved++;
					hotspotHit = true;
				}
			} catch (err) {
				if (err instanceof EbirdError) {
					stop('upstream');
					break;
				}
				throw err;
			}
		}
		if (hotspotHit) continue;

		// --- Step 2: Owner HTML fallback (CAS session, personal L-ids) ---
		const subIds = candidates.get(locId)!;
		if (subIds.length === 0) {
			await query(
				`INSERT INTO lifer_loc_attempts (user_id, loc_id, reason) VALUES ($1, $2, 'no_coords')
				 ON CONFLICT (user_id, loc_id) DO UPDATE SET reason = 'no_coords'`,
				[userId, locId]
			);
			out.negative++;
			continue;
		}

		let ownerHit = false;
		let ownerStopped = false;
		for (const subId of subIds) {
			if (opts.heartbeat) {
				const hb = await opts.heartbeat();
				if (hb.cancel) {
					stop('cancel');
					ownerStopped = true;
					break;
				}
			}
			if (httpBudget <= 0 || casBudget <= 0) {
				out.capped = true;
				ownerStopped = true;
				break;
			}
			if (opts.deadlineAt && Date.now() >= opts.deadlineAt) {
				stop('timeout');
				ownerStopped = true;
				break;
			}
			httpBudget--;
			casBudget--;

			const result = await lookupOwnerHtml(userId, subId, oFetcher, opts.deadlineAt);
			if (result && 'stop' in result) {
				stop(result.stop);
				ownerStopped = true;
				break;
			}
			if (result && 'lat' in result) {
				await query(
					`INSERT INTO lifer_loc_coords
					   (user_id, source_loc_id, lat, lng, loc_name, source_sub_id, provenance)
					 VALUES ($1, $2, $3, $4, $5, $6, 'checklist_owner')
					 ON CONFLICT (user_id, source_loc_id) DO NOTHING`,
					[userId, locId, result.lat, result.lng, result.locName, subId]
				);
				out.resolved++;
				ownerHit = true;
				break;
			}
		}

		if (ownerStopped) break;
		if (!ownerHit) {
			await query(
				`INSERT INTO lifer_loc_attempts (user_id, loc_id, reason) VALUES ($1, $2, 'no_coords')
				 ON CONFLICT (user_id, loc_id) DO UPDATE SET reason = 'no_coords'`,
				[userId, locId]
			);
			out.negative++;
		}
	}

	if (!out.capped && out.candidates > 0) {
		const processed = out.resolved + out.negative;
		if (processed < out.candidates && !out.stopped) {
			out.capped = true;
		}
	}

	return out;
}

/**
 * LocID → coordinates for the life-list map (td-b5986c Commit B, GROK pin 2).
 *
 * The life-list CSV has no coordinates. Most lifer loc_ids already exist in
 * ebird_locations (fed by observation feeds); this resolves the remainder via
 * eBird — hotspot info first, then the lifer's own checklist (the CSV gives
 * every row a SubID) for personal locations — and INSERTs the missing rows.
 * It never UPDATEs existing ebird_locations rows (obs feeds stay the source
 * of truth) and never touches Google Places.
 *
 * Fail-soft by contract: runs after a successful import, capped per
 * invocation, tolerates 404/403 as data states, stops (without stamping)
 * on transient API trouble, and persists negatives via loc_checked_at so
 * dead loc_ids are not retried every sync.
 */
import { query } from '$lib/db';
import { EbirdError, ebirdFetchOrNull, getEbirdApiKey } from '$server/ebird';

/** ≤25 live lookups per sync — the worker budget is 4 minutes and a first
 * run may have a couple hundred unknown loc_ids; the remainder is picked
 * up by later syncs (GROK pin 2). */
export const LIFER_LOC_LOOKUP_CAP = 25;

export interface LiferLocResolution {
	/** Distinct unresolved loc_ids at start (after the ebird_locations join). */
	candidates: number;
	resolved: number;
	/** Both endpoints said 404/403 — persisted, not retried next sync. */
	negative: number;
	/** True when candidates exceeded the per-sync cap. */
	capped: boolean;
	/** True when a transient API error stopped the pass early. */
	stopped: boolean;
}

interface HotspotInfo {
	locId?: string;
	name?: string;
	latitude?: number;
	longitude?: number;
}
interface ChecklistView {
	loc?: { locId?: string; name?: string; latitude?: number; longitude?: number };
}

type Fetcher = typeof fetch;

async function lookupOne(
	locId: string,
	subId: string | null,
	apiKey: string,
	fetcher?: Fetcher
): Promise<{ name: string | null; lat: number; lng: number } | null> {
	const hs = await ebirdFetchOrNull<HotspotInfo>(
		`/ref/hotspot/info/${encodeURIComponent(locId)}`,
		apiKey,
		{ fetcher }
	);
	if (hs && typeof hs.latitude === 'number' && typeof hs.longitude === 'number') {
		return { name: hs.name ?? null, lat: hs.latitude, lng: hs.longitude };
	}
	if (subId) {
		const cl = await ebirdFetchOrNull<ChecklistView>(
			`/product/checklist/view/${encodeURIComponent(subId)}`,
			apiKey,
			{ fetcher }
		);
		const loc = cl?.loc;
		if (
			loc &&
			loc.locId === locId &&
			typeof loc.latitude === 'number' &&
			typeof loc.longitude === 'number'
		) {
			return { name: loc.name ?? null, lat: loc.latitude, lng: loc.longitude };
		}
	}
	return null;
}

export async function resolveLiferLocations(
	userId: number,
	opts: { fetcher?: Fetcher; cap?: number } = {}
): Promise<LiferLocResolution> {
	const out: LiferLocResolution = {
		candidates: 0,
		resolved: 0,
		negative: 0,
		capped: false,
		stopped: false
	};
	const apiKey = await getEbirdApiKey(userId);
	if (!apiKey) return out; // no key → the join-only page still works

	const cap = opts.cap ?? LIFER_LOC_LOOKUP_CAP;
	const todo = await query<{ loc_id: string; sub_id: string | null }>(
		`SELECT DISTINCT ON (ss.loc_id) ss.loc_id, ss.sub_id
		   FROM seen_species ss
		  WHERE ss.user_id = $1 AND ss.loc_id IS NOT NULL
		    AND ss.loc_checked_at IS NULL
		    AND NOT EXISTS (SELECT 1 FROM ebird_locations el WHERE el.loc_id = ss.loc_id)
		  ORDER BY ss.loc_id`,
		[userId]
	);
	out.candidates = todo.rows.length;
	out.capped = todo.rows.length > cap;

	for (const row of todo.rows.slice(0, cap)) {
		let loc: Awaited<ReturnType<typeof lookupOne>>;
		try {
			loc = await lookupOne(row.loc_id, row.sub_id, apiKey, opts.fetcher);
		} catch (err) {
			// Transient (429/5xx/network): stop the pass WITHOUT stamping
			// loc_checked_at — these loc_ids retry on the next sync.
			if (err instanceof EbirdError) {
				out.stopped = true;
				break;
			}
			throw err;
		}
		if (loc) {
			// INSERT missing only — never overwrite feed-sourced coordinates.
			await query(
				`INSERT INTO ebird_locations (loc_id, loc_name, lat, lng)
				 VALUES ($1, $2, $3, $4)
				 ON CONFLICT (loc_id) DO NOTHING`,
				[row.loc_id, loc.name ?? row.loc_id, loc.lat, loc.lng]
			);
			out.resolved++;
		} else {
			out.negative++;
		}
		// Both outcomes are final for this loc_id — stamp every row carrying
		// it so later syncs skip it (negatives stay negative; hits resolve
		// through the ebird_locations join anyway).
		await query(
			`UPDATE seen_species SET loc_checked_at = NOW() WHERE user_id = $1 AND loc_id = $2`,
			[userId, row.loc_id]
		);
	}
	return out;
}

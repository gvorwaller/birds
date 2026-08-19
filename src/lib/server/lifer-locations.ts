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
 * invocation, tolerates expected 404/403 as data states, stops (without
 * recording anything) on transient API trouble, and persists negatives in
 * lifer_loc_attempts — its own (user_id, loc_id) table, because the import
 * DELETE+reINSERTs seen_species rows every sync and a stamp there never
 * survived a re-import (GROK REJECT on 8d1a412).
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
	// nullOn 404 ONLY: hotspot-info 403 is an invalid API key (eBird), not a
	// personal location — it throws and stops the pass without persisting.
	const hs = await ebirdFetchOrNull<HotspotInfo>(
		`/ref/hotspot/info/${encodeURIComponent(locId)}`,
		apiKey,
		{ fetcher, nullOn: [404] }
	);
	if (hs && typeof hs.latitude === 'number' && typeof hs.longitude === 'number') {
		return { name: hs.name ?? null, lat: hs.latitude, lng: hs.longitude };
	}
	if (subId) {
		// Unshared checklists legitimately 403 — both are data states here.
		const cl = await ebirdFetchOrNull<ChecklistView>(
			`/product/checklist/view/${encodeURIComponent(subId)}`,
			apiKey,
			{ fetcher, nullOn: [404, 403] }
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
	// sub_id NULLS LAST: prefer a sibling row that HAS a checklist so a
	// personal L-id can still resolve through the fallback (GROK P2).
	const todo = await query<{ loc_id: string; sub_id: string | null }>(
		`SELECT DISTINCT ON (ss.loc_id) ss.loc_id, ss.sub_id
		   FROM seen_species ss
		  WHERE ss.user_id = $1 AND ss.loc_id IS NOT NULL
		    AND NOT EXISTS (SELECT 1 FROM ebird_locations el WHERE el.loc_id = ss.loc_id)
		    AND NOT EXISTS (SELECT 1 FROM lifer_loc_attempts la
		                     WHERE la.user_id = ss.user_id AND la.loc_id = ss.loc_id)
		  ORDER BY ss.loc_id, ss.sub_id NULLS LAST`,
		[userId]
	);
	out.candidates = todo.rows.length;
	out.capped = todo.rows.length > cap;

	for (const row of todo.rows.slice(0, cap)) {
		let loc: Awaited<ReturnType<typeof lookupOne>>;
		try {
			loc = await lookupOne(row.loc_id, row.sub_id, apiKey, opts.fetcher);
		} catch (err) {
			// Transient (429/5xx/network) or invalid API key: stop the pass
			// WITHOUT recording a negative — these loc_ids retry next sync.
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
			// Persist the negative OUTSIDE seen_species — the next sync's
			// DELETE+reINSERT must not resurrect it (v1 never retries).
			await query(
				`INSERT INTO lifer_loc_attempts (user_id, loc_id) VALUES ($1, $2)
				 ON CONFLICT (user_id, loc_id) DO NOTHING`,
				[userId, row.loc_id]
			);
			out.negative++;
		}
	}
	return out;
}

/**
 * Trips + stops (Phase 2 planner). Stops are points (custom markers or eBird
 * hotspots); per-stop "needs reported here recently" is computed live from the
 * geo recent-obs endpoint, diffed against the user's seen list.
 */
import { query, withTransaction } from '$lib/db';
import { haversineKm } from '$lib/geo';
import { recentNearbyObs } from '$server/ebird';
import { seenSet } from '$server/needs';

export interface Trip {
	id: number;
	user_id: number;
	name: string;
	start_date: string | null;
	end_date: string | null;
	notes: string | null;
	created_at: string;
}

export interface TripStop {
	id: number;
	trip_id: number;
	sort_order: number;
	hotspot_id: string | null;
	custom_name: string | null;
	lat: number | null;
	lon: number | null;
	notes: string | null;
}

export interface TripSummary extends Trip {
	stop_count: number;
}

export async function listTrips(userId: number): Promise<TripSummary[]> {
	const r = await query<TripSummary>(
		`SELECT t.*, COUNT(s.id)::int AS stop_count
		   FROM trips t
		   LEFT JOIN trip_stops s ON s.trip_id = t.id
		  WHERE t.user_id = $1
		  GROUP BY t.id
		  ORDER BY COALESCE(t.start_date, t.created_at::date) DESC, t.id DESC`,
		[userId]
	);
	return r.rows;
}

export async function getTrip(userId: number, tripId: number): Promise<Trip | null> {
	const r = await query<Trip>('SELECT * FROM trips WHERE id = $1 AND user_id = $2', [
		tripId,
		userId
	]);
	return r.rows[0] ?? null;
}

export async function getStops(tripId: number): Promise<TripStop[]> {
	const r = await query<TripStop>(
		'SELECT * FROM trip_stops WHERE trip_id = $1 ORDER BY sort_order, id',
		[tripId]
	);
	return r.rows;
}

export async function createTrip(
	userId: number,
	name: string,
	startDate: string | null,
	endDate: string | null
): Promise<number> {
	const r = await query<{ id: number }>(
		`INSERT INTO trips (user_id, name, start_date, end_date) VALUES ($1, $2, $3, $4) RETURNING id`,
		[userId, name, startDate, endDate]
	);
	return r.rows[0].id;
}

export async function updateTrip(
	userId: number,
	tripId: number,
	fields: { name?: string; start_date?: string | null; end_date?: string | null; notes?: string | null }
): Promise<void> {
	await query(
		`UPDATE trips SET
		    name = COALESCE($3, name),
		    start_date = $4,
		    end_date = $5,
		    notes = $6
		  WHERE id = $1 AND user_id = $2`,
		[tripId, userId, fields.name ?? null, fields.start_date ?? null, fields.end_date ?? null, fields.notes ?? null]
	);
}

export async function deleteTrip(userId: number, tripId: number): Promise<void> {
	await query('DELETE FROM trips WHERE id = $1 AND user_id = $2', [tripId, userId]);
}

/** Ownership guard used before any stop mutation. */
async function assertOwnsTrip(userId: number, tripId: number): Promise<boolean> {
	const r = await query('SELECT 1 FROM trips WHERE id = $1 AND user_id = $2', [tripId, userId]);
	return r.rowCount === 1;
}

export async function addStop(
	userId: number,
	tripId: number,
	stop: { hotspot_id?: string | null; name: string; lat: number; lon: number; notes?: string | null }
): Promise<void> {
	if (!(await assertOwnsTrip(userId, tripId))) return;
	await query(
		`INSERT INTO trip_stops (trip_id, sort_order, hotspot_id, custom_name, lat, lon, notes)
		 VALUES ($1, COALESCE((SELECT MAX(sort_order) + 1 FROM trip_stops WHERE trip_id = $1), 0),
		         $2, $3, $4, $5, $6)`,
		[tripId, stop.hotspot_id ?? null, stop.name, stop.lat, stop.lon, stop.notes ?? null]
	);
}

export async function removeStop(userId: number, tripId: number, stopId: number): Promise<void> {
	if (!(await assertOwnsTrip(userId, tripId))) return;
	await query('DELETE FROM trip_stops WHERE id = $1 AND trip_id = $2', [stopId, tripId]);
}

export async function updateStopNotes(
	userId: number,
	tripId: number,
	stopId: number,
	notes: string | null
): Promise<void> {
	if (!(await assertOwnsTrip(userId, tripId))) return;
	await query('UPDATE trip_stops SET notes = $3 WHERE id = $1 AND trip_id = $2', [
		stopId,
		tripId,
		notes
	]);
}

/** Move a stop up or down by swapping sort_order with its neighbor. */
export async function moveStop(
	userId: number,
	tripId: number,
	stopId: number,
	direction: 'up' | 'down'
): Promise<void> {
	if (!(await assertOwnsTrip(userId, tripId))) return;
	await withTransaction(async (client) => {
		const stops = (
			await client.query<TripStop>(
				'SELECT id, sort_order FROM trip_stops WHERE trip_id = $1 ORDER BY sort_order, id',
				[tripId]
			)
		).rows;
		const idx = stops.findIndex((s) => s.id === stopId);
		if (idx < 0) return;
		const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
		if (swapIdx < 0 || swapIdx >= stops.length) return;
		const a = stops[idx];
		const b = stops[swapIdx];
		// Swap sort_order values (handle equal/duplicate orders by reindexing this pair).
		await client.query('UPDATE trip_stops SET sort_order = $2 WHERE id = $1', [a.id, swapIdx]);
		await client.query('UPDATE trip_stops SET sort_order = $2 WHERE id = $1', [b.id, idx]);
	});
}

/**
 * Reorder a trip's stops into a sensible driving route via greedy
 * nearest-neighbor on great-circle distance. Anchors at home when home is
 * near the stops (≤100 km of one), otherwise keeps the current first stop as
 * the start. Stops without coords are pushed to the end, order preserved.
 *
 * (Great-circle, not live drive-time — accurate enough for a day trip and
 * needs no Directions API / billing. Live drive-time ordering is a future
 * enhancement that requires the Directions API enabled.)
 */
export async function optimizeStopOrder(
	userId: number,
	tripId: number,
	origin: { lat: number; lon: number } | null
): Promise<{ changed: boolean; anchoredAtHome: boolean }> {
	if (!(await assertOwnsTrip(userId, tripId))) return { changed: false, anchoredAtHome: false };
	const stops = await getStops(tripId);
	const located = stops.filter(
		(s): s is TripStop & { lat: number; lon: number } => s.lat != null && s.lon != null
	);
	const unlocated = stops.filter((s) => s.lat == null || s.lon == null);
	if (located.length < 3) return { changed: false, anchoredAtHome: false };

	const remaining = [...located];
	const tour: (TripStop & { lat: number; lon: number })[] = [];
	let curLat: number;
	let curLon: number;

	const homeNear =
		origin != null &&
		located.some((s) => haversineKm(origin.lat, origin.lon, s.lat, s.lon) <= 100);

	if (homeNear && origin) {
		curLat = origin.lat;
		curLon = origin.lon;
	} else {
		const first = remaining.shift()!; // current first stop (getStops is sort_order-ordered)
		tour.push(first);
		curLat = first.lat;
		curLon = first.lon;
	}

	while (remaining.length) {
		let bestIdx = 0;
		let bestDist = Infinity;
		for (let i = 0; i < remaining.length; i++) {
			const d = haversineKm(curLat, curLon, remaining[i].lat, remaining[i].lon);
			if (d < bestDist) {
				bestDist = d;
				bestIdx = i;
			}
		}
		const next = remaining.splice(bestIdx, 1)[0];
		tour.push(next);
		curLat = next.lat;
		curLon = next.lon;
	}

	await withTransaction(async (client) => {
		let order = 0;
		for (const s of [...tour, ...unlocated]) {
			await client.query('UPDATE trip_stops SET sort_order = $2 WHERE id = $1', [s.id, order++]);
		}
	});
	return { changed: true, anchoredAtHome: !!homeNear };
}

const STOP_NEEDS_DIST_KM = 16;
const STOP_NEEDS_BACK_DAYS = 14;

/**
 * For each stop with coords, count the user's needs reported within
 * STOP_NEEDS_DIST_KM in the last STOP_NEEDS_BACK_DAYS. Returns stopId → count,
 * plus a `stale` flag if any underlying fetch fell back to cache.
 * Skips entirely when no API key (returns empty map).
 */
export async function needsCountForStops(
	userId: number,
	apiKey: string | null,
	stops: TripStop[]
): Promise<{ counts: Map<number, number>; stale: boolean; error: boolean }> {
	const counts = new Map<number, number>();
	if (!apiKey) return { counts, stale: false, error: false };

	const seen = await seenSet(userId);
	let stale = false;
	let error = false;

	await Promise.all(
		stops.map(async (s) => {
			if (s.lat == null || s.lon == null) return;
			try {
				const res = await recentNearbyObs(apiKey, s.lat, s.lon, STOP_NEEDS_DIST_KM, STOP_NEEDS_BACK_DAYS);
				if (res.stale) stale = true;
				const needs = new Set<string>();
				for (const o of res.data) {
					if (o.speciesCode && !seen.has(o.speciesCode)) needs.add(o.speciesCode);
				}
				counts.set(s.id, needs.size);
			} catch {
				error = true;
			}
		})
	);

	return { counts, stale, error };
}

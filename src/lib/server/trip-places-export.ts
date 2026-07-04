import { query } from '$lib/db';

export const DEFAULT_TRIP_PLACES_EXPORT_LIMIT = 1000;

export class TripPlacesExportConfigError extends Error {}

interface ExportUser {
	id: number;
	role: 'admin' | 'user' | 'viewer';
}

interface TripStopExportRow {
	stop_id: number;
	birds_trip_id: number;
	birds_trip_name: string;
	birds_trip_start_date: string | null;
	birds_trip_end_date: string | null;
	sort_order: number;
	hotspot_id: string | null;
	custom_name: string | null;
	lat: number | null;
	lon: number | null;
	google_place_id: string | null;
	notes: string | null;
	field_tip: string | null;
	field_tip_generated_at: string | null;
	target_count_at_save: number | null;
}

export interface ExportedTripPlace {
	source: 'birds';
	source_id: string;
	birds_trip_id: number;
	birds_trip_name: string;
	birds_trip_start_date: string | null;
	birds_trip_end_date: string | null;
	stop_id: number;
	sort_order: number;
	name: string;
	lat: number;
	lon: number;
	google_place_id: string | null;
	hotspot_id: string | null;
	notes: string | null;
	field_tip: string | null;
	field_tip_generated_at: string | null;
	target_count_at_save: number | null;
}

export interface TripPlacesExportResult {
	places: ExportedTripPlace[];
	truncated: boolean;
	limit: number;
}

function cleanString(value: string | null): string | null {
	const text = value?.trim() ?? '';
	return text ? text : null;
}

function validCoordinate(lat: number | null, lon: number | null): boolean {
	return (
		typeof lat === 'number' &&
		Number.isFinite(lat) &&
		lat >= -90 &&
		lat <= 90 &&
		typeof lon === 'number' &&
		Number.isFinite(lon) &&
		lon >= -180 &&
		lon <= 180
	);
}

export function normalizeTripPlaceRows(
	rows: TripStopExportRow[],
	options: { includeFieldTips: boolean }
): ExportedTripPlace[] {
	const places: ExportedTripPlace[] = [];
	for (const row of rows) {
		const name = cleanString(row.custom_name);
		if (!name || !validCoordinate(row.lat, row.lon)) continue;
		const lat = row.lat as number;
		const lon = row.lon as number;
		places.push({
			source: 'birds',
			source_id: `birds:trip_stop:${row.stop_id}`,
			birds_trip_id: row.birds_trip_id,
			birds_trip_name: row.birds_trip_name,
			birds_trip_start_date: row.birds_trip_start_date,
			birds_trip_end_date: row.birds_trip_end_date,
			stop_id: row.stop_id,
			sort_order: row.sort_order,
			name,
			lat,
			lon,
			google_place_id: cleanString(row.google_place_id),
			hotspot_id: cleanString(row.hotspot_id),
			notes: cleanString(row.notes),
			field_tip: options.includeFieldTips ? cleanString(row.field_tip) : null,
			field_tip_generated_at: options.includeFieldTips ? row.field_tip_generated_at : null,
			target_count_at_save: row.target_count_at_save
		});
	}
	return places;
}

async function exportUserForUsername(username: string): Promise<ExportUser> {
	const clean = username.trim();
	if (!clean) throw new TripPlacesExportConfigError('Birds export username is required.');
	const res = await query<ExportUser>('SELECT id, role FROM users WHERE username = $1', [clean]);
	const user = res.rows[0];
	if (!user) throw new TripPlacesExportConfigError(`Birds export user "${clean}" was not found.`);
	if (user.role === 'viewer') {
		throw new TripPlacesExportConfigError(
			`Birds export user "${clean}" is a viewer; configure an admin or user account.`
		);
	}
	return user;
}

export async function listTripPlacesForExport(options: {
	username: string;
	tripId?: number | null;
	includeFieldTips?: boolean;
	limit?: number;
}): Promise<TripPlacesExportResult> {
	const user = await exportUserForUsername(options.username);
	const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_TRIP_PLACES_EXPORT_LIMIT, 5000));
	const includeFieldTips = options.includeFieldTips ?? true;
	const params: unknown[] = [user.id, limit + 1];
	let tripClause = '';
	if (options.tripId != null) {
		params.push(options.tripId);
		tripClause = `AND t.id = $${params.length}`;
	}

	const res = await query<TripStopExportRow>(
		`SELECT s.id AS stop_id,
		        t.id AS birds_trip_id,
		        t.name AS birds_trip_name,
		        t.start_date::text AS birds_trip_start_date,
		        t.end_date::text AS birds_trip_end_date,
		        s.sort_order,
		        s.hotspot_id,
		        s.custom_name,
		        s.lat,
		        s.lon,
		        s.google_place_id,
		        s.notes,
		        s.field_tip,
		        s.field_tip_generated_at::text AS field_tip_generated_at,
		        s.target_count_at_save
		   FROM trips t
		   JOIN trip_stops s ON s.trip_id = t.id
		  WHERE t.user_id = $1
		    ${tripClause}
		  ORDER BY COALESCE(t.start_date, t.created_at::date) DESC NULLS LAST,
		           t.name,
		           t.id,
		           s.sort_order,
		           s.id
		  LIMIT $2`,
		params
	);

	const truncated = res.rows.length > limit;
	return {
		places: normalizeTripPlaceRows(res.rows.slice(0, limit), { includeFieldTips }),
		truncated,
		limit
	};
}

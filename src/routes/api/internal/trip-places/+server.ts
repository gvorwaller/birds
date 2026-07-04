import { randomUUID, timingSafeEqual } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listTripPlacesForExport, TripPlacesExportConfigError } from '$server/trip-places-export';

type LogFields = Record<string, string | number | boolean | null | undefined>;

function logTripPlacesExport(level: 'info' | 'warn', event: string, fields: LogFields = {}) {
	console[level](
		`[trip-places-export] ${JSON.stringify({
			event,
			...fields
		})}`
	);
}

function configuredToken(): string | null {
	const token = env.BIRDS_TRIPS_API_TOKEN?.trim() ?? '';
	return token ? token : null;
}

function bearerToken(request: Request): string | null {
	const header = request.headers.get('authorization') ?? '';
	const match = header.match(/^Bearer\s+(.+)$/i);
	return match?.[1]?.trim() || null;
}

function tokenMatches(actual: string, expected: string): boolean {
	const actualBuffer = Buffer.from(actual);
	const expectedBuffer = Buffer.from(expected);
	return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function parsePositiveInt(value: string | null): number | null {
	if (!value) return null;
	const n = Number(value);
	return Number.isInteger(n) && n > 0 ? n : null;
}

function parseBoolean(value: string | null, fallback: boolean): boolean {
	if (value == null || value === '') return fallback;
	return !['0', 'false', 'no'].includes(value.toLowerCase());
}

function requestId(request: Request): string {
	const id = request.headers.get('x-trips-import-request-id')?.trim();
	return id && id.length <= 100 ? id : randomUUID();
}

export const GET: RequestHandler = async ({ request, url }) => {
	const id = requestId(request);
	const started = Date.now();
	const expected = configuredToken();
	if (!expected) {
		logTripPlacesExport('warn', 'config_error', {
			request_id: id,
			duration_ms: Date.now() - started,
			error: 'BIRDS_TRIPS_API_TOKEN missing'
		});
		return json({ error: 'Birds trips API token is not configured.' }, { status: 503 });
	}

	const actual = bearerToken(request);
	if (!actual || !tokenMatches(actual, expected)) {
		logTripPlacesExport('warn', 'unauthorized', {
			request_id: id,
			duration_ms: Date.now() - started,
			has_bearer: Boolean(actual)
		});
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const username = (url.searchParams.get('username') ?? env.BIRDS_TRIPS_EXPORT_USERNAME ?? '').trim();
	const tripId = parsePositiveInt(url.searchParams.get('tripId'));
	const includeFieldTips = parseBoolean(url.searchParams.get('includeFieldTips'), true);
	const limit = parsePositiveInt(url.searchParams.get('limit')) ?? undefined;
	logTripPlacesExport('info', 'export_start', {
		request_id: id,
		username: username || null,
		birds_trip_id: tripId,
		include_field_tips: includeFieldTips,
		limit: limit ?? null
	});

	try {
		const result = await listTripPlacesForExport({
			username,
			tripId,
			includeFieldTips,
			limit
		});
		logTripPlacesExport('info', 'export_success', {
			request_id: id,
			username: username || null,
			birds_trip_id: tripId,
			places: result.places.length,
			truncated: result.truncated,
			limit: result.limit,
			duration_ms: Date.now() - started
		});
		return json(result);
	} catch (err) {
		if (err instanceof TripPlacesExportConfigError) {
			logTripPlacesExport('warn', 'export_config_error', {
				request_id: id,
				username: username || null,
				birds_trip_id: tripId,
				duration_ms: Date.now() - started,
				error: err.message
			});
			return json({ error: err.message }, { status: 503 });
		}
		logTripPlacesExport('warn', 'export_error', {
			request_id: id,
			username: username || null,
			birds_trip_id: tripId,
			duration_ms: Date.now() - started,
			error: err instanceof Error ? err.message : String(err)
		});
		throw err;
	}
};

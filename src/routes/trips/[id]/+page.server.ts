import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { query } from '$lib/db';
import { getEbirdApiKey, hotspotsNear, EbirdError, type EbirdHotspot } from '$server/ebird';
import { geocodePlace } from '$server/geocode';
import {
	addStop,
	deleteTrip,
	getStops,
	getTrip,
	moveStop,
	needsCountForStops,
	optimizeStopOrder,
	removeStop,
	setStopOrder,
	updateStopNotes,
	updateTrip
} from '$server/trips';

async function homeOf(userId: number): Promise<{ lat: number; lon: number } | null> {
	const u = await query<{ home_lat: number | null; home_lon: number | null }>(
		'SELECT home_lat, home_lon FROM users WHERE id = $1',
		[userId]
	);
	return u.rows[0]?.home_lat != null && u.rows[0]?.home_lon != null
		? { lat: u.rows[0].home_lat, lon: u.rows[0].home_lon }
		: null;
}

const HOTSPOT_SEARCH_DIST_KM = 25;

function tripIdFrom(params: { id: string }): number {
	const id = Number(params.id);
	if (!Number.isInteger(id) || id <= 0) throw error(404, 'Trip not found');
	return id;
}

export const load: PageServerLoad = async ({ locals, params, url }) => {
	const userId = locals.ownerId!;
	const tripId = tripIdFrom(params);

	const trip = await getTrip(userId, tripId);
	if (!trip) throw error(404, 'Trip not found');

	const stops = await getStops(tripId);
	const apiKey = await getEbirdApiKey(userId);
	const needs = await needsCountForStops(userId, apiKey, stops);

	// Optional "find hotspots near <place>" search.
	const hs = (url.searchParams.get('hs') ?? '').trim();
	let hotspots: EbirdHotspot[] = [];
	let hsCenter: { lat: number; lng: number; label: string } | null = null;
	let hsError: string | null = null;

	if (hs) {
		if (!apiKey) {
			hsError = 'Add your eBird API key in Settings to search hotspots.';
		} else {
			const geo = await geocodePlace(hs);
			if (!geo) {
				hsError = `Couldn't find "${hs}".`;
			} else {
				hsCenter = { lat: geo.lat, lng: geo.lng, label: geo.name };
				try {
					const res = await hotspotsNear(apiKey, geo.lat, geo.lng, HOTSPOT_SEARCH_DIST_KM);
					const existing = new Set(stops.map((s) => s.hotspot_id).filter(Boolean));
					hotspots = res.data.filter((h) => !existing.has(h.locId)).slice(0, 15);
				} catch (err) {
					hsError = err instanceof EbirdError ? err.message : 'Could not load hotspots.';
				}
			}
		}
	}

	return {
		trip,
		stops,
		home: await homeOf(userId),
		canEdit: locals.user!.role !== 'viewer',
		needsCounts: Object.fromEntries(needs.counts) as Record<string, number>,
		needsStale: needs.stale,
		needsError: needs.error,
		hasApiKey: !!apiKey,
		hs,
		hotspots,
		hsCenter,
		hsError
	};
};

export const actions: Actions = {
	update_trip: async ({ locals, params, request }) => {
		const tripId = tripIdFrom(params);
		const form = await request.formData();
		const name = (form.get('name') ?? '').toString().trim();
		const start = (form.get('start_date') ?? '').toString().trim() || null;
		const end = (form.get('end_date') ?? '').toString().trim() || null;
		const notes = (form.get('notes') ?? '').toString().trim() || null;
		if (!name) return fail(400, { error: 'Trip name is required.' });
		if (start && end && end < start) return fail(400, { error: 'End date is before start date.' });
		await updateTrip(locals.ownerId!, tripId, { name, start_date: start, end_date: end, notes });
		return { ok: true as const, message: 'Trip updated.' };
	},

	delete_trip: async ({ locals, params }) => {
		const tripId = tripIdFrom(params);
		await deleteTrip(locals.ownerId!, tripId);
		throw redirect(303, '/trips');
	},

	add_place: async ({ locals, params, request }) => {
		const tripId = tripIdFrom(params);
		const form = await request.formData();
		const name = (form.get('name') ?? '').toString().trim();
		const lat = Number(form.get('lat'));
		const lon = Number(form.get('lon'));
		if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) {
			return fail(400, { error: 'Search a place first, then add it.' });
		}
		await addStop(locals.ownerId!, tripId, { name, lat, lon });
		return { ok: true as const, message: `Added "${name}".` };
	},

	add_hotspot: async ({ locals, params, request }) => {
		const tripId = tripIdFrom(params);
		const form = await request.formData();
		const locId = (form.get('loc_id') ?? '').toString().trim();
		const name = (form.get('name') ?? '').toString().trim();
		const lat = Number(form.get('lat'));
		const lon = Number(form.get('lon'));
		if (!locId || !name || !Number.isFinite(lat) || !Number.isFinite(lon)) {
			return fail(400, { error: 'Hotspot data was incomplete.' });
		}
		await addStop(locals.ownerId!, tripId, { hotspot_id: locId, name, lat, lon });
		return { ok: true as const, message: `Added "${name}".` };
	},

	remove_stop: async ({ locals, params, request }) => {
		const tripId = tripIdFrom(params);
		const form = await request.formData();
		const stopId = Number(form.get('stop_id'));
		if (!Number.isInteger(stopId)) return fail(400, { error: 'Bad stop id.' });
		await removeStop(locals.ownerId!, tripId, stopId);
		return { ok: true as const };
	},

	// Client-computed driving-distance order (Google DirectionsService). The
	// browser posts the optimized stop-id sequence here to persist it.
	set_order: async ({ locals, params, request }) => {
		const tripId = tripIdFrom(params);
		const form = await request.formData();
		const ids = (form.get('order') ?? '')
			.toString()
			.split(',')
			.map((x) => Number(x.trim()))
			.filter((n) => Number.isInteger(n) && n > 0);
		const ok = await setStopOrder(locals.ownerId!, tripId, ids);
		if (!ok) return fail(400, { error: 'Could not apply the optimized order.' });
		return { ok: true as const, message: 'Stops reordered by real driving distance.' };
	},

	// Fallback: straight-line nearest-neighbor (no Directions API needed). Used
	// when the browser can't reach the Directions service.
	optimize: async ({ locals, params }) => {
		const tripId = tripIdFrom(params);
		const userId = locals.ownerId!;
		const res = await optimizeStopOrder(userId, tripId, await homeOf(userId));
		if (!res.changed) {
			return fail(400, { error: 'Add at least 3 located stops to optimize the route.' });
		}
		return {
			ok: true as const,
			message: 'Stops reordered by straight-line distance (driving routing was unavailable).'
		};
	},

	move_stop: async ({ locals, params, request }) => {
		const tripId = tripIdFrom(params);
		const form = await request.formData();
		const stopId = Number(form.get('stop_id'));
		const direction = (form.get('direction') ?? '').toString();
		if (!Number.isInteger(stopId) || (direction !== 'up' && direction !== 'down')) {
			return fail(400, { error: 'Bad move request.' });
		}
		await moveStop(locals.ownerId!, tripId, stopId, direction);
		return { ok: true as const };
	},

	save_notes: async ({ locals, params, request }) => {
		const tripId = tripIdFrom(params);
		const form = await request.formData();
		const stopId = Number(form.get('stop_id'));
		const notes = (form.get('notes') ?? '').toString().trim() || null;
		if (!Number.isInteger(stopId)) return fail(400, { error: 'Bad stop id.' });
		await updateStopNotes(locals.ownerId!, tripId, stopId, notes);
		return { ok: true as const, message: 'Note saved.' };
	}
};

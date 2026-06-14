/**
 * Client-side driving-route helpers built on the Maps JS DirectionsService.
 * Runs in the browser with the existing referrer-restricted PUBLIC maps key —
 * no server-side Directions key needed. Requires the Directions API to be
 * enabled on the Google Cloud project; callers should fall back to the
 * server-side straight-line optimizer if these throw.
 */
import { loadGoogleMaps } from '$lib/google-maps';
import { haversineKm } from '$lib/geo';

export interface RouteStop {
	id: number;
	lat: number;
	lon: number;
}

export interface OptimizeResult {
	orderedIds: number[];
	anchoredAtHome: boolean;
	totalKm: number;
	totalMin: number;
}

const HOME_ANCHOR_KM = 100;

/**
 * Compute a drive-optimal order for a trip's stops. Round-trips from home when
 * home is within 100 km of a stop; otherwise loops from the current first stop.
 * Stops without coordinates are appended unchanged. Throws if the Directions
 * service is unavailable so the caller can fall back.
 */
export async function optimizeDrivingRoute(
	apiKey: string,
	opts: { home: { lat: number; lon: number } | null; stops: RouteStop[] }
): Promise<OptimizeResult> {
	const located = opts.stops.filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon));
	const unlocated = opts.stops.filter((s) => !Number.isFinite(s.lat) || !Number.isFinite(s.lon));
	if (located.length < 2) throw new Error('Need at least 2 located stops to optimize.');

	const libs = await loadGoogleMaps(apiKey, ['routes']);
	/* eslint-disable @typescript-eslint/no-explicit-any */
	const routes = libs.routes as any;
	const service = new routes.DirectionsService();
	/* eslint-enable @typescript-eslint/no-explicit-any */

	const home = opts.home;
	const homeNear =
		home != null && located.some((s) => haversineKm(home.lat, home.lon, s.lat, s.lon) <= HOME_ANCHOR_KM);

	// `kept` is the fixed prefix; `waypointStops` are the stops Google reorders.
	let anchor: { lat: number; lng: number };
	let kept: RouteStop[];
	let waypointStops: RouteStop[];
	if (homeNear && home) {
		anchor = { lat: home.lat, lng: home.lon };
		kept = [];
		waypointStops = located;
	} else {
		anchor = { lat: located[0].lat, lng: located[0].lon };
		kept = [located[0]];
		waypointStops = located.slice(1);
	}

	const result = await service.route({
		origin: anchor,
		destination: anchor, // loop back to the anchor; we only use the visiting order
		waypoints: waypointStops.map((s) => ({
			location: { lat: s.lat, lng: s.lon },
			stopover: true
		})),
		optimizeWaypoints: true,
		travelMode: 'DRIVING'
	});

	const route = result?.routes?.[0];
	if (!route) throw new Error('No drivable route found.');

	const order: number[] = route.waypoint_order ?? waypointStops.map((_: unknown, i: number) => i);
	const orderedWaypoints = order.map((i) => waypointStops[i]);

	let meters = 0;
	let seconds = 0;
	for (const leg of route.legs ?? []) {
		meters += leg.distance?.value ?? 0;
		seconds += leg.duration?.value ?? 0;
	}

	return {
		orderedIds: [...kept, ...orderedWaypoints, ...unlocated].map((s) => s.id),
		anchoredAtHome: !!homeNear,
		totalKm: meters / 1000,
		totalMin: Math.round(seconds / 60)
	};
}

/** "2 h 40 min" / "45 min" from minutes. */
export function formatDuration(min: number): string {
	if (min < 60) return `${min} min`;
	const h = Math.floor(min / 60);
	const m = min % 60;
	return m ? `${h} h ${m} min` : `${h} h`;
}

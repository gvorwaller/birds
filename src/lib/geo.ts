/** Great-circle distance in km between two lat/lng points (haversine). */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6371;
	const toRad = (d: number) => (d * Math.PI) / 180;
	const dLat = toRad(lat2 - lat1);
	const dLon = toRad(lon2 - lon1);
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
	return 2 * R * Math.asin(Math.sqrt(a));
}

export function formatKm(km: number): string {
	return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

/**
 * Google Maps universal deep-links for a coordinate. On phones these open the
 * Google Maps app; on desktop, maps.google.com. We use raw lat,lng (not the
 * place name) so the pin lands exactly on the reported spot.
 */
export function mapsPlaceUrl(lat: number, lng: number): string {
	return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

/** Directions TO the coordinate; Google fills in "from" using the device's location. */
export function mapsDirectionsUrl(lat: number, lng: number): string {
	return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
}

/**
 * Multi-stop driving directions through every point in order, starting from the
 * device's current location: all but the last point become ordered waypoints,
 * the last is the destination. Google's universal URL preserves waypoint order
 * (it does not re-optimize), so pass coordinates already in trip order. Returns
 * the single-destination URL for one point, and '' for none. Keep the list small
 * — Google's cross-platform URL caps waypoints (≈9).
 */
export function mapsRouteUrl(points: Array<{ lat: number; lng: number }>): string {
	if (points.length === 0) return '';
	if (points.length === 1) return mapsDirectionsUrl(points[0].lat, points[0].lng);
	const dest = points[points.length - 1];
	const waypoints = points
		.slice(0, -1)
		.map((p) => `${p.lat},${p.lng}`)
		.join('|');
	return `https://www.google.com/maps/dir/?api=1&destination=${dest.lat},${dest.lng}&waypoints=${waypoints}&travelmode=driving`;
}

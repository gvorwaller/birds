import { fail, redirect } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { query } from "$lib/db";
import { getEbirdApiKey, EbirdError } from "$server/ebird";
import { geocodePlace } from "$server/geocode";
import { milesToKm } from "$lib/geo";
import {
	runQuery,
	assembleTripPreview,
	validateTripParams,
	BOUNDS,
	type QueryFilters,
	type PlannedTripPreview,
	type QueryResult,
} from "$server/query-engine";
import { savePlannedTrip, type PlannedTripStopInput } from "$server/trips";

const DEFAULTS = { radiusMi: 10, back: 7, stops: 3, minNeeds: 3 };

function numParam(v: string | null, fallback: number): number {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const load: PageServerLoad = async ({ locals, url }) => {
	const userId = locals.ownerId!; // viewers preview the owner's data (save is blocked globally)
	const canEdit = locals.user!.role !== "viewer";
	const p = url.searchParams;

	const inputs = {
		place: (p.get("place") ?? "").trim(),
		radiusMi: numParam(p.get("radius"), DEFAULTS.radiusMi),
		back: numParam(p.get("back"), DEFAULTS.back),
		stops: numParam(p.get("stops"), DEFAULTS.stops),
		minNeeds: numParam(p.get("minneeds"), DEFAULTS.minNeeds),
		seenStatus: p.get("seen") === "all" ? ("all" as const) : ("needs" as const),
		rareOnly: p.get("rare") === "1",
		includeHistorical: p.get("hist") === "1",
	};

	const base = { inputs, bounds: BOUNDS, canEdit };

	// No query yet (first visit) → just render the form.
	if (!p.has("place") && !p.has("radius")) {
		return {
			...base,
			anchor: null,
			query: null,
			preview: null,
			errors: [],
			needsLocation: false,
		};
	}

	// Resolve the anchor: searched place → geocode; else the user's home.
	const homeRow = await query<{
		home_lat: number | null;
		home_lon: number | null;
		home_label: string | null;
	}>("SELECT home_lat, home_lon, home_label FROM users WHERE id = $1", [
		userId,
	]);
	const home = homeRow.rows[0];

	let anchor: { lat: number; lng: number; label: string } | null = null;
	const errors: string[] = [];
	if (inputs.place) {
		const geo = await geocodePlace(inputs.place);
		if (geo) anchor = { lat: geo.lat, lng: geo.lng, label: geo.name };
		else
			errors.push(
				`Couldn't find "${inputs.place}". Try a city, county, park, or address.`,
			);
	}
	if (!anchor && home?.home_lat != null && home.home_lon != null) {
		anchor = {
			lat: home.home_lat,
			lng: home.home_lon,
			label: home.home_label ?? "Home",
		};
	}
	if (!anchor) {
		return {
			...base,
			anchor: null,
			query: null,
			preview: null,
			errors,
			needsLocation: errors.length === 0,
		};
	}

	const validated = validateTripParams({
		anchorLat: anchor.lat,
		anchorLng: anchor.lng,
		anchorLabel: anchor.label,
		radiusKm: milesToKm(inputs.radiusMi),
		daysBack: inputs.back,
		numStops: inputs.stops,
		minNeedsPerStop: inputs.minNeeds,
		seenStatus: inputs.seenStatus,
		rareOnly: inputs.rareOnly,
		includeHistoricalStop: inputs.includeHistorical,
	});
	if (!validated.ok) {
		return {
			...base,
			anchor,
			query: null,
			preview: null,
			errors: [...errors, ...validated.errors],
			needsLocation: false,
		};
	}

	const apiKey = await getEbirdApiKey(userId);
	if (!apiKey) {
		errors.push("Add your eBird API key in Settings to plan a trip.");
		return {
			...base,
			anchor,
			query: null,
			preview: null,
			errors,
			needsLocation: false,
		};
	}

	const params = validated.value;
	const filters: QueryFilters = params; // TripQueryParams extends QueryFilters
	let queryResult: QueryResult | null = null;
	let preview: PlannedTripPreview | null = null;
	try {
		queryResult = await runQuery(
			userId,
			apiKey,
			filters,
			params.minNeedsPerStop,
		);
		preview = await assembleTripPreview(params, queryResult);
	} catch (err) {
		errors.push(
			err instanceof EbirdError
				? err.message
				: "Could not load eBird data for this area.",
		);
	}

	return {
		...base,
		anchor,
		query: queryResult,
		preview,
		errors,
		needsLocation: false,
	};
};

export const actions: Actions = {
	save: async ({ locals, request }) => {
		const form = await request.formData();
		const name = (form.get("name") ?? "").toString().trim();
		const stopsJson = (form.get("stops") ?? "").toString();
		if (!name) return fail(400, { error: "Give the trip a name." });

		let parsed: unknown;
		try {
			parsed = JSON.parse(stopsJson);
		} catch {
			return fail(400, {
				error: "Trip preview was malformed — re-run the plan and try again.",
			});
		}
		if (!Array.isArray(parsed) || parsed.length === 0) {
			return fail(400, { error: "No stops to save — re-run the plan." });
		}

		const stops: PlannedTripStopInput[] = [];
		for (const raw of parsed) {
			const s = raw as Record<string, unknown>;
			const lat = Number(s.lat);
			const lon = Number(s.lon);
			const nm = typeof s.name === "string" ? s.name.trim() : "";
			if (!nm || !Number.isFinite(lat) || !Number.isFinite(lon)) {
				return fail(400, {
					error: "A stop was missing a name or coordinates — re-run the plan.",
				});
			}
			const count = s.target_count_at_save;
			stops.push({
				hotspot_id:
					typeof s.hotspot_id === "string" && s.hotspot_id
						? s.hotspot_id
						: null,
				name: nm.slice(0, 200),
				lat,
				lon,
				notes: typeof s.notes === "string" ? s.notes.slice(0, 500) : null,
				target_count_at_save:
					count === null || count === undefined
						? null
						: Number.isFinite(Number(count))
							? Number(count)
							: null,
			});
		}
		if (stops.length > BOUNDS.numStops.max + 1) {
			return fail(400, { error: "Too many stops to save." });
		}

		const tripId = await savePlannedTrip(
			locals.ownerId!,
			{
				name,
				startDate: null,
				endDate: null,
				notes: "Generated by the trip planner.",
			},
			stops,
		);
		throw redirect(303, `/trips/${tripId}`);
	},
};

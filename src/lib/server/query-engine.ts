/**
 * Deterministic query + trip-planning engine.
 *
 * The shared core behind the ad-hoc query UI and the trip builder (and any
 * future natural-language layer): it filters and ranks eBird locations by how
 * many of the user's needs were reported there, collects the trigger species,
 * and assembles an ordered trip preview. All factual data comes from the cached
 * eBird helpers + the user's seen list — the engine never fabricates sightings.
 *
 * Design (Codex review): this is a first-class typed module, not `geoTargets()`
 * (a page-view helper). Filtering/ranking/trigger-species/preview assembly live
 * here behind explicit contracts so callers stay thin. Ranking and ordering are
 * pure given the obs payload + seen set, so they are testable without I/O.
 */
import { nearestNeighborOrder, haversineKm } from "$lib/geo";
import {
	notableNearbyObs,
	recentNearbyObs,
	type CachedResult,
	type EbirdObs,
} from "$server/ebird";
import { seenSet } from "$server/needs";
import { placesNearby, type PlacesNearbyResult } from "$server/geocode";

// Inclusive bounds enforced by validation; out-of-range params are explicit
// errors, never silently clamped to a meaning-changing default. (Codex.)
export const BOUNDS = {
	radiusKm: { min: 1, max: 50 }, // eBird geo endpoints cap at 50 km
	daysBack: { min: 1, max: 30 },
	numStops: { min: 1, max: 10 },
	minNeedsPerStop: { min: 1, max: 20 },
} as const;

export type SeenStatus = "needs" | "all";

export interface QueryFilters {
	anchorLat: number;
	anchorLng: number;
	anchorLabel: string;
	radiusKm: number;
	daysBack: number;
	/** 'needs' = unseen species only; 'all' = every species reported. */
	seenStatus: SeenStatus;
	/** Restrict to the eBird notable ("rare this week") feed. */
	rareOnly: boolean;
}

export interface TripQueryParams extends QueryFilters {
	numStops: number;
	minNeedsPerStop: number;
	includeHistoricalStop: boolean;
}

export interface TriggerSpecies {
	code: string;
	comName: string;
	sciName: string;
	lastObsDt: string;
}

export interface PlaceCandidate {
	locId: string | null;
	locName: string;
	lat: number;
	lng: number;
	distanceKm: number;
	/** Distinct matching species reported here (needs, or all per seenStatus). */
	matchCount: number;
	triggerSpecies: TriggerSpecies[];
	lastObsDt: string;
	/** Meets minNeedsPerStop — eligible to become a trip stop. */
	eligible: boolean;
}

export interface QueryResult {
	filters: QueryFilters;
	candidates: PlaceCandidate[]; // ranked desc by matchCount, then recency
	speciesCount: number; // distinct matching species across the whole result
	stale: boolean;
	fetchedAt: string; // ISO
}

export type PlannedStopKind = "hotspot" | "historical";

export interface PlannedStop {
	hotspotId: string | null;
	name: string;
	lat: number;
	lng: number;
	/** Snapshot of matching needs at this stop; null for a historical stop. */
	matchCount: number | null;
	triggerSpecies: TriggerSpecies[];
	kind: PlannedStopKind;
	note: string;
}

export interface PlannedTripPreview {
	params: TripQueryParams;
	stops: PlannedStop[]; // in driving order (historical stop slotted in)
	historicalStatus:
		| "included"
		| "none_found"
		| "not_configured"
		| "unavailable"
		| "not_requested";
	/** Distinct matching species across the chosen birding stops. */
	totalMatchSpecies: number;
	warnings: string[];
	stale: boolean;
	suggestedName: string;
}

export type ValidationResult<T> =
	| { ok: true; value: T }
	| { ok: false; errors: string[] };

function inRange(n: number, b: { min: number; max: number }): boolean {
	return Number.isFinite(n) && n >= b.min && n <= b.max;
}

/**
 * Validate trip params already converted to engine units (km). Magnitude
 * params (radius/days/stops/min-needs) must be present and in range — explicit
 * errors, no hidden defaults. Enum/boolean flags carry safe defaults.
 */
export function validateTripParams(raw: {
	anchorLat: number;
	anchorLng: number;
	anchorLabel: string;
	radiusKm: number;
	daysBack: number;
	numStops: number;
	minNeedsPerStop: number;
	seenStatus?: SeenStatus;
	rareOnly?: boolean;
	includeHistoricalStop?: boolean;
}): ValidationResult<TripQueryParams> {
	const errors: string[] = [];
	if (!Number.isFinite(raw.anchorLat) || !Number.isFinite(raw.anchorLng)) {
		errors.push("A valid anchor location is required.");
	}
	if (!inRange(raw.radiusKm, BOUNDS.radiusKm)) {
		errors.push(
			`Radius must be between ${BOUNDS.radiusKm.min} and ${BOUNDS.radiusKm.max} km.`,
		);
	}
	if (!inRange(raw.daysBack, BOUNDS.daysBack)) {
		errors.push(
			`Window must be between ${BOUNDS.daysBack.min} and ${BOUNDS.daysBack.max} days.`,
		);
	}
	if (!inRange(raw.numStops, BOUNDS.numStops)) {
		errors.push(
			`Number of stops must be between ${BOUNDS.numStops.min} and ${BOUNDS.numStops.max}.`,
		);
	}
	if (!inRange(raw.minNeedsPerStop, BOUNDS.minNeedsPerStop)) {
		errors.push(
			`Minimum needs per stop must be between ${BOUNDS.minNeedsPerStop.min} and ${BOUNDS.minNeedsPerStop.max}.`,
		);
	}
	if (errors.length) return { ok: false, errors };
	return {
		ok: true,
		value: {
			anchorLat: raw.anchorLat,
			anchorLng: raw.anchorLng,
			anchorLabel: raw.anchorLabel,
			radiusKm: Math.round(raw.radiusKm),
			daysBack: Math.round(raw.daysBack),
			numStops: Math.round(raw.numStops),
			minNeedsPerStop: Math.round(raw.minNeedsPerStop),
			seenStatus: raw.seenStatus ?? "needs",
			rareOnly: raw.rareOnly ?? false,
			includeHistoricalStop: raw.includeHistoricalStop ?? false,
		},
	};
}

/**
 * Pure: group observations into ranked place candidates. A species "matches"
 * when it's unseen (seenStatus 'needs') or always ('all'). Candidates outside
 * the radius are dropped defensively (the API already restricts, but coords can
 * round). Sorted by matchCount desc, then most-recent.
 */
export function buildCandidates(
	obs: EbirdObs[],
	seen: Set<string>,
	filters: Pick<
		QueryFilters,
		"anchorLat" | "anchorLng" | "radiusKm" | "seenStatus"
	> & {
		minNeedsPerStop?: number;
	},
): PlaceCandidate[] {
	interface Acc {
		locId: string | null;
		locName: string;
		lat: number;
		lng: number;
		species: Map<string, TriggerSpecies>;
		lastObsDt: string;
	}
	const byLoc = new Map<string, Acc>();
	for (const o of obs) {
		if (!o.speciesCode) continue;
		if (filters.seenStatus === "needs" && seen.has(o.speciesCode)) continue;
		const key = o.locId || `${o.lat},${o.lng}`;
		let p = byLoc.get(key);
		if (!p) {
			p = {
				locId: o.locId ?? null,
				locName: o.locName,
				lat: o.lat,
				lng: o.lng,
				species: new Map(),
				lastObsDt: o.obsDt,
			};
			byLoc.set(key, p);
		}
		const prev = p.species.get(o.speciesCode);
		if (!prev || o.obsDt > prev.lastObsDt) {
			p.species.set(o.speciesCode, {
				code: o.speciesCode,
				comName: o.comName,
				sciName: o.sciName,
				lastObsDt: o.obsDt,
			});
		}
		if (o.obsDt > p.lastObsDt) p.lastObsDt = o.obsDt;
	}

	const minNeeds = filters.minNeedsPerStop ?? 1;
	return [...byLoc.values()]
		.map((p) => {
			const distanceKm = haversineKm(
				filters.anchorLat,
				filters.anchorLng,
				p.lat,
				p.lng,
			);
			const triggerSpecies = [...p.species.values()].sort(
				(a, b) =>
					b.lastObsDt.localeCompare(a.lastObsDt) ||
					a.comName.localeCompare(b.comName),
			);
			return {
				locId: p.locId,
				locName: p.locName,
				lat: p.lat,
				lng: p.lng,
				distanceKm,
				matchCount: p.species.size,
				triggerSpecies,
				lastObsDt: p.lastObsDt,
				eligible: p.species.size >= minNeeds,
			};
		})
		.filter((c) => c.distanceKm <= filters.radiusKm + 0.5) // tolerance for coord rounding
		.sort(
			(a, b) =>
				b.matchCount - a.matchCount || b.lastObsDt.localeCompare(a.lastObsDt),
		);
}

/** Run the ad-hoc query: fetch obs, diff against seen, rank places. */
export async function runQuery(
	userId: number,
	apiKey: string,
	filters: QueryFilters,
	minNeedsPerStop = 1,
): Promise<QueryResult> {
	const seen =
		filters.seenStatus === "needs" ? await seenSet(userId) : new Set<string>();
	const obsRes: CachedResult<EbirdObs[]> = filters.rareOnly
		? await notableNearbyObs(
				apiKey,
				filters.anchorLat,
				filters.anchorLng,
				filters.radiusKm,
				filters.daysBack,
			)
		: await recentNearbyObs(
				apiKey,
				filters.anchorLat,
				filters.anchorLng,
				filters.radiusKm,
				filters.daysBack,
			);

	const candidates = buildCandidates(obsRes.data, seen, {
		...filters,
		minNeedsPerStop,
	});
	const speciesSet = new Set<string>();
	for (const c of candidates)
		for (const s of c.triggerSpecies) speciesSet.add(s.code);

	return {
		filters,
		candidates,
		speciesCount: speciesSet.size,
		stale: obsRes.stale,
		fetchedAt: obsRes.fetchedAt.toISOString(),
	};
}

function stopNote(c: PlaceCandidate): string {
	const names = c.triggerSpecies.slice(0, 4).map((s) => s.comName);
	const extra = c.triggerSpecies.length - names.length;
	const list = names.join(", ") + (extra > 0 ? `, +${extra} more` : "");
	return `${c.matchCount} of your needs reported here (last seen ${c.lastObsDt.slice(0, 10)}): ${list}.`;
}

function historicalNote(name: string): string {
	return `History/culture stop on the route — ${name}.`;
}

/** Deterministic trip name from the anchor + chosen birding stops. */
function suggestName(
	params: TripQueryParams,
	birdStops: PlaceCandidate[],
): string {
	const place = params.anchorLabel.split(",")[0].trim() || "Local";
	const n = birdStops.length;
	return `${place} — ${n} ${n === 1 ? "stop" : "stops"}${params.rareOnly ? ", rarities" : ""}`;
}

function humanizePlaces(
	status: PlacesNearbyResult["status"],
): PlannedTripPreview["historicalStatus"] {
	switch (status) {
		case "ok":
			return "included";
		case "not_found":
			return "none_found";
		case "not_configured":
			return "not_configured";
		default:
			return "unavailable"; // rate_limited | upstream_error
	}
}

/**
 * Assemble an ordered trip preview from the query result. Picks the top
 * eligible birding stops, optionally adds one historical stop near the route,
 * and orders everything by nearest-neighbor from the anchor (deterministic,
 * server-side straight-line — the map can refine the drive order client-side
 * after save). `places` is injected so the engine stays testable.
 */
export async function planTrip(
	userId: number,
	apiKey: string,
	params: TripQueryParams,
	places: (lat: number, lng: number) => Promise<PlacesNearbyResult> = (
		lat,
		lng,
	) => placesNearby(lat, lng),
): Promise<PlannedTripPreview> {
	const q = await runQuery(userId, apiKey, params, params.minNeedsPerStop);
	return assembleTripPreview(params, q, places);
}

/**
 * Assemble the ordered trip preview from an already-computed QueryResult, so a
 * caller that also renders the full candidate list doesn't fetch twice. `places`
 * is injected for testability.
 */
export async function assembleTripPreview(
	params: TripQueryParams,
	q: QueryResult,
	places: (lat: number, lng: number) => Promise<PlacesNearbyResult> = (
		lat,
		lng,
	) => placesNearby(lat, lng),
): Promise<PlannedTripPreview> {
	const warnings: string[] = [];

	const eligible = q.candidates.filter((c) => c.eligible);
	const chosen = eligible.slice(0, params.numStops);
	if (chosen.length === 0) {
		warnings.push(
			`No hotspot within ${params.radiusKm} km had ${params.minNeedsPerStop}+ of your ${params.rareOnly ? "rare " : ""}needs in the last ${params.daysBack} days. Try widening the radius, the window, or lowering the minimum.`,
		);
	} else if (chosen.length < params.numStops) {
		warnings.push(
			`Only ${chosen.length} of ${params.numStops} requested stops met the ${params.minNeedsPerStop}-needs bar.`,
		);
	}

	const orderedBird = nearestNeighborOrder(
		{ lat: params.anchorLat, lng: params.anchorLng },
		chosen,
	);

	const birdStops: PlannedStop[] = orderedBird.map((c) => ({
		hotspotId: c.locId,
		name: c.locName,
		lat: c.lat,
		lng: c.lng,
		matchCount: c.matchCount,
		triggerSpecies: c.triggerSpecies,
		kind: "hotspot",
		note: stopNote(c),
	}));

	// Historical stop: search near the route's centroid so it's "on the path".
	let historicalStatus: PlannedTripPreview["historicalStatus"] =
		"not_requested";
	let historicalStop: PlannedStop | null = null;
	if (params.includeHistoricalStop && birdStops.length > 0) {
		const cLat = birdStops.reduce((s, b) => s + b.lat, 0) / birdStops.length;
		const cLng = birdStops.reduce((s, b) => s + b.lng, 0) / birdStops.length;
		const res = await places(cLat, cLng);
		historicalStatus = humanizePlaces(res.status);
		if (res.status === "ok") {
			const p = res.places[0];
			historicalStop = {
				hotspotId: null,
				name: p.name,
				lat: p.lat,
				lng: p.lng,
				matchCount: null, // never a fake 0 (Codex)
				triggerSpecies: [],
				kind: "historical",
				note: historicalNote(p.name),
			};
		} else if (res.status === "not_found") {
			warnings.push("No historical/cultural site found near the route.");
		} else if (res.status === "not_configured") {
			warnings.push(
				"Places API is not configured — skipped the historical stop.",
			);
		} else {
			warnings.push(
				"Could not reach the Places service — skipped the historical stop.",
			);
		}
	} else if (params.includeHistoricalStop) {
		historicalStatus = "none_found";
	}

	// Slot the historical stop into the route by nearest-neighbor over all stops.
	const allStops = historicalStop ? [...birdStops, historicalStop] : birdStops;
	const stops =
		allStops.length > 1
			? nearestNeighborOrder(
					{ lat: params.anchorLat, lng: params.anchorLng },
					allStops,
				)
			: allStops;

	const speciesSet = new Set<string>();
	for (const s of birdStops)
		for (const t of s.triggerSpecies) speciesSet.add(t.code);

	return {
		params,
		stops,
		historicalStatus,
		totalMatchSpecies: speciesSet.size,
		warnings,
		stale: q.stale,
		suggestedName: suggestName(params, orderedBird),
	};
}

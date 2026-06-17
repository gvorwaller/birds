/**
 * Needs/targets computation: recent eBird observations diffed against the
 * user's seen list. "Rare this week" = the notable feed, each entry badged
 * seen/need against the same list.
 */
import { query } from '$lib/db';
import { haversineKm } from '$lib/geo';
import {
	notableNearbyObs,
	notableObs,
	recentNearbyObs,
	recentObs,
	type CachedResult,
	type EbirdObs
} from '$server/ebird';

export interface SpeciesPlace {
	locId: string | null;
	locName: string;
	lat: number;
	lng: number;
	lastObsDt: string;
	nReports: number;
	distanceKm: number | null;
}

export interface SpeciesActivity {
	speciesCode: string;
	comName: string;
	sciName: string;
	nReports: number;
	totalCount: number;
	lastObsDt: string;
	locations: string[];
	/** Every distinct place in range this species was reported, nearest first. */
	places: SpeciesPlace[];
	lastLat: number;
	lastLng: number;
	distanceKm: number | null;
	photoCount: number;
}

export interface NotableEntry extends SpeciesActivity {
	seen: boolean;
}

export interface PlaceRanking {
	locId: string | null;
	locName: string;
	lat: number;
	lng: number;
	needCount: number;
	needSpecies: { code: string; comName: string }[];
	lastObsDt: string;
	distanceKm: number | null;
}

export interface TargetsView {
	needs: SpeciesActivity[];
	notable: NotableEntry[];
	bestPlaces: PlaceRanking[];
	stale: boolean;
	fetchedAt: Date;
	seenCount: number;
}

/**
 * Rank locations by how many distinct *needs* were reported there. Built from
 * the same recent-obs payload used for the needs list — no extra API calls.
 */
function rankPlaces(
	obs: EbirdObs[],
	seen: Set<string>,
	origin: { lat: number; lon: number } | null
): PlaceRanking[] {
	interface Acc {
		locId: string | null;
		locName: string;
		lat: number;
		lng: number;
		species: Map<string, string>;
		lastObsDt: string;
	}
	const byLoc = new Map<string, Acc>();
	for (const o of obs) {
		if (!o.speciesCode || seen.has(o.speciesCode)) continue;
		const key = o.locId || `${o.lat},${o.lng}`;
		let p = byLoc.get(key);
		if (!p) {
			p = {
				locId: o.locId ?? null,
				locName: o.locName,
				lat: o.lat,
				lng: o.lng,
				species: new Map(),
				lastObsDt: o.obsDt
			};
			byLoc.set(key, p);
		}
		if (!p.species.has(o.speciesCode)) p.species.set(o.speciesCode, o.comName);
		if (o.obsDt > p.lastObsDt) p.lastObsDt = o.obsDt;
	}
	return [...byLoc.values()]
		.map((p) => ({
			locId: p.locId,
			locName: p.locName,
			lat: p.lat,
			lng: p.lng,
			needCount: p.species.size,
			needSpecies: [...p.species.entries()].map(([code, comName]) => ({ code, comName })),
			lastObsDt: p.lastObsDt,
			distanceKm: origin ? haversineKm(origin.lat, origin.lon, p.lat, p.lng) : null
		}))
		.sort((a, b) => b.needCount - a.needCount || b.lastObsDt.localeCompare(a.lastObsDt));
}

export async function seenSet(userId: number): Promise<Set<string>> {
	const r = await query<{ species_code: string }>(
		'SELECT species_code FROM seen_species WHERE user_id = $1',
		[userId]
	);
	return new Set(r.rows.map((row) => row.species_code));
}

function aggregate(
	obs: EbirdObs[],
	home: { lat: number; lon: number } | null,
	photoCounts: Map<string, number>
): Map<string, SpeciesActivity> {
	const bySpecies = new Map<string, SpeciesActivity>();
	// Per-species accumulator of distinct places, keyed by speciesCode → locKey.
	const placesBySpecies = new Map<string, Map<string, SpeciesPlace>>();
	for (const o of obs) {
		if (!o.speciesCode) continue;
		let agg = bySpecies.get(o.speciesCode);
		if (!agg) {
			agg = {
				speciesCode: o.speciesCode,
				comName: o.comName,
				sciName: o.sciName,
				nReports: 0,
				totalCount: 0,
				lastObsDt: o.obsDt,
				locations: [],
				places: [],
				lastLat: o.lat,
				lastLng: o.lng,
				distanceKm: null,
				photoCount: photoCounts.get(o.speciesCode) ?? 0
			};
			bySpecies.set(o.speciesCode, agg);
			placesBySpecies.set(o.speciesCode, new Map());
		}
		agg.nReports++;
		agg.totalCount += o.howMany ?? 1;
		if (o.obsDt > agg.lastObsDt) {
			agg.lastObsDt = o.obsDt;
			agg.lastLat = o.lat;
			agg.lastLng = o.lng;
		}
		if (o.locName && !agg.locations.includes(o.locName) && agg.locations.length < 3) {
			agg.locations.push(o.locName);
		}
		// Track every distinct place (full list powers the inline "all places" view).
		const pmap = placesBySpecies.get(o.speciesCode)!;
		const key = o.locId || `${o.lat},${o.lng}`;
		let pl = pmap.get(key);
		if (!pl) {
			pl = {
				locId: o.locId ?? null,
				locName: o.locName,
				lat: o.lat,
				lng: o.lng,
				lastObsDt: o.obsDt,
				nReports: 0,
				distanceKm: null
			};
			pmap.set(key, pl);
		}
		pl.nReports++;
		if (o.obsDt > pl.lastObsDt) pl.lastObsDt = o.obsDt;
	}
	// Finalize per-species place lists + distances (nearest first when we have an origin).
	for (const [code, agg] of bySpecies) {
		const places = [...placesBySpecies.get(code)!.values()];
		if (home) {
			for (const pl of places) pl.distanceKm = haversineKm(home.lat, home.lon, pl.lat, pl.lng);
			agg.distanceKm = haversineKm(home.lat, home.lon, agg.lastLat, agg.lastLng);
		}
		places.sort((a, b) =>
			home
				? (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9)
				: b.lastObsDt.localeCompare(a.lastObsDt)
		);
		agg.places = places;
	}
	return bySpecies;
}

async function buildView(
	userId: number,
	recent: CachedResult<EbirdObs[]>,
	notable: CachedResult<EbirdObs[]>,
	home: { lat: number; lon: number } | null,
	photoCounts: Map<string, number>
): Promise<TargetsView> {
	const seen = await seenSet(userId);

	const recentAgg = aggregate(recent.data, home, photoCounts);
	const needs = [...recentAgg.values()]
		.filter((a) => !seen.has(a.speciesCode))
		.sort((a, b) => b.nReports - a.nReports || a.comName.localeCompare(b.comName));

	const notableAgg = aggregate(notable.data, home, photoCounts);
	const notableList = [...notableAgg.values()]
		.map((a) => ({ ...a, seen: seen.has(a.speciesCode) }))
		.sort((a, b) => b.lastObsDt.localeCompare(a.lastObsDt));

	return {
		needs,
		notable: notableList,
		bestPlaces: rankPlaces(recent.data, seen, home),
		stale: recent.stale || notable.stale,
		fetchedAt: recent.fetchedAt,
		seenCount: seen.size
	};
}

export async function regionTargets(
	userId: number,
	apiKey: string,
	regionCode: string,
	back: number,
	home: { lat: number; lon: number } | null,
	photoCounts: Map<string, number> = new Map()
): Promise<TargetsView> {
	const [recent, notable] = await Promise.all([
		recentObs(apiKey, regionCode, back),
		notableObs(apiKey, regionCode, back)
	]);
	return buildView(userId, recent, notable, home, photoCounts);
}

/**
 * Targets for an arbitrary location (geo endpoints — no region code needed).
 * Distances are measured from the search center. eBird caps geo dist at 50 km.
 */
export async function geoTargets(
	userId: number,
	apiKey: string,
	lat: number,
	lng: number,
	distKm: number,
	back: number,
	photoCounts: Map<string, number> = new Map()
): Promise<TargetsView> {
	const dist = Math.min(Math.max(distKm, 1), 50);
	const origin = { lat, lon: lng };
	const [recent, notable] = await Promise.all([
		recentNearbyObs(apiKey, lat, lng, dist, back),
		notableNearbyObs(apiKey, lat, lng, dist, back)
	]);
	return buildView(userId, recent, notable, origin, photoCounts);
}

export async function nearbyNeeds(
	userId: number,
	apiKey: string,
	home: { lat: number; lon: number },
	distKm: number,
	back: number,
	photoCounts: Map<string, number> = new Map()
): Promise<{ needs: SpeciesActivity[]; bestPlaces: PlaceRanking[]; stale: boolean; fetchedAt: Date }> {
	const recent = await recentNearbyObs(apiKey, home.lat, home.lon, distKm, back);
	const seen = await seenSet(userId);
	const agg = aggregate(recent.data, home, photoCounts);
	const needs = [...agg.values()]
		.filter((a) => !seen.has(a.speciesCode))
		.sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));
	return {
		needs,
		bestPlaces: rankPlaces(recent.data, seen, home),
		stale: recent.stale,
		fetchedAt: recent.fetchedAt
	};
}

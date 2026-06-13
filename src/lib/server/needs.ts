/**
 * Needs/targets computation: recent eBird observations diffed against the
 * user's seen list. "Rare this week" = the notable feed, each entry badged
 * seen/need against the same list.
 */
import { query } from '$lib/db';
import { haversineKm } from '$lib/geo';
import {
	notableObs,
	recentNearbyObs,
	recentObs,
	type CachedResult,
	type EbirdObs
} from '$server/ebird';

export interface SpeciesActivity {
	speciesCode: string;
	comName: string;
	sciName: string;
	nReports: number;
	totalCount: number;
	lastObsDt: string;
	locations: string[];
	lastLat: number;
	lastLng: number;
	distanceKm: number | null;
	photoCount: number;
}

export interface NotableEntry extends SpeciesActivity {
	seen: boolean;
}

export interface TargetsView {
	needs: SpeciesActivity[];
	notable: NotableEntry[];
	stale: boolean;
	fetchedAt: Date;
	seenCount: number;
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
				lastLat: o.lat,
				lastLng: o.lng,
				distanceKm: null,
				photoCount: photoCounts.get(o.speciesCode) ?? 0
			};
			bySpecies.set(o.speciesCode, agg);
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
	}
	if (home) {
		for (const agg of bySpecies.values()) {
			agg.distanceKm = haversineKm(home.lat, home.lon, agg.lastLat, agg.lastLng);
		}
	}
	return bySpecies;
}

async function buildView(
	userId: number,
	recent: CachedResult<EbirdObs[]>,
	notable: CachedResult<EbirdObs[]>,
	home: { lat: number; lon: number } | null
): Promise<TargetsView> {
	const seen = await seenSet(userId);
	const photoCounts = await (await import('$server/gallery')).photoCountsBySpecies();

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
	home: { lat: number; lon: number } | null
): Promise<TargetsView> {
	const [recent, notable] = await Promise.all([
		recentObs(apiKey, regionCode, back),
		notableObs(apiKey, regionCode, back)
	]);
	return buildView(userId, recent, notable, home);
}

export async function nearbyNeeds(
	userId: number,
	apiKey: string,
	home: { lat: number; lon: number },
	distKm: number,
	back: number
): Promise<{ needs: SpeciesActivity[]; stale: boolean; fetchedAt: Date }> {
	const recent = await recentNearbyObs(apiKey, home.lat, home.lon, distKm, back);
	const seen = await seenSet(userId);
	const photoCounts = await (await import('$server/gallery')).photoCountsBySpecies();
	const agg = aggregate(recent.data, home, photoCounts);
	const needs = [...agg.values()]
		.filter((a) => !seen.has(a.speciesCode))
		.sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));
	return { needs, stale: recent.stale, fetchedAt: recent.fetchedAt };
}

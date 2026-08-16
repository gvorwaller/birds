/**
 * County reference metadata for "click to map" + recognizable-place context
 * (td-01ddb6): official county-equivalent names WITH their suffix (County /
 * Parish / Borough / …) and the county seat, keyed by eBird subnational2
 * code (US-XX-nnn, whose numeric part is the county FIPS code).
 *
 * Source: Wikidata (P882 FIPS 6-4 + P36 seat, en labels), fetched 2026-08-16,
 * filtered against metro/statistical-area contamination and validated to the
 * exact county counts for FL/ME/GA/CA. A handful of inert extra codes exist
 * at FIPS values eBird never emits (historical/CBSA collisions) — lookups
 * are always keyed by an eBird-provided code, so they are unreachable.
 * Seats missing upstream (~3%, mostly AK boroughs / VA independent cities
 * where the "county" IS the city) stay null and the UI simply omits them.
 */
import countyMetaJson from './data/county-meta.json';

export interface CountyMeta {
	/** Official name with suffix, e.g. "Orleans Parish", "Hillsborough County". */
	name: string;
	/** County seat ("Tampa"); null when unknown or not applicable. */
	seat: string | null;
}

const META = countyMetaJson as Record<string, CountyMeta>;

export function countyMeta(code: string): CountyMeta | null {
	return META[code] ?? null;
}

export function countySeat(code: string): string | null {
	return META[code]?.seat ?? null;
}

/**
 * Google-Maps search text that OUTLINES the county on the map — "Alachua
 * County, Florida". When the code is unknown, the eBird-provided name is
 * used UNCHANGED ("Acadia, Louisiana") — never with an invented "County"
 * suffix, which would fabricate the equivalent type for parishes/boroughs/
 * independent cities, exactly the drift the fallback exists for (CODEX1).
 */
export function countyMapQuery(
	code: string,
	fallbackName: string,
	stateName: string
): string {
	const official = META[code]?.name ?? fallbackName;
	return `${official}, ${stateName}`;
}

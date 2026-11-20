/**
 * Sweden connector (td-99eebf): what it reads from Artportalen through SLU
 * Artdatabanken's Species Observation System (SOS) API, and how politely.
 * Plan: docs/2026-11-19-sweden-artportalen-plan-CC.md (Phase 0 findings).
 */

export const SOURCE_ID = 'artportalen';

export const SOS_API = 'https://api.artdatabanken.se/species-observation-system/v1/';
export const USER_AGENT = 'birds-connector-artportalen/1 (+https://github.com/gvorwaller/birds)';
/** Artportalen among SOS's data providers. */
export const DATA_PROVIDER = 1;
/** Aves in Dyntaxa; searched with every taxon under it. */
export const BIRDS_TAXON = 4000104;

/**
 * Request policy. One request at a time. Probe 2026-11-19: Stockholm's May
 * (96,757 reports) read in 40 pages of 2,500 in 98 s, never throttled; the
 * slowest page took 5.6 s. SOS caps a page at 2,500 and a cursor at 2M.
 */
export const PAGE_SIZE = 2500;
export const SOS_MAX_PAGE = 2500;
export const SOS_CURSOR_MAX = 2_000_000;
export const SOS_DEADLINE_MS = 120_000;
export const SOS_MAX_TRIES = 5;
export const SOS_BACKOFF_MAX_MS = 60_000;
/** A month that changes while read is read again this many times in all. */
export const SLICE_READS = 3;
/** A county whose records move between months is read this many times in all. */
export const COUNTY_READS = 3;

/**
 * SOS county featureIds are Sweden's official län numbers (GET /Areas,
 * probe 2026-11-19). Migration 0103 seeds the same pairs into
 * external_region_map; a test keeps the two in step.
 */
export const REGION_TO_COUNTY: Readonly<Record<string, number>> = {
	'SE-AB': 1,
	'SE-C': 3,
	'SE-D': 4,
	'SE-E': 5,
	'SE-F': 6,
	'SE-G': 7,
	'SE-H': 8,
	'SE-I': 9,
	'SE-K': 10,
	'SE-M': 12,
	'SE-N': 13,
	'SE-O': 14,
	'SE-S': 17,
	'SE-T': 18,
	'SE-U': 19,
	'SE-W': 20,
	'SE-X': 21,
	'SE-Y': 22,
	'SE-Z': 23,
	'SE-AC': 24,
	'SE-BD': 25
};

/** The app's county names, as in its regions table. */
export const REGION_NAMES: Readonly<Record<string, string>> = {
	'SE-AB': 'Stockholms län',
	'SE-C': 'Uppsala län',
	'SE-D': 'Södermanlands län',
	'SE-E': 'Östergötlands län',
	'SE-F': 'Jönköpings län',
	'SE-G': 'Kronobergs län',
	'SE-H': 'Kalmar län',
	'SE-I': 'Gotlands län',
	'SE-K': 'Blekinge län',
	'SE-M': 'Skåne län',
	'SE-N': 'Hallands län',
	'SE-O': 'Västra Götalands län',
	'SE-S': 'Värmlands län',
	'SE-T': 'Örebro län',
	'SE-U': 'Västmanlands län',
	'SE-W': 'Dalarnas län',
	'SE-X': 'Gävleborgs län',
	'SE-Y': 'Västernorrlands län',
	'SE-Z': 'Jämtlands län',
	'SE-AC': 'Västerbottens län',
	'SE-BD': 'Norrbottens län'
};

/**
 * Recent candidates are kept only within the latest RECENT_DAYS (14) of the
 * newest report seen so far: no older one can be in the final list (shared
 * aggregate, recentKeepDays). Norway keeps 60.
 */
export const RECENT_KEEP_DAYS_SE = 14;

/** Names sort in Swedish order (å, ä, ö last). */
export const LOCALE = 'sv';

/**
 * The fields asked for: an explicit list (the default "Minimum" set leaves
 * fields out, and SOS drops null fields from every answer).
 */
export const OUTPUT_FIELDS = [
	'occurrence.occurrenceId',
	'occurrence.catalogNumber',
	'occurrence.recordedBy',
	'occurrence.organismQuantityInt',
	'occurrence.organismQuantityUnit',
	'occurrence.occurrenceRemarks',
	'occurrence.activity',
	'occurrence.behavior',
	'occurrence.sex',
	'occurrence.isPositiveObservation',
	'event.plainStartDate',
	'location.decimalLatitude',
	'location.decimalLongitude',
	'location.coordinateUncertaintyInMeters',
	'location.locality',
	'location.municipality',
	'location.county',
	'taxon.id',
	'taxon.scientificName',
	'taxon.vernacularName',
	'taxon.taxonRank',
	'taxon.attributes.redlistCategory',
	'identification.verificationStatus',
	'diffusionStatus',
	'sensitive',
	'modified'
] as const;

/**
 * SOS vocabularies (GET /Vocabularies, 2026-11-19): records carry the Swedish
 * value, so the English one is looked up by id. An id not listed keeps no text.
 */
export const ACTIVITY_EN: Readonly<Record<number, string>> = {
	1: 'nest with egg', 2: 'nest with chick heard', 3: 'breeding failed', 4: 'incubating', 5: 'egg shells',
	6: 'carrying food for young', 7: 'carrying faecal sac', 8: 'visiting occupied nest', 9: 'recently fledged young',
	10: 'recently used nest', 11: 'distraction display', 12: 'nest building', 13: 'brood patch', 14: 'agitated behaviour',
	15: 'visit possible nest?', 16: 'mating/mating ceremonies', 17: 'permanent territory', 18: 'pair in suitable habitat',
	19: 'display/song', 20: 'in nesting habitat', 22: 'staging', 23: 'stationary', 24: 'flying overhead', 25: 'foraging',
	26: 'display / song outside breeding', 27: 'call', 28: 'territory outside breeding', 29: 'ringed', 30: 'individually marked',
	31: 'migration attempt', 32: 'migrating', 33: 'migrating N', 34: 'migrating NE', 35: 'migrating E', 36: 'migrating SE',
	37: 'migrating S', 38: 'migrating SW', 39: 'migrating W', 40: 'migrating NW'
};
export const SEX_EN: Readonly<Record<number, string>> = { 1: 'male', 2: 'female', 3: 'female coloured', 4: 'in pair' };
/** Quantity units that count birds: none given (0) or individuals ("ind.", 9). */
export const INDIVIDUAL_UNITS: ReadonlySet<number> = new Set([0, 9]);

/** A sighting's own page on Artportalen. */
export function sightingUrl(id: string): string {
	return `https://www.artportalen.se/sighting/${id}`;
}

/** A taxon's page on Artfakta (SLU's species facts, incl. the Red List). */
export function taxonUrl(taxonId: string): string {
	return `https://artfakta.se/taxa/${taxonId}`;
}

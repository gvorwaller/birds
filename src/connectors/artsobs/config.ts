/**
 * Norway connector (td-eec7db Phase 2 rev B): what it reads and how politely.
 * Plan: docs/2026-10-21-external-sources-plan-CC.md → "Phase 2 rev B".
 */

export const SOURCE_ID = 'artsobs';

export const ARTSKART_API = 'https://artskart.artsdatabanken.no/publicapi/api/';
export const USER_AGENT = 'birds-connector-artsobs/1 (+https://github.com/gvorwaller/birds)';
/** Artskart's taxon group for birds. */
export const BIRDS_TAXON_GROUP = 8;
/** Artsobservasjoner's bird reports (institution NOF) in Artskart. */
export const COLLECTION = 'so2-birds';

/**
 * Request policy. One request at a time (the 2026-10-26 probe: 144 pages of
 * 10,000 in 27.5 min, never throttled). Pages of 2,000: on Rogaland, the
 * largest county (425,795 records), 5,000-row pages peaked at 538 MB RSS in
 * 9 min 52 s; 2,000-row pages at 487 MB in 7 min 6 s (live, 2026-10-27).
 */
export const PAGE_SIZE = 2000;
export const ARTSKART_DEADLINE_MS = 120_000;
export const ARTSKART_MAX_TRIES = 5;
export const ARTSKART_BACKOFF_MAX_MS = 60_000;
/** A slice that changes while read is read again this many times in all. */
export const SLICE_READS = 3;
/** A county whose records move between slices is read this many times in all. */
export const COUNTY_READS = 3;

/**
 * Artskart's old county numbers are the app's pre-2020 county codes: the
 * filter follows the old boundaries (probe 2026-10-27; plan "Phase 2 rev B").
 * Migration 0096 seeds the same pairs into external_region_map; a test keeps
 * the two in step.
 */
export const REGION_TO_COUNTY: Readonly<Record<string, number>> = {
	'NO-01': 1,
	'NO-02': 2,
	'NO-03': 3,
	'NO-04': 4,
	'NO-05': 5,
	'NO-06': 6,
	'NO-07': 7,
	'NO-08': 8,
	'NO-09': 9,
	'NO-10': 10,
	'NO-11': 11,
	'NO-12': 12,
	'NO-14': 14,
	'NO-15': 15,
	'NO-16': 16,
	'NO-17': 17,
	'NO-18': 18,
	'NO-19': 19,
	'NO-20': 20
};

/** The app's (pre-2020) county names, as in its regions table. */
export const REGION_NAMES: Readonly<Record<string, string>> = {
	'NO-01': 'Østfold',
	'NO-02': 'Akershus',
	'NO-03': 'Oslo',
	'NO-04': 'Hedmark',
	'NO-05': 'Oppland',
	'NO-06': 'Buskerud',
	'NO-07': 'Vestfold',
	'NO-08': 'Telemark',
	'NO-09': 'Aust-Agder',
	'NO-10': 'Vest-Agder',
	'NO-11': 'Rogaland',
	'NO-12': 'Hordaland',
	'NO-14': 'Sogn og Fjordane',
	'NO-15': 'Møre og Romsdal',
	'NO-16': 'Sør-Trøndelag',
	'NO-17': 'Nord-Trøndelag',
	'NO-18': 'Nordland',
	'NO-19': 'Troms',
	'NO-20': 'Finnmark'
};

/** Recent reports: the last 14 days that have data (Phase 0 finding 8). */
export const RECENT_DAYS = 14;
/** Records this far back from the newest date are kept as recent candidates. */
export const RECENT_KEEP_DAYS = 60;
export const MAX_RECENT_ROWS = 20_000;

/** Top localities kept per municipality, ranked by reports then name. */
export const LOCALITIES_PER_PLACE = 25;
/** Phase 0 finding 6: a locality gets a pin only under this rule. */
export const PIN_RADIUS_M = 1000;
export const PIN_SHARE = 0.9;
export const PIN_MAX_UNCERTAINTY_M = 1000;

/** Most active observers kept per place (county and each municipality). */
export const OBSERVERS_PER_PLACE = 25;

/** App side (contract v1). */
export const CLAIM_EVERY_MS = 10_000;
export const HEARTBEAT_EVERY_MS = 60_000;
export const NO_TOKEN_RECHECK_MS = 60_000;
export const INGEST_DEADLINE_MS = 60_000;
export const FINISH_DEADLINE_MS = 300_000;
export const INGEST_MAX_TRIES = 5;
/** Chunk bodies stay well under the app's 256 KB cap. */
export const CHUNK_TARGET_BYTES = 200 * 1024;

/** The report on Artsobservasjoner, by its sighting number; Artskart's own page otherwise. */
export function sightingUrl(catalogNumber: string | null, obsUrl: string | null): string | null {
	if (catalogNumber && /^\d{1,20}$/.test(catalogNumber)) return `https://www.artsobservasjoner.no/Sighting/${catalogNumber}`;
	return obsUrl && /^https:\/\/artskart\.artsdatabanken\.no\/\S+$/.test(obsUrl) && obsUrl.length <= 500 ? obsUrl : null;
}

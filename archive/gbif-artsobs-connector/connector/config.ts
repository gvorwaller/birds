/**
 * Norway connector (td-eec7db Phase 2): what it reads and how politely.
 * Plan: docs/2026-10-21-external-sources-plan-CC.md → "Phase 2" and the
 * Phase 0 findings it cites.
 */

/** Artsobservasjoner's GBIF dataset ("Norwegian Species Observation Service"). */
export const DATASET_KEY = 'b124e1e0-4755-430f-9eab-894f25a9b59c';
/** GBIF backbone class Aves. */
export const BIRDS_TAXON_KEY = 212;
export const SOURCE_ID = 'artsobs-gbif';

export const GBIF_API = 'https://api.gbif.org/v1/';
export const USER_AGENT = 'birds-connector-gbif-artsobs/1 (+https://github.com/gvorwaller/birds)';

/** Phase 0 finding 9: request policy. */
export const GBIF_CONCURRENCY = 2;
export const GBIF_DEADLINE_MS = 30_000;
export const GBIF_MAX_TRIES = 5;
/**
 * Finding 15: GBIF answered 429 during the fourth county read in 30 minutes
 * (~3,000 pages, ~3 GB). A 429 pauses every request, backing off from 15 s
 * to at most 5 min, for up to 8 tries (~25 min) before the load fails.
 */
export const GBIF_429_BASE_MS = 15_000;
export const GBIF_429_MAX_MS = 300_000;
export const GBIF_MAX_429_TRIES = 8;
/** GBIF search returns at most 300 records a page. */
export const PAGE_SIZE = 300;
/**
 * GBIF documents a 100,000-result cap, but measured on 2026-10-23 a page whose
 * offset + limit passes 10,000 stalls mid-body (offset 9,900: 3.7 s; 10,200
 * and deeper: no complete answer within 40 s; shallow pages ~1.4 s). A slice
 * is therefore halved until every page of it ends within the first 10,000.
 */
export const DEEP_PAGING_LIMIT = 10_000;
export const SEARCH_CAP = DEEP_PAGING_LIMIT - PAGE_SIZE;

/**
 * Phase 0 finding 4: GBIF's GADM counties ↔ the app's counties, verified for
 * all 19. Names never drive this (GBIF returns "Ãstfold" for NOR.2_1). The
 * migration seeds the same pairs into external_region_map; a test keeps the
 * two in step.
 */
export const GADM_TO_REGION: Readonly<Record<string, string>> = {
	'NOR.1_1': 'NO-02',
	'NOR.2_1': 'NO-01',
	'NOR.3_1': 'NO-09',
	'NOR.4_1': 'NO-06',
	'NOR.5_1': 'NO-20',
	'NOR.6_1': 'NO-04',
	'NOR.7_1': 'NO-12',
	'NOR.8_1': 'NO-15',
	'NOR.9_1': 'NO-17',
	'NOR.10_1': 'NO-18',
	'NOR.11_1': 'NO-05',
	'NOR.12_1': 'NO-03',
	'NOR.13_1': 'NO-11',
	'NOR.14_1': 'NO-14',
	'NOR.15_1': 'NO-16',
	'NOR.16_1': 'NO-08',
	'NOR.17_1': 'NO-19',
	'NOR.18_1': 'NO-10',
	'NOR.19_1': 'NO-07'
};

export const REGION_TO_GADM: Readonly<Record<string, string>> = Object.fromEntries(
	Object.entries(GADM_TO_REGION).map(([gid, region]) => [region, gid])
);

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

/**
 * A 2024 county (`stateProvince`) is fetched for an app county when at least
 * this many of the app county's GADM-placed records carry it (plan, Phase 2
 * step 1).
 */
export const MIN_STATE_RECORDS = 50;

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

/** Counted results of one 2024-county fetch are reused for this long. */
export const GROUP_CACHE_MS = 24 * 60 * 60 * 1000;
export const GROUP_CACHE_MAX = 2;

/** App side (contract v1). */
export const CLAIM_EVERY_MS = 10_000;
export const HEARTBEAT_EVERY_MS = 60_000;
export const NO_TOKEN_RECHECK_MS = 60_000;
export const INGEST_DEADLINE_MS = 60_000;
export const FINISH_DEADLINE_MS = 300_000;
export const INGEST_MAX_TRIES = 5;
/** Chunk bodies stay well under the app's 256 KB cap. */
export const CHUNK_TARGET_BYTES = 200 * 1024;

export function sightingUrl(catalogNumber: string | null, gbifKey: number): string {
	return catalogNumber && /^\d{1,20}$/.test(catalogNumber)
		? `https://www.artsobservasjoner.no/Sighting/${catalogNumber}`
		: `https://www.gbif.org/occurrence/${gbifKey}`;
}

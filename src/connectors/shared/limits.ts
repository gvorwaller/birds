/**
 * Limits shared by every connector (td-99eebf; moved from artsobs/config.ts
 * unchanged): what a county payload keeps, and the ingest contract timings.
 */

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

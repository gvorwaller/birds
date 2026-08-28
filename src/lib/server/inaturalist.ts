/**
 * iNaturalist gateway for similar-species sourcing (td-460b1c, Phase A).
 *
 * Two endpoints, both public and keyless:
 *  - GET /v1/identifications/similar_species?taxon_id=X — species ranked by
 *    how often real observers misidentified them for the given taxon. This is
 *    the app's confusion-pair source. The endpoint is NOT in iNat's published
 *    v1 docs, so parsing is strict on REQUIRED fields and silent on extras
 *    (the live envelope carries dozens of extra taxon keys — rejecting
 *    unknowns would fail every request).
 *  - GET /v1/taxa?q=<sci>&rank=species — eBird→iNat mapping fallback when
 *    Wikidata P3151 hasn't supplied the id. iNat search is synonym-aware, so
 *    an exact case-insensitive match on the returned canonical `name` is
 *    required before trusting a hit.
 *
 * Terms compliance (plan §Phase 2): identifications are CC BY-NC; the UI must
 * attribute with a live iNaturalist link. Rate norms: ~60 req/min requested,
 * 10k/day. INAT_POLITENESS_MS applies per outbound REQUEST via the caller's
 * single shared limiter — never per unit, and never parallelized.
 */
import { enrichmentUserAgent, parseRetryAfterMs } from '$server/wikidata';

export const INAT_API_BASE = 'https://api.inaturalist.org/v1';
const REQUEST_TIMEOUT_MS = 30_000;
/**
 * Politeness between outbound iNat requests. Measured on prod 2026-08-28: the
 * documented "60/min" is NOT what the API enforces for these endpoints — at
 * ~27 req/min sustained it allowed ~140 requests and then hard-429'd (no
 * Retry-After) for ~30 minutes. 3s spacing (~20/min) keeps the backfill under
 * that ceiling; the loss is ~2h of wall time, not correctness.
 */
export const INAT_POLITENESS_MS = 3000;
/** Raw edges stored per focal after normalization. */
export const INAT_MAX_STORED = 30;

export class InatError extends Error {
	constructor(
		message: string,
		public status: number,
		/** 429 — caller schedules a rate-limit retry (isRateLimitedError shape). */
		public rateLimited: boolean,
		public retryAfterMs: number | null = null
	) {
		super(message);
		this.name = 'InatError';
	}
}

/** One raw similar_species result, required fields only. */
export interface InatSimilarRaw {
	taxonId: number;
	misidCount: number;
	sciName: string;
	comName: string | null;
	rank: string;
	/**
	 * iNat's species-level ancestor id (equals taxonId for rank 'species').
	 * Lets infraspecific results collapse to a REAL species id instead of a
	 * child id that defeats reverse lookups (AGY A2).
	 */
	minSpeciesTaxonId: number | null;
}

/** One normalized, storable edge. */
export interface InatSimilarRow {
	taxonId: number;
	misidCount: number;
	sciName: string;
	comName: string | null;
}

type FetchOpts = { signal?: AbortSignal; fetcher?: typeof fetch };

function providerShape(detail: string): InatError {
	return new InatError(`iNaturalist malformed response: ${detail}`, 0, false);
}

async function inatGet(path: string, opts: FetchOpts): Promise<unknown> {
	const doFetch = opts.fetcher ?? fetch;
	const signal = opts.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	let res: Response;
	try {
		res = await doFetch(`${INAT_API_BASE}${path}`, {
			method: 'GET',
			headers: { Accept: 'application/json', 'User-Agent': enrichmentUserAgent() },
			signal
		});
	} catch (err) {
		throw new InatError(
			`iNaturalist unreachable: ${err instanceof Error ? err.message : 'fetch failed'}`,
			0,
			false
		);
	}
	if (!res.ok) {
		throw new InatError(
			`iNaturalist query failed (HTTP ${res.status})`,
			res.status,
			res.status === 429,
			parseRetryAfterMs(res.headers.get('retry-after'))
		);
	}
	try {
		return await res.json();
	} catch {
		throw providerShape('not JSON');
	}
}

/**
 * Validate ONE similar_species result. Required fields must be present with
 * the right types; unknown keys are ignored (self-review/G9: the live payload
 * carries ~25 extra taxon fields). Returns null for a result that is present
 * but not species-shaped (e.g. a genus-rank row) — the caller counts those as
 * skipped, not as provider errors.
 */
function parseSimilarResult(raw: unknown): InatSimilarRaw {
	if (typeof raw !== 'object' || raw === null) throw providerShape('result not an object');
	const r = raw as Record<string, unknown>;
	if (typeof r.count !== 'number' || !Number.isFinite(r.count)) {
		throw providerShape('result.count missing or not a number');
	}
	if (typeof r.taxon !== 'object' || r.taxon === null) {
		throw providerShape('result.taxon missing');
	}
	const t = r.taxon as Record<string, unknown>;
	if (typeof t.id !== 'number' || typeof t.name !== 'string' || typeof t.rank !== 'string') {
		throw providerShape('result.taxon.{id,name,rank} missing or mistyped');
	}
	return {
		taxonId: t.id,
		misidCount: r.count,
		sciName: t.name,
		comName: typeof t.preferred_common_name === 'string' ? t.preferred_common_name : null,
		rank: t.rank,
		minSpeciesTaxonId: typeof t.min_species_taxon_id === 'number' ? t.min_species_taxon_id : null
	};
}

/** Species most often misidentified as `taxonId`, raw and unfiltered. */
export async function fetchInatSimilarSpecies(
	taxonId: number,
	opts: FetchOpts = {}
): Promise<InatSimilarRaw[]> {
	if (!Number.isInteger(taxonId) || taxonId <= 0) {
		throw new Error(`invalid iNat taxon id: ${taxonId}`);
	}
	const body = await inatGet(
		`/identifications/similar_species?taxon_id=${taxonId}&per_page=100`,
		opts
	);
	if (typeof body !== 'object' || body === null) throw providerShape('body not an object');
	const results = (body as Record<string, unknown>).results;
	if (!Array.isArray(results)) throw providerShape('no results array');
	return results.map(parseSimilarResult);
}

/**
 * Resolve a scientific name to an iNat taxon. Returns the first result whose
 * canonical `name` matches case-insensitively (iNat matches synonyms, so a
 * hit list is not proof — the canonical name must agree), else null.
 */
export async function searchInatTaxonBySciName(
	sciName: string,
	opts: FetchOpts = {}
): Promise<{ taxonId: number; sciName: string } | null> {
	const trimmed = sciName.trim();
	if (trimmed.length < 3) return null;
	const body = await inatGet(
		`/taxa?q=${encodeURIComponent(trimmed)}&rank=species&per_page=30`,
		opts
	);
	if (typeof body !== 'object' || body === null) throw providerShape('body not an object');
	const results = (body as Record<string, unknown>).results;
	if (!Array.isArray(results)) throw providerShape('no results array');
	const wanted = trimmed.toLowerCase();
	for (const raw of results) {
		if (typeof raw !== 'object' || raw === null) continue;
		const t = raw as Record<string, unknown>;
		if (typeof t.id === 'number' && typeof t.name === 'string') {
			if (t.name.trim().toLowerCase() === wanted) return { taxonId: t.id, sciName: t.name.trim() };
		}
	}
	return null;
}

/** Canonical name for a known taxon id (fills species_enrichment.inat_sci_name
 * on the cross-id path, where no search response carried it). */
export async function fetchInatTaxonName(
	taxonId: number,
	opts: FetchOpts = {}
): Promise<{ sciName: string } | null> {
	if (!Number.isInteger(taxonId) || taxonId <= 0) {
		throw new Error(`invalid iNat taxon id: ${taxonId}`);
	}
	const body = await inatGet(`/taxa/${taxonId}`, opts);
	if (typeof body !== 'object' || body === null) throw providerShape('body not an object');
	const results = (body as Record<string, unknown>).results;
	if (!Array.isArray(results) || results.length === 0) return null;
	const t = results[0] as Record<string, unknown>;
	return typeof t.name === 'string' ? { sciName: t.name.trim() } : null;
}

const INFRASPECIFIC_RANKS = new Set(['subspecies', 'variety', 'form']);

/** First two name tokens — the binomial an infraspecific trinomial collapses to. */
function binomialOf(name: string): string {
	return name.trim().split(/\s+/).slice(0, 2).join(' ');
}

/**
 * Pure normalization of raw similar_species results (plan §Phase 2, tightened
 * per CODEX1 F8 + AGY A2):
 *  - rank 'species' kept as-is;
 *  - infraspecific ranks collapse to their binomial, SUMMING counts, keyed by
 *    min_species_taxon_id where iNat provides it (a real species id) and the
 *    highest-count child's id otherwise;
 *  - hybrids and every other rank are dropped (hybrid formula names are
 *    unsafe to token-split);
 *  - focal self-references dropped by id, min-species id, or binomial;
 *  - re-ranked by merged count desc (id asc tiebreak), capped at
 *    INAT_MAX_STORED.
 */
export function normalizeSimilarResults(
	focal: { taxonId: number; sciName: string },
	raw: readonly InatSimilarRaw[]
): InatSimilarRow[] {
	const focalBinomial = binomialOf(focal.sciName).toLowerCase();
	// key = species-level identity (binomial lowercased)
	const merged = new Map<string, InatSimilarRow & { bestChildCount: number }>();

	for (const r of raw) {
		let taxonId: number;
		let sciName: string;
		if (r.rank === 'species') {
			taxonId = r.taxonId;
			sciName = r.sciName.trim();
		} else if (INFRASPECIFIC_RANKS.has(r.rank)) {
			taxonId = r.minSpeciesTaxonId ?? r.taxonId;
			sciName = binomialOf(r.sciName);
		} else {
			continue; // hybrid, genus, complex, …
		}
		if (
			taxonId === focal.taxonId ||
			r.minSpeciesTaxonId === focal.taxonId ||
			sciName.toLowerCase() === focalBinomial
		) {
			continue;
		}
		const key = sciName.toLowerCase();
		const existing = merged.get(key);
		if (!existing) {
			merged.set(key, {
				taxonId,
				misidCount: r.misidCount,
				sciName,
				comName: r.comName,
				bestChildCount: r.misidCount
			});
		} else {
			existing.misidCount += r.misidCount;
			// Prefer a true species id over a child id; else the highest-count
			// contributor's id (deterministic).
			if (r.rank === 'species' || (r.minSpeciesTaxonId !== null && r.misidCount > existing.bestChildCount)) {
				existing.taxonId = taxonId;
				existing.sciName = sciName;
				existing.bestChildCount = r.misidCount;
			}
			if (existing.comName === null && r.comName !== null) existing.comName = r.comName;
		}
	}

	return [...merged.values()]
		.sort((a, b) => b.misidCount - a.misidCount || a.taxonId - b.taxonId)
		.slice(0, INAT_MAX_STORED)
		.map(({ bestChildCount: _drop, ...row }) => row);
}

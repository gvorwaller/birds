/**
 * Wikidata resolution for species enrichment: eBird species code → QID,
 * enwiki article, IUCN status, size facts, cross-IDs. All data CC0.
 * Plan: docs/2026-08-17-species-enrichment-plan.md Phase 1.
 *
 * Property IDs LIVE-VERIFIED 2026-08-17 against query.wikidata.org:
 * P3444 eBird taxon ID · P141 IUCN status · P2067 mass · P2050 wingspan ·
 * P3151 iNaturalist taxon ID · P2426 Xeno-canto species ID.
 *
 * Quantity claims are multi-valued with mixed units (Gray Catbird carries a
 * junk 3.8 g best-rank mass next to real ~36-40 g values) — we aggregate the
 * psn:-NORMALIZED (SI) amounts to MIN/MAX in SPARQL, deterministically, and
 * leave display sanity (spread checks) to the UI layer.
 */
import { env } from '$env/dynamic/private';

export const WIKIDATA_SPARQL_URL = 'https://query.wikidata.org/sparql';
export const WIKIDATA_BATCH_SIZE = 50;
const REQUEST_TIMEOUT_MS = 30_000;

/** Parse a Retry-After header (seconds or HTTP-date), clamped to sane bounds. */
export function parseRetryAfterMs(header: string | null): number | null {
	if (!header) return null;
	const MAX_MS = 2 * 60 * 60_000;
	const secs = Number(header);
	if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_MS);
	const when = Date.parse(header);
	if (Number.isFinite(when)) return Math.min(Math.max(when - Date.now(), 0), MAX_MS);
	return null;
}

export class WikidataError extends Error {
	constructor(
		message: string,
		public status: number,
		/** 429 or explicit throttle — caller schedules a rate-limit retry. */
		public rateLimited: boolean,
		/** Parsed Retry-After when the server sent one (CODEX1 P2 #6). */
		public retryAfterMs: number | null = null
	) {
		super(message);
		this.name = 'WikidataError';
	}
}

export interface WikidataSpeciesRow {
	speciesCode: string;
	qid: string;
	/** enwiki article title (from the sitelink URL), null when no article. */
	enwikiTitle: string | null;
	iucnStatus: string | null;
	/** kg, normalized; null when no claim. */
	massKgMin: number | null;
	massKgMax: number | null;
	/** metres, normalized. */
	wingspanMMin: number | null;
	wingspanMMax: number | null;
	inatTaxonId: string | null;
	xenoCantoId: string | null;
}

/** Codes must be eBird-shaped before they reach a query we string-build. */
const CODE_RE = /^[a-z][a-z0-9-]{1,14}$/;

export function validSpeciesCode(code: string): boolean {
	return CODE_RE.test(code);
}

/**
 * Pure query builder (unit-tested). GROUP BY collapses multi-valued claims:
 * quantities via normalized MIN/MAX, identifiers via deterministic MIN (SAMPLE
 * is nondeterministic — CODEX1 plan review), sitelink via MIN of the URL.
 */
export function buildSpeciesSparql(codes: readonly string[]): string {
	const bad = codes.filter((c) => !validSpeciesCode(c));
	if (bad.length > 0) throw new Error(`invalid species codes: ${bad.slice(0, 3).join(', ')}`);
	const values = codes.map((c) => `"${c}"`).join(' ');
	return `SELECT ?ebird ?item
  (MIN(STR(?articleUrl)) AS ?article)
  (MIN(?iucnLabel) AS ?iucn)
  (MIN(?massKg) AS ?massMin) (MAX(?massKg) AS ?massMax)
  (MIN(?wsM) AS ?wsMin) (MAX(?wsM) AS ?wsMax)
  (MIN(?inatId) AS ?inat) (MIN(?xcId) AS ?xc)
WHERE {
  VALUES ?ebird { ${values} }
  ?item wdt:P3444 ?ebird .
  OPTIONAL { ?item wdt:P141 ?iucnItem .
             ?iucnItem rdfs:label ?iucnLabel . FILTER(LANG(?iucnLabel) = "en") }
  OPTIONAL { ?item p:P2067 ?massSt . ?massSt a wikibase:BestRank ;
             psn:P2067/wikibase:quantityAmount ?massKg . }
  OPTIONAL { ?item p:P2050 ?wsSt . ?wsSt a wikibase:BestRank ;
             psn:P2050/wikibase:quantityAmount ?wsM . }
  OPTIONAL { ?item wdt:P3151 ?inatId . }
  OPTIONAL { ?item wdt:P2426 ?xcId . }
  OPTIONAL { ?articleUrl schema:about ?item ;
             schema:isPartOf <https://en.wikipedia.org/> . }
}
GROUP BY ?ebird ?item`;
}

/**
 * Shared User-Agent for ALL enrichment provider gateways (Wikidata,
 * Wikipedia, Commons, xeno-canto) — one place to change the contact/policy.
 */
export function enrichmentUserAgent(): string {
	const contact = env.ENRICHMENT_CONTACT ?? 'gaylon@vorwaller.net';
	return `birds.gaylon.photos species enrichment (${contact})`;
}

/**
 * Structural rate-limit check across the provider error classes
 * (WikidataError, WikipediaError, CommonsError, XenoCantoError all carry
 * `rateLimited`/`retryAfterMs`) — a new provider's error joins automatically
 * instead of growing an instanceof union at every consumer.
 */
export function isRateLimitedError(
	err: unknown
): err is Error & { rateLimited: true; retryAfterMs: number | null } {
	return (
		err instanceof Error &&
		'rateLimited' in err &&
		(err as { rateLimited?: unknown }).rateLimited === true &&
		'retryAfterMs' in err
	);
}

function numOrNull(v: string | undefined): number | null {
	if (v == null) return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

/** enwiki URL → decoded article title ("…/wiki/Marbled_godwit" → "Marbled godwit"). */
export function titleFromArticleUrl(url: string | null): string | null {
	if (!url) return null;
	const m = /\/wiki\/(.+)$/.exec(url);
	if (!m) return null;
	try {
		return decodeURIComponent(m[1]).replace(/_/g, ' ');
	} catch {
		return null;
	}
}

export interface SparqlBinding {
	[k: string]: { value: string } | undefined;
}

/**
 * Resolve one batch (≤50 codes) of species against Wikidata. Codes absent
 * from the result have NO P3444 mapping (the caller records 'no_mapping' —
 * distinct from a transient failure, which throws).
 */
async function runSparql(
	queryText: string,
	opts: { signal?: AbortSignal; fetcher?: typeof fetch }
): Promise<SparqlBinding[]> {
	const doFetch = opts.fetcher ?? fetch;
	const signal = opts.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	let res: Response;
	try {
		res = await doFetch(WIKIDATA_SPARQL_URL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				Accept: 'application/sparql-results+json',
				'User-Agent': enrichmentUserAgent()
			},
			body: new URLSearchParams({ query: queryText }),
			signal
		});
	} catch (err) {
		throw new WikidataError(
			`Wikidata unreachable: ${err instanceof Error ? err.message : 'fetch failed'}`,
			0,
			false
		);
	}
	if (!res.ok) {
		throw new WikidataError(
			`Wikidata query failed (HTTP ${res.status})`,
			res.status,
			res.status === 429,
			parseRetryAfterMs(res.headers.get('retry-after'))
		);
	}
	const body = (await res.json()) as { results?: { bindings?: SparqlBinding[] } };
	return body.results?.bindings ?? [];
}

export async function fetchWikidataBatch(
	codes: readonly string[],
	opts: { signal?: AbortSignal; fetcher?: typeof fetch } = {}
): Promise<Map<string, WikidataSpeciesRow>> {
	if (codes.length === 0) return new Map();
	if (codes.length > WIKIDATA_BATCH_SIZE) {
		throw new Error(`batch too large: ${codes.length} > ${WIKIDATA_BATCH_SIZE}`);
	}
	return parseSparqlBindings(await runSparql(buildSpeciesSparql(codes), opts));
}

/**
 * Scientific-name fallback (td-e64d93): after an eBird taxonomy split, the
 * NEW code has no P3444 anywhere on Wikidata yet (Gull-billed Tern: eBird
 * split gubter → gubter2, Q18834 still carries P3444 = gubter1), so the
 * primary lookup reports no_mapping forever. The binomial is stable across
 * such splits — resolve the leftovers by taxon name (P225) instead.
 * Names never reach the query unvalidated (letters/space/hyphen/period
 * only) — same string-building discipline as the code path.
 */
const SCI_NAME_RE = /^[A-Za-z][A-Za-z .-]{2,60}$/;

export function validSciName(name: string): boolean {
	return SCI_NAME_RE.test(name);
}

export function buildSciNameSparql(names: readonly string[]): string {
	const bad = names.filter((n) => !validSciName(n));
	if (bad.length > 0) throw new Error(`invalid sci names: ${bad.slice(0, 3).join(', ')}`);
	const values = names.map((n) => `"${n}"`).join(' ');
	return `SELECT ?sci ?item
  (MIN(STR(?articleUrl)) AS ?article)
  (MIN(?iucnLabel) AS ?iucn)
  (MIN(?massKg) AS ?massMin) (MAX(?massKg) AS ?massMax)
  (MIN(?wsM) AS ?wsMin) (MAX(?wsM) AS ?wsMax)
  (MIN(?inatId) AS ?inat) (MIN(?xcId) AS ?xc)
WHERE {
  VALUES ?sci { ${values} }
  ?item wdt:P225 ?sci .
  OPTIONAL { ?item wdt:P141 ?iucnItem .
             ?iucnItem rdfs:label ?iucnLabel . FILTER(LANG(?iucnLabel) = "en") }
  OPTIONAL { ?item p:P2067 ?massSt . ?massSt a wikibase:BestRank ;
             psn:P2067/wikibase:quantityAmount ?massKg . }
  OPTIONAL { ?item p:P2050 ?wsSt . ?wsSt a wikibase:BestRank ;
             psn:P2050/wikibase:quantityAmount ?wsM . }
  OPTIONAL { ?item wdt:P3151 ?inatId . }
  OPTIONAL { ?item wdt:P2426 ?xcId . }
  OPTIONAL { ?articleUrl schema:about ?item ;
             schema:isPartOf <https://en.wikipedia.org/> . }
}
GROUP BY ?sci ?item`;
}

/**
 * Resolve species by scientific name; returns a map keyed by the CALLER'S
 * eBird code (rows carry that code, not the name). Invalid names are
 * skipped, never sent. Duplicate-QID resolution matches the primary path
 * (lowest QID wins, per name).
 */
export async function fetchWikidataBySciName(
	pairs: readonly { code: string; sciName: string }[],
	opts: { signal?: AbortSignal; fetcher?: typeof fetch } = {}
): Promise<Map<string, WikidataSpeciesRow>> {
	const usable = pairs.filter((p) => validSciName(p.sciName));
	if (usable.length === 0) return new Map();
	if (usable.length > WIKIDATA_BATCH_SIZE) {
		throw new Error(`batch too large: ${usable.length} > ${WIKIDATA_BATCH_SIZE}`);
	}
	const bindings = await runSparql(
		buildSciNameSparql(usable.map((p) => p.sciName)),
		opts
	);
	const byName = parseSparqlBindings(bindings, 'sci');
	const out = new Map<string, WikidataSpeciesRow>();
	for (const p of usable) {
		const row = byName.get(p.sciName);
		if (row) out.set(p.code, { ...row, speciesCode: p.code });
	}
	return out;
}

// ---------------------------------------------------------------------------
// Media (P18/P51) — field-guide sample photos and sounds (td-86a2b6)
// ---------------------------------------------------------------------------

/**
 * SPARQL for image (P18) and audio (P51) filenames by QID.
 * Returns Commons filenames, NOT URLs — caller uses Commons imageinfo
 * API to get actual media URLs, dimensions, license, artist.
 * Multi-valued claims are collapsed via MIN for determinism.
 */
export function buildMediaSparql(qids: readonly string[]): string {
	const bad = qids.filter((q) => !/^Q\d+$/.test(q));
	if (bad.length > 0) throw new Error(`invalid QIDs: ${bad.slice(0, 3).join(', ')}`);
	const values = qids.map((q) => `wd:${q}`).join(' ');
	return `SELECT ?item
  (MIN(?imgFile) AS ?image)
  (MIN(?audioFile) AS ?audio)
WHERE {
  VALUES ?item { ${values} }
  OPTIONAL { ?item wdt:P18 ?imgFile . }
  OPTIONAL { ?item wdt:P51 ?audioFile . }
}
GROUP BY ?item`;
}

export interface WikidataMediaRow {
	qid: string;
	/** Commons filename from P18 (e.g. "Marbled Godwit RWD.jpg"), not a URL. */
	imageFilename: string | null;
	/** Commons filename from P51, not a URL. */
	audioFilename: string | null;
}

/**
 * P18/P51 values arrive from WDQS as Special:FilePath URIs (e.g.
 * "http://commons.wikimedia.org/wiki/Special:FilePath/Marbled%20Godwit%20RWD.jpg")
 * — the filename segment is percent-encoded with literal spaces, NOT
 * underscored like enwiki article URLs, so no underscore substitution here.
 */
function filenameFromCommonsUri(uri: string | undefined): string | null {
	if (!uri) return null;
	const m = /\/([^/]+)$/.exec(uri);
	if (!m) return null;
	try {
		return decodeURIComponent(m[1]);
	} catch {
		return null;
	}
}

/**
 * Resolve one batch (≤50 QIDs) of P18/P51 Commons filenames. A QID absent
 * from the result had neither claim — the caller treats that as "no media
 * from Wikidata", distinct from a transient failure (which throws).
 */
export async function fetchWikidataMedia(
	qids: readonly string[],
	opts: { signal?: AbortSignal; fetcher?: typeof fetch } = {}
): Promise<Map<string, WikidataMediaRow>> {
	if (qids.length === 0) return new Map();
	if (qids.length > WIKIDATA_BATCH_SIZE) {
		throw new Error(`batch too large: ${qids.length} > ${WIKIDATA_BATCH_SIZE}`);
	}
	const bindings = await runSparql(buildMediaSparql(qids), opts);
	const out = new Map<string, WikidataMediaRow>();
	for (const b of bindings) {
		const item = b.item?.value;
		if (!item) continue;
		const qid = item.replace(/^.*\/(Q\d+)$/, '$1');
		out.set(qid, {
			qid,
			imageFilename: filenameFromCommonsUri(b.image?.value),
			audioFilename: filenameFromCommonsUri(b.audio?.value)
		});
	}
	return out;
}

/**
 * Pure binding parser (fixture-tested). A code can map to duplicate QIDs
 * (constraint violations happen) and endpoint row order is nondeterministic —
 * the row with the numerically LOWEST QID wins, regardless of arrival order
 * (CODEX1 P1 #4: deterministic duplicate resolution, never row-order wins).
 */
export function parseSparqlBindings(
	bindings: readonly SparqlBinding[],
	keyVar: 'ebird' | 'sci' = 'ebird'
): Map<string, WikidataSpeciesRow> {
	const out = new Map<string, WikidataSpeciesRow>();
	const qidNum = (qid: string) => Number(qid.replace(/^Q/, '')) || Number.MAX_SAFE_INTEGER;
	for (const b of bindings) {
		const code = b[keyVar]?.value;
		const item = b.item?.value;
		if (!code || !item) continue;
		const row: WikidataSpeciesRow = {
			speciesCode: code,
			qid: item.replace(/^.*\/(Q\d+)$/, '$1'),
			enwikiTitle: titleFromArticleUrl(b.article?.value ?? null),
			iucnStatus: b.iucn?.value ?? null,
			massKgMin: numOrNull(b.massMin?.value),
			massKgMax: numOrNull(b.massMax?.value),
			wingspanMMin: numOrNull(b.wsMin?.value),
			wingspanMMax: numOrNull(b.wsMax?.value),
			inatTaxonId: b.inat?.value ?? null,
			xenoCantoId: b.xc?.value ?? null
		};
		const existing = out.get(code);
		if (!existing || qidNum(row.qid) < qidNum(existing.qid)) out.set(code, row);
	}
	return out;
}

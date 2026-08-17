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

export class WikidataError extends Error {
	constructor(
		message: string,
		public status: number,
		/** 429 or explicit throttle — caller schedules a rate-limit retry. */
		public rateLimited: boolean
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
  OPTIONAL { ?item p:P2067/psn:P2067/wikibase:quantityAmount ?massKg . }
  OPTIONAL { ?item p:P2050/psn:P2050/wikibase:quantityAmount ?wsM . }
  OPTIONAL { ?item wdt:P3151 ?inatId . }
  OPTIONAL { ?item wdt:P2426 ?xcId . }
  OPTIONAL { ?articleUrl schema:about ?item ;
             schema:isPartOf <https://en.wikipedia.org/> . }
}
GROUP BY ?ebird ?item`;
}

function userAgent(): string {
	const contact = env.ENRICHMENT_CONTACT ?? 'gaylon@vorwaller.net';
	return `birds.gaylon.photos species enrichment (${contact})`;
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

interface SparqlBinding {
	[k: string]: { value: string } | undefined;
}

/**
 * Resolve one batch (≤50 codes) of species against Wikidata. Codes absent
 * from the result have NO P3444 mapping (the caller records 'no_mapping' —
 * distinct from a transient failure, which throws).
 */
export async function fetchWikidataBatch(
	codes: readonly string[],
	opts: { signal?: AbortSignal; fetcher?: typeof fetch } = {}
): Promise<Map<string, WikidataSpeciesRow>> {
	if (codes.length === 0) return new Map();
	if (codes.length > WIKIDATA_BATCH_SIZE) {
		throw new Error(`batch too large: ${codes.length} > ${WIKIDATA_BATCH_SIZE}`);
	}
	const doFetch = opts.fetcher ?? fetch;
	const signal = opts.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	let res: Response;
	try {
		res = await doFetch(WIKIDATA_SPARQL_URL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				Accept: 'application/sparql-results+json',
				'User-Agent': userAgent()
			},
			body: new URLSearchParams({ query: buildSpeciesSparql(codes) }),
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
		throw new WikidataError(`Wikidata query failed (HTTP ${res.status})`, res.status, res.status === 429);
	}
	const body = (await res.json()) as { results?: { bindings?: SparqlBinding[] } };
	const out = new Map<string, WikidataSpeciesRow>();
	for (const b of body.results?.bindings ?? []) {
		const code = b.ebird?.value;
		const item = b.item?.value;
		if (!code || !item) continue;
		// Defensive: a code could theoretically map to 2 items — first
		// (deterministic row order not guaranteed) wins, keep the earliest QID.
		if (out.has(code)) continue;
		out.set(code, {
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
		});
	}
	return out;
}

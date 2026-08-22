/**
 * Single DB gateway for species_enrichment (plan:
 * docs/2026-08-17-species-enrichment-plan.md). Stage-separated writes:
 * resolution (Wikidata), wiki (prose), ai (Phase 2) — a failure in one stage
 * only stamps that stage's status/error and NEVER clears another stage's good
 * data (CODEX1 #3).
 *
 * search_tsv covers enrichment-owned text ONLY (tags/extract/field_craft/
 * sections) — names deliberately live outside the vector so taxonomy renames
 * can't leave stale lexemes (CODEX1 #4). Every writer recomputes it via the
 * same upsert→UPDATE CTE so both stages keep it correct atomically.
 */
import { query, withTransaction } from '$lib/db';
import type pg from 'pg';

/**
 * Writers accept an injectable executor so enrichOneNow can commit its whole
 * persistence phase in ONE transaction (CODEX1 td-b7d021 blocker #2); the
 * default is the autocommit pool query the worker path uses.
 */
type Exec = <T extends pg.QueryResultRow = pg.QueryResultRow>(
	text: string,
	params?: unknown[]
) => Promise<{ rows: T[] }>;
const clientExec = (client: pg.PoolClient): Exec => ((text, params) =>
	client.query(text, params as never[])) as Exec;
import { sanitizeErrorText } from '$server/job-policy';
import type { WikidataSpeciesRow } from '$server/wikidata';
import { fetchWikidataBatch, fetchWikidataBySciName, validSciName } from '$server/wikidata';
import type { WikiArticle } from '$server/wikipedia';
import { articleUrl, fetchArticlePlaintext } from '$server/wikipedia';

export const WIKI_REFRESH_DAYS = 180;
export const ERROR_RETRY_DAYS = 7;

/**
 * search_tsv is computed INSIDE each writing statement, mixing the values
 * being written with the row's other-stage columns. It cannot be a follow-up
 * CTE UPDATE: a data-modifying CTE's effects are invisible to the outer
 * statement (same snapshot) — caught by the DB contract test.
 */
function tsvExpr(parts: { tags: string; prose: string; sections: string }): string {
	return `
	    setweight(to_tsvector('english', translate(${parts.tags}, ':-', '  ')), 'A')
	 || setweight(to_tsvector('english', ${parts.prose}), 'B')
	 || setweight(to_tsvector('english', coalesce(
	      (SELECT string_agg(s->>'text', ' ') FROM jsonb_array_elements(${parts.sections}) s), '')), 'C')`;
}

/** IUCN label (Wikidata English) → Red List code; unknown labels pass through. */
const IUCN_CODES: Record<string, string> = {
	'least concern': 'LC',
	'near threatened': 'NT',
	vulnerable: 'VU',
	endangered: 'EN',
	'critically endangered': 'CR',
	'extinct in the wild': 'EW',
	extinct: 'EX',
	'data deficient': 'DD',
	'conservation dependent': 'CD'
};

export function iucnCode(label: string | null): string | null {
	if (!label) return null;
	return IUCN_CODES[label.toLowerCase()] ?? label;
}

export interface EnrichmentFacts {
	mass_g_min?: number;
	mass_g_max?: number;
	wingspan_cm_min?: number;
	wingspan_cm_max?: number;
}

export interface EnrichmentCrossIds {
	inat_taxon_id?: string;
	xeno_canto_id?: string;
}

function round1(n: number): number {
	return Math.round(n * 10) / 10;
}

export function factsFromWikidata(row: WikidataSpeciesRow): EnrichmentFacts {
	const f: EnrichmentFacts = {};
	if (row.massKgMin != null) f.mass_g_min = round1(row.massKgMin * 1000);
	if (row.massKgMax != null) f.mass_g_max = round1(row.massKgMax * 1000);
	if (row.wingspanMMin != null) f.wingspan_cm_min = round1(row.wingspanMMin * 100);
	if (row.wingspanMMax != null) f.wingspan_cm_max = round1(row.wingspanMMax * 100);
	return f;
}

/**
 * Record the Wikidata resolution outcome for one code. `row = null` means the
 * batch answered and this code has NO P3444 mapping — a data state, distinct
 * from a transient failure (which never reaches this function).
 */
export async function upsertResolution(
	code: string,
	row: WikidataSpeciesRow | null,
	exec: Exec = query
): Promise<void> {
	if (row == null) {
		await exec(
			`INSERT INTO species_enrichment (species_code, resolution)
			 VALUES ($1, 'no_mapping')
			 ON CONFLICT (species_code) DO UPDATE SET resolution = 'no_mapping', updated_at = NOW()`,
			[code]
		);
		return;
	}
	const resolution = row.enwikiTitle ? 'mapped' : 'no_sitelink';
	const crossIds: EnrichmentCrossIds = {};
	if (row.inatTaxonId) crossIds.inat_taxon_id = row.inatTaxonId;
	if (row.xenoCantoId) crossIds.xeno_canto_id = row.xenoCantoId;
	await exec(
		`INSERT INTO species_enrichment
		   (species_code, wikidata_qid, resolution, iucn_status, facts, cross_ids)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 ON CONFLICT (species_code) DO UPDATE SET
		   wikidata_qid = $2, resolution = $3, iucn_status = $4,
		   facts = $5, cross_ids = $6, updated_at = NOW()`,
		[
			code,
			row.qid,
			resolution,
			iucnCode(row.iucnStatus),
			JSON.stringify(factsFromWikidata(row)),
			JSON.stringify(crossIds)
		]
	);
}

/** Store fetched article prose; stamps the wiki freshness clock. */
export async function upsertWikiOk(
	code: string,
	article: WikiArticle,
	exec: Exec = query
): Promise<void> {
	// INSERT branch: fresh row has no tags/field_craft yet. UPDATE branch mixes
	// the new prose ($5/$6) with the EXISTING row's AI-stage text so the vector
	// always reflects the post-write row.
	const insertTsv = tsvExpr({
		tags: `''`,
		prose: `coalesce($5, '')`,
		sections: `$6::jsonb`
	});
	const updateTsv = tsvExpr({
		tags: `array_to_string(species_enrichment.tags, ' ')`,
		prose: `coalesce($5, '') || ' ' || coalesce(species_enrichment.field_craft, '')`,
		sections: `$6::jsonb`
	});
	await exec(
		`INSERT INTO species_enrichment
		   (species_code, wikipedia_title, wikipedia_url, wikipedia_rev_id,
		    wikipedia_extract, wikipedia_sections, wiki_status, wiki_error,
		    wiki_fetched_at, wiki_ok_at, search_tsv)
		 VALUES ($1, $2, $3, $4, $5, $6, 'ok', NULL, NOW(), NOW(), ${insertTsv})
		 ON CONFLICT (species_code) DO UPDATE SET
		   wikipedia_title = $2, wikipedia_url = $3, wikipedia_rev_id = $4,
		   wikipedia_extract = $5, wikipedia_sections = $6,
		   wiki_status = 'ok', wiki_error = NULL, wiki_fetched_at = NOW(),
		   wiki_ok_at = NOW(), search_tsv = ${updateTsv}, updated_at = NOW()`,
		[
			code,
			article.title,
			articleUrl(article.title),
			article.revId,
			article.extract,
			JSON.stringify(article.sections)
		]
	);
}

/**
 * The article does not exist — a terminal data state with the SAME freshness
 * clock as ok (so absent articles are not re-fetched daily; CODEX1 #9).
 * CLEARS any previously stored Wikipedia-owned prose (an ok→no_article
 * transition means the article is gone — rendering the obsolete text would
 * contradict the persisted terminal state; CODEX1 round 3). AI-owned fields
 * survive; the search vector is recomputed over what remains.
 */
export async function markWikiNoArticle(code: string, exec: Exec = query): Promise<void> {
	const tsv = tsvExpr({
		tags: `array_to_string(species_enrichment.tags, ' ')`,
		prose: `coalesce(species_enrichment.field_craft, '')`,
		sections: `'[]'::jsonb`
	});
	await exec(
		`INSERT INTO species_enrichment (species_code, wiki_status, wiki_error, wiki_fetched_at)
		 VALUES ($1, 'no_article', NULL, NOW())
		 ON CONFLICT (species_code) DO UPDATE SET
		   wiki_status = 'no_article', wiki_error = NULL, wiki_fetched_at = NOW(),
		   wikipedia_title = NULL, wikipedia_url = NULL, wikipedia_rev_id = NULL,
		   wikipedia_extract = NULL, wikipedia_sections = '[]'::jsonb,
		   wiki_ok_at = NULL, search_tsv = ${tsv}, updated_at = NOW()`,
		[code]
	);
}

/**
 * Wiki-stage failure: stamps status/error/clock ONLY — existing prose columns
 * are untouched, so the last good revision keeps serving (CODEX1 #3).
 */
export async function markWikiError(code: string, message: string): Promise<void> {
	await query(
		`INSERT INTO species_enrichment (species_code, wiki_status, wiki_error, wiki_fetched_at)
		 VALUES ($1, 'error', $2, NOW())
		 ON CONFLICT (species_code) DO UPDATE SET
		   wiki_status = 'error', wiki_error = $2, wiki_fetched_at = NOW(),
		   updated_at = NOW()`,
		[code, sanitizeErrorText(message).slice(0, 500)]
	);
}

/** Phase 2 writer — present now so the schema/tsv contract is complete. */
export async function upsertAiData(
	code: string,
	data: { fieldCraft: string; tags: string[]; model: string; sourceRevId: number }
): Promise<void> {
	// SET expressions read the OLD row for untouched columns, so mixing the
	// new tags/field_craft params with the stored extract/sections is correct.
	const tsv = tsvExpr({
		tags: `array_to_string($3::text[], ' ')`,
		prose: `coalesce(wikipedia_extract, '') || ' ' || coalesce($2, '')`,
		sections: `wikipedia_sections`
	});
	await query(
		`UPDATE species_enrichment SET
		   field_craft = $2, tags = $3::text[], ai_model = $4, ai_generated_at = NOW(),
		   ai_source_rev_id = $5, ai_status = 'ok', ai_error = NULL,
		   ai_attempted_at = NOW(), search_tsv = ${tsv}, updated_at = NOW()
		 WHERE species_code = $1`,
		[code, data.fieldCraft, data.tags, data.model, data.sourceRevId]
	);
}

export async function markAiError(code: string, message: string): Promise<void> {
	await query(
		`UPDATE species_enrichment SET
		   ai_status = 'error', ai_error = $2, ai_attempted_at = NOW(), updated_at = NOW()
		 WHERE species_code = $1`,
		[code, sanitizeErrorText(message).slice(0, 500)]
	);
}

/**
 * The in-scope species universe (CODEX1 #9 contract): DISTINCT codes from
 * seen ∪ frequency ∪ photos (NULLs removed), category='species' applied ONCE
 * via taxonomy.
 */
const SCOPE_SQL = `
  SELECT DISTINCT tc.species_code
    FROM taxonomy_cache tc
   WHERE tc.category = 'species'
     AND tc.species_code IN (
           SELECT species_code FROM seen_species
           UNION
           SELECT species_code FROM species_frequency
           UNION
           SELECT species_code FROM photo_links WHERE species_code IS NOT NULL
         )`;

/** In-scope codes never wiki-attempted (no row, or row without a clock). */
export async function enrichmentScope(): Promise<string[]> {
	const r = await query<{ species_code: string }>(
		`${SCOPE_SQL}
		 AND NOT EXISTS (
		   SELECT 1 FROM species_enrichment se
		    WHERE se.species_code = tc.species_code AND se.wiki_fetched_at IS NOT NULL
		 )
		 ORDER BY 1`
	);
	return r.rows.map((x) => x.species_code);
}

/**
 * In-scope codes whose WIKI stage is stale: refresh window (180d) or error
 * retry window (7d). AI-due codes are a SEPARATE partition (aiDueCodes) so
 * the scanner can enqueue them as aiOnly chunks that never touch WDQS or
 * Wikipedia (CODEX1 Phase-2 P1 #2).
 */
export async function wikiStaleCodes(): Promise<string[]> {
	const r = await query<{ species_code: string }>(
		`${SCOPE_SQL}
		 AND EXISTS (
		   SELECT 1 FROM species_enrichment se
		    WHERE se.species_code = tc.species_code
		      AND (
		            (se.wiki_status IN ('ok','no_article')
		             AND se.wiki_fetched_at < NOW() - INTERVAL '${WIKI_REFRESH_DAYS} days')
		         OR (se.wiki_status = 'error'
		             AND se.wiki_fetched_at < NOW() - INTERVAL '${ERROR_RETRY_DAYS} days')
		         -- Split survivors: no_mapping now has a real resolution chance
		         -- (sci-name fallback), so it retries WEEKLY instead of waiting
		         -- out the 180d clock. Bounded: each attempt re-stamps the
		         -- clock, so it's at most one fallback query per species per
		         -- week until Wikidata maps it (GROK on 4694222 — the reported
		         -- gubter2 row was otherwise frozen for 180 days).
		         OR (se.resolution = 'no_mapping'
		             AND se.wiki_fetched_at < NOW() - INTERVAL '${ERROR_RETRY_DAYS} days')
		         -- no_sitelink MISSES only (GROK pin d): a binomial-redirect HIT
		         -- has wiki_status='ok' and rides the normal 180d refresh; only
		         -- rows where the fallback also came up empty retry weekly, and
		         -- each attempt re-stamps the clock (same anti-loop as above).
		         OR (se.resolution = 'no_sitelink'
		             AND se.wiki_status IS DISTINCT FROM 'ok'
		             AND se.wiki_fetched_at < NOW() - INTERVAL '${ERROR_RETRY_DAYS} days')
		      )
		 )
		 ORDER BY 1`
	);
	return r.rows.map((x) => x.species_code);
}

/**
 * In-scope codes whose wiki data is CURRENT but whose AI stage is due:
 * never annotated, behind the stored revision, or an error past its retry
 * window. Only meaningful when the AI stage is enabled (CODEX1 #6 —
 * callers gate).
 */
export async function aiDueCodes(): Promise<string[]> {
	const r = await query<{ species_code: string }>(
		`${SCOPE_SQL}
		 AND EXISTS (
		   SELECT 1 FROM species_enrichment se
		    WHERE se.species_code = tc.species_code
		      AND se.wiki_status = 'ok' AND se.wikipedia_extract IS NOT NULL
		      AND se.wiki_fetched_at >= NOW() - INTERVAL '${WIKI_REFRESH_DAYS} days'
		      AND (
		            se.ai_status IS NULL
		         OR (se.ai_status = 'ok' AND se.ai_source_rev_id IS DISTINCT FROM se.wikipedia_rev_id)
		         OR (se.ai_status = 'error' AND se.ai_attempted_at < NOW() - INTERVAL '${ERROR_RETRY_DAYS} days')
		      )
		 )
		 ORDER BY 1`
	);
	return r.rows.map((x) => x.species_code);
}

/**
 * The ONE place that decides which Wikipedia page to fetch for a resolved
 * Wikidata row (GROK pin d — action and worker must never diverge): the
 * enwiki sitelink when Wikidata has one, else the scientific name (enwiki
 * redirects binomials to the species article; fetchArticlePlaintext sends
 * redirects=1 and returns the RESOLVED page title, which is what gets
 * stored — never the eBird common name). Returns null when there is
 * nothing safe to try.
 */
export function wikiFetchTitleFor(
	row: WikidataSpeciesRow,
	sciName: string | null
): { title: string; viaFallback: boolean } | null {
	if (row.enwikiTitle) return { title: row.enwikiTitle, viaFallback: false };
	if (sciName && validSciName(sciName)) return { title: sciName, viaFallback: true };
	return null;
}

export type EnrichNowResult =
	| { outcome: 'ok'; title: string; viaFallback: boolean; aiDue: boolean }
	| { outcome: 'no_article' }
	| { outcome: 'no_mapping' }
	| { outcome: 'transient' };

/** Hard wall-clock ceiling for the interactive refresh (GROK pin c). */
export const ENRICH_NOW_BUDGET_MS = 20_000;

const inFlight = new Map<string, Promise<EnrichNowResult>>();

/**
 * Per-process promise coalescing (td-0753d0): concurrent first-load clicks
 * for the same species share one Wikimedia operation. The DB's transactional
 * upserts remain the cross-process safety net.
 */
export function enrichOneNowCoalesced(
	code: string,
	opts: { signal?: AbortSignal; fetcher?: typeof fetch } = {}
): Promise<EnrichNowResult> {
	const existing = inFlight.get(code);
	if (existing) return existing;
	const p = enrichOneNow(code, opts).finally(() => inFlight.delete(code));
	inFlight.set(code, p);
	return p;
}

/**
 * Interactive, wiki-only enrichment of a single species: Wikidata P3444
 * (sci-name fallback on miss) → Wikipedia plaintext → the same upserts the
 * worker uses. Runs inline in a form action under a 20s AbortSignal that is
 * passed INTO every fetch — this can never wedge a request. The AI stage is
 * NEVER run here (cost + latency); the caller enqueues an aiOnly chunk when
 * `aiDue`. On any network/timeout failure it writes NOTHING (no error
 * marks — a user's failed click must not consume the 7-day retry window)
 * and reports 'transient' so the caller can fall back to the queue.
 */
export async function enrichOneNow(
	code: string,
	opts: { signal?: AbortSignal; fetcher?: typeof fetch } = {}
): Promise<EnrichNowResult> {
	const signal = opts.signal ?? AbortSignal.timeout(ENRICH_NOW_BUDGET_MS);
	const fetchOpts = { signal, fetcher: opts.fetcher };
	const t = await query<{ sci_name: string }>(
		`SELECT sci_name FROM taxonomy_cache WHERE species_code = $1`,
		[code]
	);
	const sciName = t.rows[0]?.sci_name ?? null;
	// NETWORK PHASE — no DB writes may happen before this completes (CODEX1
	// td-b7d021 blocker): a transient failure mid-flight must leave the row
	// byte-identical, so 'transient' is only ever returned from here.
	let row: WikidataSpeciesRow | null;
	let target: { title: string; viaFallback: boolean } | null = null;
	let article: WikiArticle | null = null;
	try {
		const resolved = await fetchWikidataBatch([code], fetchOpts);
		if (!resolved.has(code) && sciName && validSciName(sciName)) {
			const bySci = await fetchWikidataBySciName([{ code, sciName }], fetchOpts);
			const hit = bySci.get(code);
			if (hit) resolved.set(code, hit);
		}
		row = resolved.get(code) ?? null;
		if (row != null) {
			target = wikiFetchTitleFor(row, sciName);
			article = target ? await fetchArticlePlaintext(target.title, fetchOpts) : null;
		}
	} catch {
		// Timeout, WDQS/Wikipedia error, rate limit — all transient here.
		return { outcome: 'transient' };
	}
	// PERSISTENCE PHASE — network outcome is final. ONE transaction commits
	// resolution + wiki outcome together (CODEX1 blocker #2): a failure of
	// the second write rolls back the first, so the row is never half
	// refreshed; the error THROWS (a real 500, never masked as transient).
	return withTransaction(async (client) => {
		const exec = clientExec(client);
		await upsertResolution(code, row, exec);
		if (row == null) {
			await markWikiNoArticle(code, exec);
			return { outcome: 'no_mapping' as const };
		}
		if (article == null) {
			await markWikiNoArticle(code, exec);
			return { outcome: 'no_article' as const };
		}
		await upsertWikiOk(code, article, exec);
		const ai = await exec<{ ai_status: string | null; ai_source_rev_id: string | null }>(
			`SELECT ai_status, ai_source_rev_id::text FROM species_enrichment WHERE species_code = $1`,
			[code]
		);
		const aiDue = !(
			ai.rows[0]?.ai_status === 'ok' && ai.rows[0]?.ai_source_rev_id === String(article.revId)
		);
		return {
			outcome: 'ok' as const,
			title: article.title,
			viaFallback: target?.viaFallback === true,
			aiDue
		};
	});
}

export interface GuideResult {
	species_code: string;
	com_name: string;
	sci_name: string;
	family: string | null;
	tags: string[];
	iucn_status: string | null;
	field_craft: string | null;
	seen: boolean;
	wiki_status: string | null;
	wiki_fetched_at: string | null;
	has_prose: boolean;
}

/**
 * Field-guide search (td-0753d0 taxonomy-first rewrite). Two legs UNIONed:
 *
 * 1. Taxonomy name/code leg — searches ALL ~11k species in taxonomy_cache
 *    by exact code, exact name, prefix, then substring. LEFT JOINs
 *    species_enrichment (so unenriched rows appear). Unenriched rows are
 *    included only when no tags are selected (tags require enrichment).
 * 2. Enrichment prose/tag leg — unchanged FTS + tags @> AND semantics,
 *    INNER JOIN to taxonomy (requires enrichment row).
 *
 * Combined with DISTINCT ON to keep each species' best-ranked candidate,
 * then a final deterministic ORDER + LIMIT 50.
 */
export async function searchEnrichment(
	q: string,
	tags: readonly string[],
	seenUserId: number
): Promise<GuideResult[]> {
	const query_ = q.trim().slice(0, 200);
	const hasQ = query_.length > 0;
	const escaped = query_.replace(/[%_\\]/g, (m) => `\\${m}`);
	const prefix = `${escaped}%`;
	const substr = `%${escaped}%`;
	const lowerQ = query_.toLowerCase();

	// $1=hasQ  $2=query_  $3=seenUserId  $4=tags  $5=lowerQ  $6=prefix  $7=substr
	type Row = GuideResult & { name_tier: number; rank: number };
	const r = await query<Row>(
		`SELECT * FROM (
		   SELECT DISTINCT ON (species_code) *
		   FROM (
		     /* Leg 1: taxonomy name/code — the "never empty" leg */
		     SELECT tc.species_code, tc.com_name, tc.sci_name, tc.family,
		            COALESCE(se.tags, '{}') AS tags,
		            se.iucn_status, se.field_craft,
		            (ss.species_code IS NOT NULL) AS seen,
		            se.wiki_status,
		            se.wiki_fetched_at::text AS wiki_fetched_at,
		            (se.wikipedia_extract IS NOT NULL) AS has_prose,
		            CASE
		              WHEN tc.species_code = $5         THEN 0
		              WHEN lower(tc.com_name) = $5
		                OR lower(tc.sci_name) = $5      THEN 1
		              WHEN tc.com_name ILIKE $6
		                OR tc.sci_name ILIKE $6         THEN 2
		              ELSE                                   3
		            END AS name_tier,
		            0::float4 AS rank
		       FROM taxonomy_cache tc
		       LEFT JOIN species_enrichment se USING (species_code)
		       LEFT JOIN seen_species ss
		         ON ss.user_id = $3 AND ss.species_code = tc.species_code
		      WHERE tc.category = 'species'
		        AND $1::bool
		        AND (tc.species_code = $5
		             OR tc.com_name ILIKE $7 OR tc.sci_name ILIKE $7)
		        AND ($4::text[] = '{}' OR se.tags @> $4::text[])

		     UNION ALL

		     /* Leg 2: enrichment prose/tag — FTS + tag AND semantics */
		     SELECT tc.species_code, tc.com_name, tc.sci_name, tc.family,
		            se.tags, se.iucn_status, se.field_craft,
		            (ss.species_code IS NOT NULL) AS seen,
		            se.wiki_status,
		            se.wiki_fetched_at::text AS wiki_fetched_at,
		            (se.wikipedia_extract IS NOT NULL) AS has_prose,
		            4 AS name_tier,
		            ts_rank_cd(se.search_tsv, websearch_to_tsquery('english', $2)) AS rank
		       FROM species_enrichment se
		       JOIN taxonomy_cache tc USING (species_code)
		       LEFT JOIN seen_species ss
		         ON ss.user_id = $3 AND ss.species_code = se.species_code
		      WHERE tc.category = 'species'
		        AND ($4::text[] = '{}' OR se.tags @> $4::text[])
		        AND (NOT $1::bool
		             OR se.search_tsv @@ websearch_to_tsquery('english', $2))
		   ) combined
		   ORDER BY species_code, name_tier, rank DESC
		 ) deduped
		 ORDER BY name_tier, rank DESC NULLS LAST, com_name, species_code
		 LIMIT 50`,
		[hasQ, query_, seenUserId, [...tags], lowerQ, prefix, substr]
	);
	return r.rows.map(({ name_tier: _t, rank: _r, ...row }) => row);
}

/**
 * Counts for the Field guide intro (td-0753d0): taxonomy total + enrichment
 * counts. species_enrichment retains retired codes (no taxonomy FK by design),
 * so the enrichment counts apply the same taxonomy join + category filter as
 * searchEnrichment.
 */
export async function guideCounts(): Promise<{
	taxonomy: number;
	withWikipedia: number;
	annotated: number;
}> {
	const r = await query<{ taxonomy: string; with_wikipedia: string; annotated: string }>(
		`SELECT (SELECT COUNT(*) FROM taxonomy_cache WHERE category = 'species') AS taxonomy,
		        COUNT(*) FILTER (WHERE se.wikipedia_extract IS NOT NULL) AS with_wikipedia,
		        COUNT(*) FILTER (WHERE se.ai_status = 'ok') AS annotated
		   FROM species_enrichment se
		   JOIN taxonomy_cache tc USING (species_code)
		  WHERE tc.category = 'species'`
	);
	return {
		taxonomy: Number(r.rows[0]?.taxonomy ?? 0),
		withWikipedia: Number(r.rows[0]?.with_wikipedia ?? 0),
		annotated: Number(r.rows[0]?.annotated ?? 0)
	};
}

export interface EnrichmentRow {
	species_code: string;
	wikidata_qid: string | null;
	resolution: string | null;
	iucn_status: string | null;
	facts: EnrichmentFacts;
	cross_ids: EnrichmentCrossIds;
	wikipedia_title: string | null;
	wikipedia_url: string | null;
	wikipedia_rev_id: string | null;
	wikipedia_extract: string | null;
	wikipedia_sections: { title: string; text: string }[];
	wiki_status: string | null;
	wiki_fetched_at: string | null;
	wiki_ok_at: string | null;
	field_craft: string | null;
	tags: string[];
	ai_generated_at: string | null;
}

export async function getEnrichment(code: string): Promise<EnrichmentRow | null> {
	const r = await query<EnrichmentRow>(
		`SELECT species_code, wikidata_qid, resolution, iucn_status, facts, cross_ids,
		        wikipedia_title, wikipedia_url, wikipedia_rev_id::text, wikipedia_extract,
		        wikipedia_sections, wiki_status, wiki_fetched_at::text, wiki_ok_at::text,
		        field_craft, tags, ai_generated_at::text
		   FROM species_enrichment WHERE species_code = $1`,
		[code]
	);
	return r.rows[0] ?? null;
}

export interface AiStageInput {
	extract: string;
	sections: { title: string; text: string }[];
	revId: number;
	aiStatus: string | null;
	aiSourceRevId: number | null;
	aiAttemptedAt: string | null;
}

/**
 * Everything the AI stage needs for a species whose wiki data is already
 * stored (the fresh-skip path). Null when there is no usable prose.
 */
export async function aiStageInputFor(code: string): Promise<AiStageInput | null> {
	const r = await query<{
		wikipedia_extract: string | null;
		wikipedia_sections: { title: string; text: string }[];
		wikipedia_rev_id: string | null;
		ai_status: string | null;
		ai_source_rev_id: string | null;
		ai_attempted_at: string | null;
	}>(
		`SELECT wikipedia_extract, wikipedia_sections, wikipedia_rev_id::text,
		        ai_status, ai_source_rev_id::text, ai_attempted_at::text
		   FROM species_enrichment
		  WHERE species_code = $1 AND wiki_status = 'ok' AND wikipedia_extract IS NOT NULL`,
		[code]
	);
	const row = r.rows[0];
	if (!row || row.wikipedia_rev_id == null) return null;
	return {
		extract: row.wikipedia_extract as string,
		sections: row.wikipedia_sections ?? [],
		revId: Number(row.wikipedia_rev_id),
		aiStatus: row.ai_status,
		aiSourceRevId: row.ai_source_rev_id == null ? null : Number(row.ai_source_rev_id),
		aiAttemptedAt: row.ai_attempted_at
	};
}

/** Per-species freshness check used by chunk handlers (idempotent overlap). */
export async function wikiFresh(code: string): Promise<boolean> {
	const r = await query<{ fresh: boolean }>(
		`SELECT (wiki_status IN ('ok','no_article')
		         AND wiki_fetched_at > NOW() - INTERVAL '${WIKI_REFRESH_DAYS} days') AS fresh
		   FROM species_enrichment WHERE species_code = $1`,
		[code]
	);
	return r.rows[0]?.fresh === true;
}

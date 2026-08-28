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
import { createHash } from 'node:crypto';
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
const clientExec = (client: pg.PoolClient): Exec =>
	((text, params) => client.query(text, params as never[])) as Exec;
import { sanitizeErrorText } from '$server/job-policy';
import { MAX_SIMILAR } from '$server/ai-enrichment';
import type { WikidataSpeciesRow } from '$server/wikidata';
import {
	fetchWikidataBatch,
	fetchWikidataBySciName,
	fetchWikidataMedia,
	validSciName
} from '$server/wikidata';
import type { WikiArticle } from '$server/wikipedia';
import { articleUrl, fetchArticlePlaintext } from '$server/wikipedia';
import type { CommonsFileInfo } from '$server/wikimedia-commons';
import {
	commonsSourceUrl,
	fetchCommonsFileInfo,
	isDisplayableImage,
	isPlayableAudio
} from '$server/wikimedia-commons';
import type { XenoCantoRecording } from '$server/xeno-canto';
import { fetchXenoCantoRecordings, XenoCantoError } from '$server/xeno-canto';

export const WIKI_REFRESH_DAYS = 180;
export const ERROR_RETRY_DAYS = 7;
/** Media provider failures retry on the daily scan, not the weekly wiki/AI lane. */
export const MEDIA_ERROR_RETRY_HOURS = 24;
/** Align the 24-hour eligibility clock with a 24-hour scan heartbeat. */
export const MEDIA_RETRY_SCAN_SLACK_MINUTES = 15;

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
	exec?: Exec
): Promise<void> {
	if (exec) return upsertResolutionWithExec(code, row, exec);
	await withTransaction(async (client) =>
		upsertResolutionWithExec(code, row, clientExec(client))
	);
}

async function upsertResolutionWithExec(
	code: string,
	row: WikidataSpeciesRow | null,
	exec: Exec
): Promise<void> {
	const prev = await exec<{ inat_id: string | null; inat_sci_name: string | null }>(
		`SELECT cross_ids->>'inat_taxon_id' AS inat_id, inat_sci_name
		   FROM species_enrichment WHERE species_code = $1`,
		[code]
	);
	const oldId = prev.rows[0]?.inat_id ?? null;
	if (row == null) {
		await exec(
			`INSERT INTO species_enrichment
			   (species_code, resolution, wikidata_qid, iucn_status, facts, cross_ids)
			 VALUES ($1, 'no_mapping', NULL, NULL, '{}'::jsonb, '{}'::jsonb)
			 ON CONFLICT (species_code) DO UPDATE SET
			   resolution = 'no_mapping', wikidata_qid = NULL, iucn_status = NULL,
			   facts = '{}'::jsonb, cross_ids = '{}'::jsonb, updated_at = NOW()`,
			[code]
		);
		await invalidateInatMappingChange(exec, code, oldId, null, prev.rows[0]?.inat_sci_name ?? null);
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
	// Targeted invalidation (AGY A3, mechanics per self-review R4/R5): when
	// the P3151 mapping CHANGES, null the candidate hash of only the species
	// actually affected — self, plus species whose raw edges reference either
	// id (indexed) or the focal's iNat binomial (namespace-correct; never the
	// eBird sci name). NEVER a global clock: that was the full-corpus storm.
	await invalidateInatMappingChange(
		exec,
		code,
		oldId,
		row.inatTaxonId ?? null,
		prev.rows[0]?.inat_sci_name ?? null
	);
}

async function invalidateInatMappingChange(
	exec: Exec,
	code: string,
	oldId: string | null,
	newId: string | null,
	inatSciName: string | null
): Promise<void> {
	if (oldId === newId) return;
	const ids = [oldId, newId].filter((x): x is string => x !== null);
	const nameArm = inatSciName?.toLowerCase() ?? null;
	await exec(
		`UPDATE species_enrichment SET similar_candidates_hash = NULL, updated_at = NOW()
		  WHERE species_code = $1
		     OR species_code IN (
		       SELECT sis.species_code FROM species_inat_similar sis
		        WHERE (cardinality($2::text[]) > 0 AND sis.inat_taxon_id::text = ANY($2::text[]))
		           OR ($3::text IS NOT NULL AND lower(sis.inat_sci_name) = $3))`,
		[code, ids, nameArm]
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

/**
 * Phase 2 writer — field craft, tags, AND the similar-species notes, in ONE
 * transaction (td-8f0ed8, CODEX1 P1 #2).
 *
 * Atomicity is the point: a loose note write beside this UPDATE could fail
 * AFTER the substage had been stamped fresh, leaving the feature permanently
 * suppressed for that species until its Wikipedia revision happened to change.
 *
 * The whole note set for the focal species is REPLACED, which also removes
 * notes for candidates the model no longer returns or that have left the
 * candidate set entirely.
 *
 * `search_tsv` deliberately does NOT include the notes: the search discipline
 * on this table is enrichment-owned prose about the FOCAL species, and indexing
 * comparison text would make a search for one species match another's page.
 */
export async function upsertAiData(
	code: string,
	data: {
		fieldCraft: string;
		tags: string[];
		model: string;
		sourceRevId: number;
		/** Validated, closed-set notes. */
		similar?: readonly { code: string; note: string }[];
		/** Candidate-set fingerprint these notes were generated for. */
		similarCandidatesHash?: string | null;
		/**
		 * How many candidates were OFFERED. Required to tell two very different
		 * outcomes apart, which the old code collapsed into 'none':
		 *   0 candidates + 0 notes  -> genuinely nothing to say (terminal, correct)
		 *   N candidates + 0 notes  -> the model owed a note and did not give one
		 * The second is a MISS. Recording it as 'none' made it terminal and
		 * unretryable, which is how Bimaculated Lark ended up permanently
		 * note-less despite Calandra Lark being in the schema's `required`
		 * (GROK P1). It is now an error, so the 7-day window applies.
		 */
		candidateCount?: number;
		/**
		 * eBird-slash candidates this run OWED a note and did not deliver.
		 *
		 * Partial success was the last-good wipe in a new shape (GROK): two of
		 * three notes written with the third dropped as malformed stamped 'ok',
		 * DELETEd every row, and re-inserted the subset — destroying the missing
		 * candidate's previously-good note, with aiDueCodes then declining to
		 * reselect because status was ok and the hash matched.
		 */
		owedCodes?: readonly string[];
		/**
		 * Every candidate OFFERED this run. Drives the delete: a row survives if
		 * its candidate is still on the list, whatever this run returned for it.
		 *
		 * Without it the keep-list was "notes written this run + owed slash
		 * codes", which never contains a still-offered GENUS candidate — so a run
		 * that completed the slash notes and (legitimately, they are optional)
		 * returned no genus note deleted the previous good genus rows, stamped
		 * 'ok', and was never reselected (GROK). Absence in one response is not
		 * evidence a note is wrong: we have measured that omissions are often
		 * spurious and have NOT measured that they are considered judgements, so
		 * last-good wins on the MISS path.
		 *
		 * That is narrower than it first looks, and the wiki/media analogy is NOT
		 * the justification (GROK): those protect FETCH FAILURES, which are not
		 * judgements at all, while tags and field_craft are already
		 * this-run-is-truth. Two paths, deliberately not split today:
		 *
		 *   miss/error (slash owed, empty result, retry threw) — last-good for
		 *     every still-offered row. Destroying a good note here is the bug
		 *     that recurred three times. This is what the code does.
		 *   complete success (nothing owed) — an omitted GENUS key is the only
		 *     channel the prompt and schema give the model to say "not a
		 *     look-alike". Last-good makes that claim un-withdrawable: the row
		 *     renders either way (getSimilarSpecies always lists genus mates and
		 *     the note is an overlay), so what survives is a field-separation
		 *     sentence implying the birds ARE confusable, above card copy saying
		 *     they may not be.
		 *
		 * The cost of today's choice is a frozen confusion claim; the cost of the
		 * alternative is silent destruction, which has already happened three
		 * times. Split it only with evidence about how often an omitted optional
		 * key is a considered skip rather than a drop — which nothing measured so
		 * far tells us.
		 */
		offeredCodes?: readonly string[];
	}
): Promise<void> {
	// SET expressions read the OLD row for untouched columns, so mixing the
	// new tags/field_craft params with the stored extract/sections is correct.
	const tsv = tsvExpr({
		tags: `array_to_string($3::text[], ' ')`,
		prose: `coalesce(wikipedia_extract, '') || ' ' || coalesce($2, '')`,
		sections: `wikipedia_sections`
	});
	const similar = data.similar ?? [];
	const hash = data.similarCandidatesHash ?? null;
	const candidateCount = data.candidateCount ?? 0;
	const owed = data.owedCodes ?? [];
	const offered = data.offeredCodes ?? [];
	// 'ok' requires COMPLETENESS, not merely a non-empty result: any slash
	// candidate still owed a note leaves the substage due. 'none' remains legal
	// only when nothing was offered at all.
	// Completeness is about what was REQUIRED, not about whether anything was
	// written. Requiring similar.length > 0 left a genus-only candidate set that
	// the model correctly skipped in 'error' forever: nothing was owed, so the
	// retry could never succeed, and the species re-entered the 7-day lane on
	// every pass (GROK). Genus notes are optional; skipping all of them IS a
	// complete answer.
	const similarStatus =
		hash == null ? null : candidateCount === 0 ? 'none' : owed.length === 0 ? 'ok' : 'error';
	const similarError =
		similarStatus === 'error'
			? owed.length > 0
				? `No usable note for ${owed.length} of ${candidateCount} candidate(s): ${owed.join(', ')}.`
				: `No usable note returned for ${candidateCount} candidate(s) after retries.`
			: null;

	await withTransaction(async (client) => {
		await client.query(
			`UPDATE species_enrichment SET
			   field_craft = $2, tags = $3::text[], ai_model = $4, ai_generated_at = NOW(),
			   ai_source_rev_id = $5, ai_status = 'ok', ai_error = NULL,
			   ai_attempted_at = NOW(), search_tsv = ${tsv}, updated_at = NOW(),
			   similar_status = COALESCE($6, similar_status),
			   similar_candidates_hash = COALESCE($7, similar_candidates_hash),
			   similar_source_rev_id = CASE WHEN $6 IS NULL THEN similar_source_rev_id ELSE $5 END,
			   similar_model = CASE WHEN $6 IS NULL OR $9::int = 0 THEN similar_model ELSE $4 END,
			   similar_generated_at = CASE WHEN $6 IS NULL THEN similar_generated_at ELSE NOW() END,
			   similar_attempted_at = CASE WHEN $6 IS NULL THEN similar_attempted_at ELSE NOW() END,
			   similar_error = CASE WHEN $6 IS NULL THEN similar_error ELSE $8 END
			 WHERE species_code = $1`,
			[
				code,
				data.fieldCraft,
				data.tags,
				data.model,
				data.sourceRevId,
				similarStatus,
				hash,
				similarError,
				// $9 (AGY A5): similar_model advances ONLY when this run actually
				// wrote notes — a Sonnet tags-only call on a fully-preserved set
				// must not restamp the substage's provenance.
				similar.length
			]
		);
		// Only touch the notes when this run produced a verdict on them.
		if (similarStatus == null) return;

		// Replace per-code rather than wholesale. A row is deleted ONLY when its
		// candidate is no longer offered at all — i.e. the candidate set changed
		// under it, which in practice means a taxonomy revision. Anything still
		// offered keeps its last-good note regardless of what this run returned
		// for it. The keep-list is therefore the OFFERED set, not the set this
		// run happened to write; conflating the two is what destroyed good notes
		// in three successive shapes (full miss, partial miss, optional genus).
		const keep = [...new Set([...offered, ...similar.map((x) => x.code), ...owed])];
		if (keep.length > 0) {
			await client.query(
				`DELETE FROM species_similar
				  WHERE species_code = $1 AND similar_code <> ALL($2::text[])`,
				[code, keep]
			);
		} else {
			// Candidate sets can genuinely shrink to zero (self-review notable
			// c): with a real hash and nothing offered, every stored note is an
			// orphan — invisible on the page but never cleaned by the keep-list
			// form above, which previously skipped this case entirely.
			await client.query(`DELETE FROM species_similar WHERE species_code = $1`, [code]);
		}
		for (const s of similar) {
			await client.query(
				`INSERT INTO species_similar
			   (species_code, similar_code, note, ai_model, ai_source_rev_id)
			 VALUES ($1, $2, $3, $4, $5)
			 ON CONFLICT (species_code, similar_code) DO UPDATE SET
			   note = EXCLUDED.note, ai_model = EXCLUDED.ai_model,
			   ai_source_rev_id = EXCLUDED.ai_source_rev_id, generated_at = NOW()`,
				[code, s.code, s.note, data.model, data.sourceRevId]
			);
		}
	});
}

/**
 * Fingerprint of the candidate set the notes were generated for.
 *
 * Computed in Node, not SQL: expanding 1,035 slash taxa per in-scope species
 * inside the scanner's selection query would cost far more than one in-memory
 * pass. The scanner over-selects cheaply (any species whose notes predate the
 * last taxonomy sync) and this hash is what prevents an actual API call when
 * the candidate set turns out to be unchanged.
 */
export function similarCandidatesHash(codes: readonly string[]): string {
	return createHash('sha1').update([...codes].sort().join(',')).digest('hex').slice(0, 16);
}

export async function markAiError(
	code: string,
	message: string,
	opts: { similarParticipating: boolean } = { similarParticipating: true }
): Promise<void> {
	// STAGE-AWARE (CODEX1 F4 / self-review R-F4b): the similar substage shares
	// this failure ONLY when the run actually participated in it. Participation
	// is an EXPLICIT flag captured from the inat-status read BEFORE the try
	// body — never inferred from "hash is null", because a throw during
	// candidate resolution predates any hash. When participating, the substage
	// gets the same 7-day backoff (leaving similar_status NULL would make the
	// never-attempted clause true every scan). When NOT participating (inat
	// pending/error), similar_* stays untouched so the substage runs the
	// moment inat lands. Existing notes are PRESERVED either way (last-good).
	if (opts.similarParticipating) {
		await query(
			`UPDATE species_enrichment SET
			   ai_status = 'error', ai_error = $2, ai_attempted_at = NOW(),
			   similar_status = 'error', similar_error = $2, similar_attempted_at = NOW(),
			   updated_at = NOW()
			 WHERE species_code = $1`,
			[code, sanitizeErrorText(message).slice(0, 500)]
		);
	} else {
		await query(
			`UPDATE species_enrichment SET
			   ai_status = 'error', ai_error = $2, ai_attempted_at = NOW(), updated_at = NOW()
			 WHERE species_code = $1`,
			[code, sanitizeErrorText(message).slice(0, 500)]
		);
	}
}

/**
 * The in-scope species universe (CODEX1 #9 contract): DISTINCT codes from
 * seen ∪ frequency ∪ photos (NULLs removed), category='species' applied ONCE
 * via taxonomy.
 */
const IN_SCOPE_CODES_SQL = `
           SELECT species_code FROM seen_species
           UNION
           SELECT species_code FROM species_frequency
           UNION
           SELECT species_code FROM photo_links WHERE species_code IS NOT NULL`;

const SCOPE_SQL = `
  SELECT DISTINCT tc.species_code
    FROM taxonomy_cache tc
   WHERE tc.category = 'species'
     AND tc.species_code IN (${IN_SCOPE_CODES_SQL}
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
		         -- Similar-note substage (td-460b1c Phase B). EVERY clause below
		         -- carries the inat-terminal gate (self-review R1): a species
		         -- whose confusion data is pending or errored must never enter
		         -- the notes lane, or it loops candidate-less every scan.
		         OR (se.inat_similar_status IN ('ok','none','no_mapping') AND (
		               se.similar_status IS NULL
		            OR (se.similar_status = 'error'
		                AND se.similar_attempted_at < NOW() - INTERVAL '${ERROR_RETRY_DAYS} days')
		            -- New iNat data means the notes are stale.
		            OR (se.similar_generated_at IS NOT NULL
		                AND se.similar_generated_at < se.inat_similar_fetched_at)
		            -- Targeted-invalidation marker (AGY A3): a partner's edge or
		            -- mapping change nulled our hash; the reconcile writes it
		            -- back every time (R1), so this cannot loop.
		            OR (se.similar_candidates_hash IS NULL AND se.similar_status IS NOT NULL)
		            -- Taxonomy re-sync over-approximation: stored resolutions can
		            -- shift. The reconcile's forward fingerprint (R9 two-tier)
		            -- short-circuits the unchanged majority without an AI call.
		            OR (se.similar_generated_at IS NOT NULL
		                AND se.similar_generated_at < (SELECT MAX(fetched_at) FROM taxonomy_cache))
		         ))
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
		const ai = await exec<{
			ai_status: string | null;
			ai_source_rev_id: string | null;
		}>(`SELECT ai_status, ai_source_rev_id::text FROM species_enrichment WHERE species_code = $1`, [
			code
		]);
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
	const r = await query<{
		taxonomy: string;
		with_wikipedia: string;
		annotated: string;
	}>(
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
	media_status: string | null;
	media_fetched_at: string | null;
	media_ok_at: string | null;
	media_error: string | null;
}

export async function getEnrichment(code: string): Promise<EnrichmentRow | null> {
	const r = await query<EnrichmentRow>(
		`SELECT species_code, wikidata_qid, resolution, iucn_status, facts, cross_ids,
		        wikipedia_title, wikipedia_url, wikipedia_rev_id::text, wikipedia_extract,
		        wikipedia_sections, wiki_status, wiki_fetched_at::text, wiki_ok_at::text,
		        field_craft, tags, ai_generated_at::text,
		        media_status, media_fetched_at::text, media_ok_at::text, media_error
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
	/** Similar-note substage state — its own clock (td-8f0ed8). */
	similarStatus: string | null;
	similarCandidatesHash: string | null;
	similarSourceRevId: number | null;
	similarAttemptedAt: string | null;
	similarGeneratedAt: string | null;
	/** Sourcing-stage state (td-460b1c): the substage only participates when
	 * this is terminal ('ok'/'none'/'no_mapping'). */
	inatSimilarStatus: string | null;
	inatSimilarFetchedAt: string | null;
	taxonomyFetchedAt: string | null;
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
		similar_status: string | null;
		similar_candidates_hash: string | null;
		similar_source_rev_id: string | null;
		similar_attempted_at: string | null;
		similar_generated_at: string | null;
		inat_similar_status: string | null;
		inat_similar_fetched_at: string | null;
		taxonomy_fetched_at: string | null;
	}>(
		`SELECT wikipedia_extract, wikipedia_sections, wikipedia_rev_id::text,
		        ai_status, ai_source_rev_id::text, ai_attempted_at::text,
		        similar_status, similar_candidates_hash,
		        similar_source_rev_id::text, similar_attempted_at::text,
		        similar_generated_at::text, inat_similar_status, inat_similar_fetched_at::text,
		        (SELECT MAX(fetched_at)::text FROM taxonomy_cache) AS taxonomy_fetched_at
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
		aiAttemptedAt: row.ai_attempted_at,
		similarStatus: row.similar_status,
		similarCandidatesHash: row.similar_candidates_hash,
		similarSourceRevId:
			row.similar_source_rev_id == null ? null : Number(row.similar_source_rev_id),
		similarAttemptedAt: row.similar_attempted_at,
		similarGeneratedAt: row.similar_generated_at,
		inatSimilarStatus: row.inat_similar_status,
		inatSimilarFetchedAt: row.inat_similar_fetched_at,
		taxonomyFetchedAt: row.taxonomy_fetched_at
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

// ---------------------------------------------------------------------------
// Field-guide sample media (plan: docs/2026-08-23-field-guide-sample-media-
// CLAUDE.md). Metadata-only: binaries live on Wikimedia Commons / xeno-canto,
// remote URLs are the source of truth. A separate table + stage columns,
// parallel to the wiki/AI stages above — a media failure never touches wiki
// or AI data, and vice versa.
// ---------------------------------------------------------------------------

export interface MediaRow {
	media_id: number;
	species_code: string;
	kind: 'photo' | 'sound';
	vocalization_type: string | null;
	rank: number;
	provider: 'wikimedia_commons' | 'xeno_canto';
	provider_id: string;
	media_url: string;
	thumbnail_url: string | null;
	source_url: string;
	title: string | null;
	creator: string | null;
	license_code: string;
	license_url: string | null;
	location: string | null;
	duration_seconds: number | null;
	width: number | null;
	height: number | null;
}

export interface SampleMedia {
	photo: MediaRow | null;
	sounds: MediaRow[];
	status: string | null;
	mediaError: string | null;
	audioStatus: 'restricted' | null;
}

/** A row shape not yet persisted — media_id/species_code are assigned by the write. */
export type MediaCandidate = Omit<MediaRow, 'media_id' | 'species_code'>;

/**
 * Transactional replace: DELETE existing species_media rows for this code,
 * INSERT the new candidates, and stamp species_enrichment's media stage —
 * all in one statement sequence so a partial write is never visible
 * (CODEX1 pattern, matching upsertResolution/upsertWikiOk). When no executor
 * is supplied, this function owns the transaction; callers already inside a
 * transaction can pass their client executor.
 */
export async function upsertMediaOk(
	code: string,
	rows: readonly MediaCandidate[],
	status: 'ok' | 'partial' | 'no_media',
	audioStatus: 'restricted' | null = null,
	exec?: Exec
): Promise<void> {
	const replace = async (run: Exec): Promise<void> => {
		await run(`DELETE FROM species_media WHERE species_code = $1`, [code]);
		for (const r of rows) {
			await run(
				`INSERT INTO species_media
			   (species_code, kind, vocalization_type, rank, provider, provider_id,
			    media_url, thumbnail_url, source_url, title, creator, license_code,
			    license_url, location, duration_seconds, width, height)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
				[
					code,
					r.kind,
					r.vocalization_type,
					r.rank,
					r.provider,
					r.provider_id,
					r.media_url,
					r.thumbnail_url,
					r.source_url,
					r.title,
					r.creator,
					r.license_code,
					r.license_url,
					r.location,
					r.duration_seconds,
					r.width,
					r.height
				]
			);
		}
		await run(
			`INSERT INTO species_enrichment
		   (species_code, media_status, media_fetched_at, media_ok_at, media_audio_status)
		 VALUES ($1, $2, NOW(), NOW(), $3)
		 ON CONFLICT (species_code) DO UPDATE SET
		   media_status = $2, media_fetched_at = NOW(), media_ok_at = NOW(),
		   media_error = NULL, media_audio_status = $3, updated_at = NOW()`,
			[code, status, audioStatus]
		);
	};
	if (exec) {
		await replace(exec);
		return;
	}
	await withTransaction(async (client) => replace(clientExec(client)));
}

/**
 * Media-stage failure: stamps status/error/clock ONLY. Existing species_media
 * rows are PRESERVED (last-good) — a transient Commons/xeno-canto outage must
 * not blank out a photo that was already showing on the species page.
 * INSERT ON CONFLICT so it works even when the enrichment row doesn't exist
 * yet (belt-and-braces, matching markWikiError).
 */
export async function markMediaError(code: string, message: string): Promise<void> {
	await query(
		`INSERT INTO species_enrichment (species_code, media_status, media_error, media_fetched_at)
		 VALUES ($1, 'error', $2, NOW())
		 ON CONFLICT (species_code) DO UPDATE SET
		   media_status = 'error', media_error = $2, media_fetched_at = NOW(),
		   updated_at = NOW()`,
		[code, sanitizeErrorText(message).slice(0, 500)]
	);
}

/**
 * DB-only read for the species page loader (key invariant: never calls
 * Commons/xeno-canto on GET). Two parallel queries: the media rows and the
 * enrichment row's media-stage status/error.
 */
export async function getSpeciesMedia(code: string): Promise<SampleMedia> {
	const [mediaRes, statusRes] = await Promise.all([
		query<MediaRow>(
			`SELECT media_id, species_code, kind, vocalization_type, rank, provider, provider_id,
			        media_url, thumbnail_url, source_url, title, creator, license_code, license_url,
			        location, duration_seconds, width, height
			   FROM species_media WHERE species_code = $1 ORDER BY kind, rank`,
			[code]
		),
		query<{
			media_status: string | null;
			media_error: string | null;
			media_audio_status: 'restricted' | null;
		}>(
			`SELECT media_status, media_error, media_audio_status
			   FROM species_enrichment WHERE species_code = $1`,
			[code]
		)
	]);
	return {
		photo: mediaRes.rows.find((r) => r.kind === 'photo') ?? null,
		sounds: mediaRes.rows.filter((r) => r.kind === 'sound'),
		status: statusRes.rows[0]?.media_status ?? null,
		mediaError: statusRes.rows[0]?.media_error ?? null,
		audioStatus: statusRes.rows[0]?.media_audio_status ?? null
	};
}

/** One candidate on the species page's similar/related list. */
export interface SimilarSpeciesRow {
	species_code: string;
	com_name: string;
	sci_name: string;
	/** Observer misidentification count; null for reverse-support extras. */
	misid_count: number | null;
	/** AI "how to tell them apart" line; null until the note stage runs. */
	note: string | null;
	photo: {
		thumbnail_url: string | null;
		source_url: string;
		creator: string | null;
		license_code: string;
		license_url: string | null;
		width: number | null;
		height: number | null;
	} | null;
	seen: boolean;
}

/** An iNat confusion partner with no eBird mapping — surfaced, never dropped
 * (binding decision 2). */
export interface UnresolvedSimilarRow {
	inat_sci_name: string;
	inat_com_name: string | null;
	misid_count: number;
}

export type InatSimilarStatus = 'pending' | 'ok' | 'none' | 'no_mapping' | 'error';

export interface SimilarSpeciesResult {
	similar: SimilarSpeciesRow[];
	unresolved: UnresolvedSimilarRow[];
	inatStatus: InatSimilarStatus;
}

// ---------------------------------------------------------------------------
// Selection + reconcile (td-460b1c Phase B). Resolution, selection, and
// reverse-current-source support run at RECONCILE time in the worker and are
// persisted to species_similar_display (AGY A1) — the page reads one indexed
// query and can never diverge from the stored notes' hash.
// ---------------------------------------------------------------------------

/** Cross-family pairs need materially stronger support than same-family ones
 * (AGY A4: raw counts put Canada Goose on Bald Eagle's list). */
const CROSS_FAMILY_MIN = 20;
const CROSS_FAMILY_LEADER_FRACTION = 0.1;

/** One raw edge after the two-arm resolution pass. */
export interface ResolvedEdgeInput {
	inatTaxonId: string;
	misidCount: number;
	inatSciName: string;
	inatComName: string | null;
	declined: boolean;
	/** 'ambiguous' = the winning arm matched >1 distinct codes (surfaced as
	 * unresolved, never a lexicographic pick — CODEX1 F2). */
	resolution:
		| { speciesCode: string; comName: string; sciName: string; family: string | null; inScope: boolean }
		| 'ambiguous'
		| null;
}

export interface SelectedCandidate {
	speciesCode: string;
	comName: string;
	sciName: string;
	misidCount: number;
	inatTaxonId: string;
}

export interface InatSelection {
	selected: SelectedCandidate[];
	unresolved: UnresolvedSimilarRow[];
}

/**
 * Pure selection over resolved edges (exported for tests). Pipeline order is
 * FIXED (self-review R8 — it changes seat counts and the pre-flight
 * histogram): dedupe-by-code -> scope filter -> family floors (declined
 * excluded first) -> rank -> cap.
 *
 * Floors: leader = max count over non-declined edges. Normal data: same-family
 * passes count >= min(leader, 3); cross-family (or unknown-family resolved)
 * needs count >= max(CROSS_FAMILY_MIN, ceil(0.1 x leader)). Weak data
 * (leader < 3, GROK G1/self-review R8): same-family only, at most 3 seats —
 * thin evidence gets a thin card, but the leader still shows. Unresolved rows
 * pass the base floor only (family unknowable) and never consume seats.
 */
export function selectInatCandidates(
	edges: readonly ResolvedEdgeInput[],
	focalFamily: string | null
): InatSelection {
	const live = edges.filter((e) => !e.declined);
	const leader = live.reduce((m, e) => Math.max(m, e.misidCount), 0);
	if (leader === 0) return { selected: [], unresolved: [] };
	const weakData = leader < 3;
	const baseFloor = Math.min(leader, 3);
	const crossFloor = Math.max(CROSS_FAMILY_MIN, Math.ceil(leader * CROSS_FAMILY_LEADER_FRACTION));

	// Dedupe two iNat taxa resolving to the same eBird code, keeping the
	// higher count (deterministic: ties keep the lower taxon id, which sorts
	// first below).
	const byCode = new Map<string, ResolvedEdgeInput>();
	const rest: ResolvedEdgeInput[] = [];
	for (const e of [...live].sort(
		(a, b) => b.misidCount - a.misidCount || a.inatTaxonId.localeCompare(b.inatTaxonId)
	)) {
		if (typeof e.resolution === 'object' && e.resolution !== null) {
			const key = e.resolution.speciesCode;
			if (!byCode.has(key)) byCode.set(key, e);
		} else {
			rest.push(e);
		}
	}

	const sameFamily = (fam: string | null) =>
		focalFamily !== null && fam !== null && fam === focalFamily;

	const eligible = [...byCode.values()].filter((e) => {
		const r = e.resolution as Exclude<ResolvedEdgeInput['resolution'], 'ambiguous' | null>;
		if (!r.inScope) return false; // extralimital noise (AGY A4) — dropped, NOT "unresolved"
		if (weakData) return sameFamily(r.family);
		return sameFamily(r.family) ? e.misidCount >= baseFloor : e.misidCount >= crossFloor;
	});

	const cap = weakData ? Math.min(3, MAX_SIMILAR) : MAX_SIMILAR;
	const selected = eligible
		.sort((a, b) => b.misidCount - a.misidCount || a.inatTaxonId.localeCompare(b.inatTaxonId))
		.slice(0, cap)
		.map((e) => {
			const r = e.resolution as Exclude<ResolvedEdgeInput['resolution'], 'ambiguous' | null>;
			return {
				speciesCode: r.speciesCode,
				comName: r.comName,
				sciName: r.sciName,
				misidCount: e.misidCount,
				inatTaxonId: e.inatTaxonId
			};
		});

	// ALL floor-passing unresolved rows are surfaced (binding decision 2 /
	// CODEX1 F8 — no display cap); ambiguous resolutions land here too.
	const unresolved = rest
		.filter((e) => e.misidCount >= baseFloor)
		.sort((a, b) => b.misidCount - a.misidCount || a.inatTaxonId.localeCompare(b.inatTaxonId))
		.map((e) => ({
			inat_sci_name: e.inatSciName,
			inat_com_name: e.inatComName,
			misid_count: e.misidCount
		}));

	return { selected, unresolved };
}

/**
 * Two-arm resolution of one species' raw edges (CODEX1 F2, executed at
 * reconcile time): cross-id arm (priority 1, expression-indexed) then exact
 * sci-name arm (priority 2, taxonomy_sci_idx). A winning arm with >1 distinct
 * codes is AMBIGUOUS. Scope check is per-code EXISTS probes (all three scope
 * tables have species_code indexes) — never the 23M-row scope UNION.
 */
async function loadResolvedEdges(code: string, exec: Exec = query): Promise<ResolvedEdgeInput[]> {
	const r = await exec<{
		inat_taxon_id: string;
		misid_count: number;
		inat_sci_name: string;
		inat_com_name: string | null;
		declined: boolean;
		cross_matches: string[] | null;
		name_matches: string[] | null;
	}>(
		`SELECT sis.inat_taxon_id::text, sis.misid_count, sis.inat_sci_name, sis.inat_com_name,
		        (sis.declined_at IS NOT NULL) AS declined,
		        cm.cross_matches, nm.name_matches
		   FROM species_inat_similar sis
		   LEFT JOIN LATERAL (
		     SELECT array_agg(DISTINCT se.species_code) AS cross_matches
		       FROM species_enrichment se
		       JOIN taxonomy_cache t ON t.species_code = se.species_code AND t.category = 'species'
		      WHERE se.cross_ids->>'inat_taxon_id' = sis.inat_taxon_id::text
		        AND se.species_code <> sis.species_code
		   ) cm ON TRUE
		   LEFT JOIN LATERAL (
		     SELECT array_agg(DISTINCT tc.species_code) AS name_matches
		       FROM taxonomy_cache tc
		      WHERE tc.category = 'species'
		        AND lower(tc.sci_name) = lower(sis.inat_sci_name)
		        AND tc.species_code <> sis.species_code
		   ) nm ON TRUE
		  WHERE sis.species_code = $1
		  ORDER BY sis.misid_count DESC, sis.inat_taxon_id`,
		[code]
	);
	// Batch-load names/family/scope for every uniquely-resolved code.
	const winners = new Map<string, string>(); // edge taxonId -> species code
	for (const row of r.rows) {
		const arm =
			row.cross_matches && row.cross_matches.length > 0 ? row.cross_matches : row.name_matches;
		if (arm && arm.length === 1) winners.set(row.inat_taxon_id, arm[0]);
	}
	const codes = [...new Set(winners.values())];
	const meta = new Map<
		string,
		{ com_name: string; sci_name: string; family: string | null; in_scope: boolean }
	>();
	if (codes.length > 0) {
		const m = await exec<{
			species_code: string;
			com_name: string;
			sci_name: string;
			family: string | null;
			in_scope: boolean;
		}>(
			`SELECT tc.species_code, tc.com_name, tc.sci_name, tc.family,
			        (EXISTS (SELECT 1 FROM seen_species s WHERE s.species_code = tc.species_code)
			      OR EXISTS (SELECT 1 FROM species_frequency f WHERE f.species_code = tc.species_code)
			      OR EXISTS (SELECT 1 FROM photo_links p WHERE p.species_code = tc.species_code)) AS in_scope
			   FROM taxonomy_cache tc
			  WHERE tc.category = 'species' AND tc.species_code = ANY($1::text[])`,
			[codes]
		);
		for (const row of m.rows) {
			meta.set(row.species_code, {
				com_name: row.com_name,
				sci_name: row.sci_name,
				family: row.family,
				in_scope: row.in_scope
			});
		}
	}
	return r.rows.map((row) => {
		const arm =
			row.cross_matches && row.cross_matches.length > 0 ? row.cross_matches : row.name_matches;
		let resolution: ResolvedEdgeInput['resolution'] = null;
		if (arm && arm.length > 1) resolution = 'ambiguous';
		else if (arm && arm.length === 1) {
			const info = meta.get(arm[0]);
			// A winner that vanished from taxonomy between the two queries (or a
			// non-species collision) degrades to unresolved, never a guess.
			resolution = info
				? {
						speciesCode: arm[0],
						comName: info.com_name,
						sciName: info.sci_name,
						family: info.family,
						inScope: info.in_scope
					}
				: null;
		}
		return {
			inatTaxonId: row.inat_taxon_id,
			misidCount: row.misid_count,
			inatSciName: row.inat_sci_name,
			inatComName: row.inat_com_name,
			declined: row.declined,
			resolution
		};
	});
}

/** Offered candidate as the AI stage sees it. */
export interface SimilarCandidateRow {
	code: string;
	comName: string;
	sciName: string;
	/** null = reverse-support extra (the count lives on the partner's edge). */
	misidCount: number | null;
}

/** Fingerprint of the FORWARD selection outcome — the two-tier reconcile
 * short-circuit (self-review R9). */
function forwardFingerprint(sel: InatSelection): string {
	const parts = [
		...sel.selected.map((s) => `s:${s.speciesCode}:${s.misidCount}`),
		...sel.unresolved.map((u) => `u:${u.inat_sci_name}:${u.misid_count}`)
	];
	return createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
}

interface FocalInatState {
	inatTaxonId: string | null;
	inatSciName: string | null;
	ebirdSciName: string | null;
	family: string | null;
	status: InatSimilarStatus;
	fingerprint: string | null;
	similarStatus: string | null;
	similarHash: string | null;
}

async function focalInatState(code: string, exec: Exec = query): Promise<FocalInatState> {
	const r = await exec<{
		inat_taxon_id: string | null;
		inat_sci_name: string | null;
		ebird_sci_name: string | null;
		family: string | null;
		inat_similar_status: string | null;
		inat_resolution_fingerprint: string | null;
		similar_status: string | null;
		similar_candidates_hash: string | null;
	}>(
		`SELECT se.inat_taxon_id::text, se.inat_sci_name, tc.sci_name AS ebird_sci_name, tc.family,
		        se.inat_similar_status, se.inat_resolution_fingerprint,
		        se.similar_status, se.similar_candidates_hash
		   FROM species_enrichment se
		   LEFT JOIN taxonomy_cache tc
		          ON tc.species_code = se.species_code AND tc.category = 'species'
		  WHERE se.species_code = $1`,
		[code]
	);
	const row = r.rows[0];
	return {
		inatTaxonId: row?.inat_taxon_id ?? null,
		inatSciName: row?.inat_sci_name ?? null,
		ebirdSciName: row?.ebird_sci_name ?? null,
		family: row?.family ?? null,
		status: (row?.inat_similar_status ?? 'pending') as InatSimilarStatus,
		fingerprint: row?.inat_resolution_fingerprint ?? null,
		similarStatus: row?.similar_status ?? null,
		similarHash: row?.similar_candidates_hash ?? null
	};
}

/**
 * Reconcile one species' display set and return the offered candidates.
 *
 * Cheap tier: forward resolution + selection (<=30 indexed rows). If the
 * forward fingerprint is unchanged AND the stored hash/status are intact, the
 * persisted display set is returned as-is (this is what makes the
 * taxonomy-sync over-selection affordable, self-review R9). Otherwise the
 * full tier runs reverse-current-source support (CODEX1 F1: reciprocity from
 * CURRENT iNat data only) and rewrites species_similar_display transactionally.
 *
 * The hash over the returned codes is exactly the offered set — one source of
 * truth for the page, the model, and the stored notes.
 */
export async function similarCandidatesFor(code: string): Promise<SimilarCandidateRow[]> {
	return withTransaction(async (client) => {
		const exec = clientExec(client);
		const st = await focalInatState(code, exec);
		const forward = selectInatCandidates(await loadResolvedEdges(code, exec), st.family);
		const fp = forwardFingerprint(forward);
		if (fp === st.fingerprint && st.similarHash !== null && st.similarStatus !== null) {
			const persisted = await exec<{
				resolved_code: string | null;
				inat_sci_name: string;
				misid_count: number | null;
			}>(
				`SELECT d.resolved_code, d.inat_sci_name, d.misid_count
				   FROM species_similar_display d
				  WHERE d.species_code = $1 AND d.resolved_code IS NOT NULL
				  ORDER BY d.position`,
				[code]
			);
			const codes = persisted.rows.map((x) => x.resolved_code as string);
			if (codes.length > 0 || forward.selected.length === 0) {
				const names = await candidateNames(codes, exec);
				return persisted.rows
					.map((x) => {
						const n = names.get(x.resolved_code as string);
						return n
							? {
									code: x.resolved_code as string,
									comName: n.com_name,
									sciName: n.sci_name,
									misidCount: x.misid_count
								}
							: null;
					})
					.filter((x): x is SimilarCandidateRow => x !== null);
			}
			// Fingerprint matches but nothing persisted (e.g. pre-Phase-B rows):
			// fall through to a full reconcile.
		}

		// Full tier: reverse-current-source support. Partners = species whose
		// raw edges point at the focal (id arm, then iNat-binomial arm, then
		// the eBird binomial as a last resort), filtered to those whose OWN
		// selection includes the focal.
		const nameArm = (st.inatSciName ?? st.ebirdSciName)?.toLowerCase() ?? null;
		const partnersRes = await exec<{ species_code: string }>(
			`SELECT DISTINCT sis.species_code
			   FROM species_inat_similar sis
			  WHERE sis.species_code <> $1
			    AND (($2::text IS NOT NULL AND sis.inat_taxon_id::text = $2)
			         OR ($3::text IS NOT NULL AND lower(sis.inat_sci_name) = $3))`,
			[code, st.inatTaxonId, nameArm]
		);
		const reverse: (SimilarCandidateRow & { sourceEdgeTaxonId: string })[] = [];
		const forwardCodes = new Set(forward.selected.map((s) => s.speciesCode));
		for (const p of partnersRes.rows) {
			if (forwardCodes.has(p.species_code)) continue;
			const pState = await focalInatState(p.species_code, exec);
			const pSel = selectInatCandidates(await loadResolvedEdges(p.species_code, exec), pState.family);
			const support = pSel.selected.find((s) => s.speciesCode === code);
			if (support) {
				const names = await candidateNames([p.species_code], exec);
				const n = names.get(p.species_code);
				if (n) {
					reverse.push({
						code: p.species_code,
						comName: n.com_name,
						sciName: n.sci_name,
						misidCount: null,
						sourceEdgeTaxonId: support.inatTaxonId
					});
				}
			}
		}
		reverse.sort((a, b) => a.code.localeCompare(b.code));

		// Persist display set + fingerprint in THIS transaction.
		await exec(`DELETE FROM species_similar_display WHERE species_code = $1`, [code]);
		let pos = 0;
		for (const s of forward.selected) {
			pos++;
			await exec(
				`INSERT INTO species_similar_display
				   (species_code, position, resolved_code, inat_taxon_id, inat_sci_name,
				    inat_com_name, misid_count, origin, unresolved)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, 'forward', FALSE)`,
				[code, pos, s.speciesCode, s.inatTaxonId, s.sciName, null, s.misidCount]
			);
		}
		for (const rrow of reverse) {
			pos++;
			await exec(
				`INSERT INTO species_similar_display
				   (species_code, position, resolved_code, inat_taxon_id, inat_sci_name,
				    inat_com_name, misid_count, origin, unresolved)
				 VALUES ($1, $2, $3, $4, $5, NULL, NULL, 'reverse', FALSE)`,
				[code, pos, rrow.code, rrow.sourceEdgeTaxonId, rrow.sciName]
			);
		}
		for (const u of forward.unresolved) {
			pos++;
			await exec(
				`INSERT INTO species_similar_display
				   (species_code, position, resolved_code, inat_taxon_id, inat_sci_name,
				    inat_com_name, misid_count, origin, unresolved)
				 VALUES ($1, $2, NULL, NULL, $3, $4, $5, 'forward', TRUE)`,
				[code, pos, u.inat_sci_name, u.inat_com_name, u.misid_count]
			);
		}
		const offered: SimilarCandidateRow[] = [
			...forward.selected.map((s) => ({
				code: s.speciesCode,
				comName: s.comName,
				sciName: s.sciName,
				misidCount: s.misidCount as number | null
			})),
			...reverse.map(({ sourceEdgeTaxonId: _sourceEdgeTaxonId, ...candidate }) => candidate)
		];
		const offeredHash = similarCandidatesHash(offered.map((c) => c.code));
		await exec(
			`UPDATE species_enrichment
			    SET inat_resolution_fingerprint = $2,
			        similar_candidates_hash = $3,
			        similar_status = NULL,
			        updated_at = NOW()
			  WHERE species_code = $1`,
			[code, fp, offeredHash]
		);

		return offered;
	});
}

async function candidateNames(
	codes: readonly string[],
	exec: Exec = query
): Promise<Map<string, { com_name: string; sci_name: string }>> {
	if (codes.length === 0) return new Map();
	const r = await exec<{ species_code: string; com_name: string; sci_name: string }>(
		`SELECT species_code, com_name, sci_name FROM taxonomy_cache
		  WHERE category = 'species' AND species_code = ANY($1::text[])`,
		[codes]
	);
	return new Map(r.rows.map((x) => [x.species_code, x]));
}

/**
 * Record the model's terminal per-pair "not confusable" verdicts (self-review
 * R2): stamps declined_at on the raw edges so the NEXT selection excludes
 * them — the decline never retries and never reaches the error lane.
 */
export async function markSimilarDeclined(code: string, declinedCodes: readonly string[]): Promise<void> {
	if (declinedCodes.length === 0) return;
	await withTransaction(async (client) => {
		const exec = clientExec(client);
		const display = await exec<{ resolved_code: string; origin: 'forward' | 'reverse' }>(
			`SELECT resolved_code, origin FROM species_similar_display
			  WHERE species_code = $1 AND resolved_code = ANY($2::text[])`,
			[code, declinedCodes]
		);
		const ownerTargets = new Map<string, Set<string>>();
		for (const row of display.rows) {
			const owner = row.origin === 'forward' ? code : row.resolved_code;
			const target = row.origin === 'forward' ? row.resolved_code : code;
			const targets = ownerTargets.get(owner) ?? new Set<string>();
			targets.add(target);
			ownerTargets.set(owner, targets);
		}
		for (const [owner, targets] of ownerTargets) {
			const taxonIds = (await loadResolvedEdges(owner, exec))
				.filter(
					(e) =>
						typeof e.resolution === 'object' &&
						e.resolution !== null &&
						targets.has(e.resolution.speciesCode)
				)
				.map((e) => e.inatTaxonId);
			if (taxonIds.length > 0) {
				await exec(
					`UPDATE species_inat_similar SET declined_at = NOW()
					  WHERE species_code = $1 AND inat_taxon_id::text = ANY($2::text[])`,
					[owner, taxonIds]
				);
			}
		}
		const owners = [...ownerTargets.keys()];
		await exec(
			`UPDATE species_enrichment SET similar_candidates_hash = NULL, updated_at = NOW()
			  WHERE species_code = $1
			     OR species_code = ANY($2::text[])
			     OR species_code = ANY($3::text[])`,
			[code, declinedCodes, owners]
		);
	});
}

/**
 * Similar-substage bookkeeping WITHOUT the monolithic AI write (CODEX1 F3):
 * touches ONLY the similar_* columns and prunes species_similar rows not in
 * the offered set. Used by the no-call fast path and every reconcile outcome —
 * the hash is ALWAYS written back (self-review R1: a nulled hash must be
 * repopulated or the invalidation marker clause re-selects forever).
 */
export async function reconcileSimilarState(
	code: string,
	offeredCodes: readonly string[],
	hash: string,
	status: 'ok' | 'none',
	model: string | null
): Promise<void> {
	await withTransaction(async (client) => {
		const exec = clientExec(client);
		await exec(
			`UPDATE species_enrichment SET
			   similar_status = $2, similar_candidates_hash = $3,
			   similar_generated_at = NOW(), similar_attempted_at = NOW(),
			   similar_error = NULL,
			   similar_model = CASE WHEN $4::text IS NULL THEN similar_model ELSE $4 END,
			   updated_at = NOW()
			 WHERE species_code = $1`,
			[code, status, hash, model]
		);
		if (offeredCodes.length > 0) {
			await exec(
				`DELETE FROM species_similar
				  WHERE species_code = $1 AND similar_code <> ALL($2::text[])`,
				[code, offeredCodes]
			);
		} else {
			// Candidate sets can genuinely shrink to zero — orphan notes go too
			// (the old keep-list skipped this case; self-review notable c).
			await exec(`DELETE FROM species_similar WHERE species_code = $1`, [code]);
		}
	});
}

/**
 * The species page's card data (td-460b1c Phase B). PURE READ of the
 * persisted display set — no resolution, no selection, no early return
 * (GROK G5: unresolved-only and no_mapping species must keep their
 * explanatory card; a missing enrichment row maps to 'pending').
 */
export async function getSimilarSpecies(code: string, userId: number): Promise<SimilarSpeciesResult> {
	const [statusRes, rowsRes] = await Promise.all([
		query<{ inat_similar_status: string | null }>(
			`SELECT inat_similar_status FROM species_enrichment WHERE species_code = $1`,
			[code]
		),
		query<{
			resolved_code: string | null;
			inat_sci_name: string;
			inat_com_name: string | null;
			misid_count: number | null;
			unresolved: boolean;
			in_scope: boolean;
			com_name: string | null;
			sci_name: string | null;
			seen: boolean;
			note: string | null;
			thumbnail_url: string | null;
			source_url: string | null;
			creator: string | null;
			license_code: string | null;
			license_url: string | null;
			width: number | null;
			height: number | null;
		}>(
			`SELECT d.resolved_code, d.inat_sci_name, d.inat_com_name, d.misid_count, d.unresolved,
			        tc.com_name, tc.sci_name,
			        (ss.species_code IS NOT NULL) AS seen,
			        sim.note,
			        sm.thumbnail_url, sm.source_url, sm.creator,
			        sm.license_code, sm.license_url, sm.width, sm.height,
			        (EXISTS (SELECT 1 FROM seen_species s2 WHERE s2.species_code = d.resolved_code)
			      OR EXISTS (SELECT 1 FROM species_frequency f2 WHERE f2.species_code = d.resolved_code)
			      OR EXISTS (SELECT 1 FROM photo_links p2 WHERE p2.species_code = d.resolved_code)) AS in_scope
			   FROM species_similar_display d
			   LEFT JOIN taxonomy_cache tc
			          ON tc.species_code = d.resolved_code AND tc.category = 'species'
			   LEFT JOIN seen_species ss
			          ON ss.species_code = d.resolved_code AND ss.user_id = $1
			   LEFT JOIN species_similar sim
			          ON sim.species_code = $2 AND sim.similar_code = d.resolved_code
			   LEFT JOIN species_media sm
			          ON sm.species_code = d.resolved_code AND sm.kind = 'photo' AND sm.rank = 1
			  WHERE d.species_code = $2
			  ORDER BY d.position`,
			[userId, code]
		)
	]);
	const inatStatus = (statusRes.rows[0]?.inat_similar_status ?? 'pending') as InatSimilarStatus;
	const similar: SimilarSpeciesRow[] = [];
	const unresolved: UnresolvedSimilarRow[] = [];
	for (const r of rowsRes.rows) {
		if (r.unresolved || r.resolved_code === null) {
			unresolved.push({
				inat_sci_name: r.inat_sci_name,
				inat_com_name: r.inat_com_name,
				misid_count: r.misid_count ?? 0
			});
			continue;
		}
		// A resolved code whose taxonomy row vanished (post-sync churn) is
		// skipped here; the next reconcile heals the display set.
		if (r.com_name === null || r.sci_name === null) continue;
		// Read-time scope filter (self-review R7): a species that LEFT the
		// scope universe disappears immediately; entering scope is healed by
		// the new-species pipeline's partner stamping.
		if (!r.in_scope) continue;
		similar.push({
			species_code: r.resolved_code,
			com_name: r.com_name,
			sci_name: r.sci_name,
			misid_count: r.misid_count,
			note: r.note,
			photo: r.source_url
				? {
						thumbnail_url: r.thumbnail_url,
						source_url: r.source_url,
						creator: r.creator,
						license_code: r.license_code ?? '',
						license_url: r.license_url,
						width: r.width,
						height: r.height
					}
				: null,
			seen: r.seen
		});
	}
	return { similar, unresolved, inatStatus };
}

/**
 * In-scope codes whose media is due: never attempted, stale successful data,
 * or unresolved partial/error media after the daily 24-hour retry interval.
 * An explicit admin scan may include recent failures immediately. Requires
 * a resolved QID — media needs it for the P18/P51 SPARQL lookup, so an
 * unresolved species (still no_mapping) is never a media candidate.
 */
export async function mediaDueCodes(
	opts: { includeRecentFailures?: boolean } = {}
): Promise<string[]> {
	const r = await query<{ species_code: string }>(
		`${SCOPE_SQL}
		 AND EXISTS (
		   SELECT 1 FROM species_enrichment se
		    WHERE se.species_code = tc.species_code
		      AND se.wikidata_qid IS NOT NULL
		      AND (
		            se.media_status IS NULL
		         OR (se.media_status IN ('ok','no_media')
		             AND se.media_fetched_at < NOW() - INTERVAL '${WIKI_REFRESH_DAYS} days')
		         OR (se.media_status IN ('partial','error')
		             AND ($1::boolean
		                  OR se.media_fetched_at <= NOW()
		                     - INTERVAL '${MEDIA_ERROR_RETRY_HOURS} hours'
		                     + INTERVAL '${MEDIA_RETRY_SCAN_SLACK_MINUTES} minutes'))
		      )
		 )
		 ORDER BY 1`,
		[opts.includeRecentFailures === true]
	);
	return r.rows.map((x) => x.species_code);
}

/**
 * Per-species freshness check used by the media chunk handler (idempotent
 * overlap). MUST stay the exact negation of mediaDueCodes' predicate above
 * (minus the never-fresh 'error' state). 'partial' is transient by
 * definition — a xeno-canto outage or an unconfigured XENO_CANTO_API_KEY —
 * so it retries on the daily media window, never the 180-day one: species
 * enriched before the key exists get their sounds on the next daily scan
 * after the key is configured, not months later.
 */
export async function mediaFresh(code: string): Promise<boolean> {
	const r = await query<{ fresh: boolean }>(
		`SELECT ((media_status IN ('ok','no_media')
		          AND media_fetched_at > NOW() - INTERVAL '${WIKI_REFRESH_DAYS} days')
		      OR (media_status = 'partial'
		          AND media_fetched_at > NOW()
		              - INTERVAL '${MEDIA_ERROR_RETRY_HOURS} hours'
		              + INTERVAL '${MEDIA_RETRY_SCAN_SLACK_MINUTES} minutes')) AS fresh
		   FROM species_enrichment WHERE species_code = $1`,
		[code]
	);
	return r.rows[0]?.fresh === true;
}

// ---------------------------------------------------------------------------
// iNaturalist similar-species sourcing (td-460b1c Phase A,
// plan: docs/2026-08-27-similar-species-inat-plan.md §Phase 3).
// Fetch-and-store only: raw confused-with edges land in species_inat_similar;
// selection/resolution/display reconciliation is Phase B.
// ---------------------------------------------------------------------------

export const INAT_REFRESH_DAYS = 180;

/**
 * In-scope codes due for an iNat similar-species fetch. Requires an existing
 * species_enrichment row (wiki stage first, so Wikidata P3151 had its chance
 * to land in cross_ids) AND one of:
 *  - never attempted;
 *  - 'error' past ERROR_RETRY_DAYS;
 *  - 'ok'/'none' past INAT_REFRESH_DAYS;
 *  - 'no_mapping' past INAT_REFRESH_DAYS (restamped clocks — retry precedent);
 *  - mapping mismatch: cross_ids carries an id that is missing from or
 *    different to the stored one — immediate, but ONLY on terminal non-error
 *    statuses (self-review R3: after a failed fetch inat_taxon_id is still
 *    NULL, so an ungated clause would bypass the 7-day error backoff for 98%
 *    of the corpus during any iNat outage);
 *  - P3151 removal: cross_ids lost the id a 'cross'-sourced mapping was built
 *    on — re-verify by name search exactly once (the refetch rewrites
 *    inat_taxon_source to 'search', self-clearing the clause).
 *
 * inatFresh() below MUST stay the exact negation of this predicate.
 */
export async function inatDueCodes(): Promise<string[]> {
	const r = await query<{ species_code: string }>(
		`${SCOPE_SQL}
		 AND EXISTS (
		   SELECT 1 FROM species_enrichment se
		    WHERE se.species_code = tc.species_code
		      AND (
		            se.inat_similar_status IS NULL
		         OR (se.inat_similar_status = 'error'
		             AND se.inat_similar_attempted_at < NOW() - INTERVAL '${ERROR_RETRY_DAYS} days')
		         OR (se.inat_similar_status IN ('ok','none','no_mapping')
		             AND se.inat_similar_fetched_at < NOW() - INTERVAL '${INAT_REFRESH_DAYS} days')
		         OR (se.inat_similar_status IN ('ok','none','no_mapping')
		             AND se.cross_ids ? 'inat_taxon_id'
		             AND (se.inat_taxon_id IS NULL
		                  OR se.inat_taxon_id::text IS DISTINCT FROM se.cross_ids->>'inat_taxon_id'))
		         OR (se.inat_similar_status IN ('ok','none')
		             AND NOT se.cross_ids ? 'inat_taxon_id'
		             AND se.inat_taxon_source = 'cross')
		      )
		 )
		 ORDER BY 1`
	);
	return r.rows.map((x) => x.species_code);
}

/** Per-species freshness for idempotent chunk overlap — exact negation of
 * inatDueCodes' per-row predicate (minus scope, which the chunk already has). */
export async function inatFresh(code: string): Promise<boolean> {
	const r = await query<{ fresh: boolean }>(
		`SELECT (
		      (se.inat_similar_status = 'error'
		       AND se.inat_similar_attempted_at >= NOW() - INTERVAL '${ERROR_RETRY_DAYS} days')
		   OR (se.inat_similar_status IN ('ok','none','no_mapping')
		       AND se.inat_similar_fetched_at >= NOW() - INTERVAL '${INAT_REFRESH_DAYS} days'
		       AND NOT (se.cross_ids ? 'inat_taxon_id'
		                AND (se.inat_taxon_id IS NULL
		                     OR se.inat_taxon_id::text IS DISTINCT FROM se.cross_ids->>'inat_taxon_id'))
		       AND NOT (se.inat_similar_status IN ('ok','none')
		                AND NOT se.cross_ids ? 'inat_taxon_id'
		                AND se.inat_taxon_source = 'cross'))
		 ) AS fresh
		   FROM species_enrichment se WHERE se.species_code = $1`,
		[code]
	);
	return r.rows[0]?.fresh === true;
}

/** True only when the AI similar-note stage may safely consume the current
 * iNat rows. Unlike inatFresh(), a backed-off error is fetch-fresh but is NOT
 * a usable source. Kept as one SQL snapshot so a status/freshness race cannot
 * launch a stale, duplicate-billed note pass. */
export async function inatReadyForAi(code: string): Promise<boolean> {
	const r = await query<{ ready: boolean }>(
		`SELECT (
		      se.inat_similar_status IN ('ok','none','no_mapping')
		      AND se.inat_similar_fetched_at >= NOW() - INTERVAL '${INAT_REFRESH_DAYS} days'
		      AND NOT (se.cross_ids ? 'inat_taxon_id'
		               AND (se.inat_taxon_id IS NULL
		                    OR se.inat_taxon_id::text IS DISTINCT FROM se.cross_ids->>'inat_taxon_id'))
		      AND NOT (se.inat_similar_status IN ('ok','none')
		               AND NOT se.cross_ids ? 'inat_taxon_id'
		               AND se.inat_taxon_source = 'cross')
		 ) AS ready
		   FROM species_enrichment se WHERE se.species_code = $1`,
		[code]
	);
	return r.rows[0]?.ready === true;
}

/** How the focal's iNat taxon id was established. */
export interface InatResolution {
	taxonId: number;
	source: 'cross' | 'search';
	/** iNat canonical binomial when known (search result / taxa lookup). */
	sciName: string | null;
}

/** Edge rows as stored (subset of the gateway's normalized shape). */
export interface InatEdgeInput {
	taxonId: number;
	misidCount: number;
	sciName: string;
	comName: string | null;
}

/**
 * Null the similar-stage candidate hash of every species that one of `edges`
 * resolves to — the targeted-invalidation marker (AGY A3 / self-review R6).
 * Resolution here is the cheap indexed two-arm form; over-inclusive matches
 * (sci-name collisions) only cause an extra no-op reconcile, never staleness.
 * No-consumer in Phase A (aiDueCodes learns the marker clause in Phase B);
 * stamping now keeps every write forward-correct.
 */
async function stampPartnersStale(
	exec: Exec,
	focalCode: string,
	edges: readonly Pick<InatEdgeInput, 'taxonId' | 'sciName'>[]
): Promise<void> {
	if (edges.length === 0) return;
	const ids = edges.map((e) => String(e.taxonId));
	const names = edges.map((e) => e.sciName.toLowerCase());
	await exec(
		`UPDATE species_enrichment SET similar_candidates_hash = NULL, updated_at = NOW()
		  WHERE species_code <> $1
		    AND species_code IN (
		      SELECT tc.species_code
		        FROM taxonomy_cache tc
		        LEFT JOIN species_enrichment se ON se.species_code = tc.species_code
		       WHERE tc.category = 'species'
		         AND (se.cross_ids->>'inat_taxon_id' = ANY($2::text[])
		              OR lower(tc.sci_name) = ANY($3::text[]))
		    )`,
		[focalCode, ids, names]
	);
}

/**
 * Successful fetch: replace the focal's raw edge set and stamp the sourcing
 * state, in ONE transaction.
 *  - `declined_at` SURVIVES refetches (self-review R2: a decline is terminal
 *    per-pair) — hence upsert + prune, never DELETE-all + INSERT.
 *  - Partners on BOTH sides of the edge diff (added AND removed) get their
 *    candidate hash nulled (self-review R6: dropped edges must propagate the
 *    pair's retirement, or preserved reverse notes live forever).
 *  - status: 'ok' when any edge remains, 'none' when iNat returned nothing.
 */
export async function upsertInatSimilar(
	code: string,
	resolution: InatResolution,
	rows: readonly InatEdgeInput[]
): Promise<void> {
	await withTransaction(async (client) => {
		const exec = clientExec(client);
		const before = await exec<{
			inat_taxon_id: string;
			misid_count: number;
			inat_sci_name: string;
			inat_com_name: string | null;
		}>(
			`SELECT inat_taxon_id, misid_count, inat_sci_name, inat_com_name
			   FROM species_inat_similar
			  WHERE species_code = $1`,
			[code]
		);
		const beforeById = new Map(before.rows.map((r) => [String(r.inat_taxon_id), r]));
		const contentChanged =
			before.rows.length !== rows.length ||
			rows.some((r) => {
				const old = beforeById.get(String(r.taxonId));
				return (
					old === undefined ||
					old.misid_count !== r.misidCount ||
					old.inat_sci_name !== r.sciName ||
					old.inat_com_name !== r.comName
				);
			});
		const affectedEdges = contentChanged
			? [
					...before.rows.map((r) => ({
						taxonId: Number(r.inat_taxon_id),
						sciName: r.inat_sci_name
					})),
					...rows
				]
			: [];

		await exec(
			`DELETE FROM species_inat_similar
			  WHERE species_code = $1 AND inat_taxon_id <> ALL($2::bigint[])`,
			[code, rows.map((r) => r.taxonId)]
		);
		for (let i = 0; i < rows.length; i++) {
			const e = rows[i];
			await exec(
				`INSERT INTO species_inat_similar
				   (species_code, inat_taxon_id, rank, misid_count, inat_sci_name, inat_com_name, fetched_at)
				 VALUES ($1, $2, $3, $4, $5, $6, NOW())
				 ON CONFLICT (species_code, inat_taxon_id) DO UPDATE SET
				   rank = $3, misid_count = $4, inat_sci_name = $5, inat_com_name = $6,
				   fetched_at = NOW()`,
				[code, e.taxonId, i + 1, e.misidCount, e.sciName, e.comName]
			);
		}
		await exec(
			`INSERT INTO species_enrichment
			   (species_code, inat_taxon_id, inat_taxon_source, inat_sci_name,
			    inat_similar_status, inat_similar_fetched_at, inat_similar_attempted_at,
			    inat_similar_error)
			 VALUES ($1, $2, $3, $4, $5, NOW(), NOW(), NULL)
			 ON CONFLICT (species_code) DO UPDATE SET
			   inat_taxon_id = $2, inat_taxon_source = $3,
			   inat_sci_name = COALESCE($4, species_enrichment.inat_sci_name),
			   inat_similar_status = $5, inat_similar_fetched_at = NOW(),
			   inat_similar_attempted_at = NOW(), inat_similar_error = NULL,
			   updated_at = NOW()`,
			[code, resolution.taxonId, resolution.source, resolution.sciName, rows.length > 0 ? 'ok' : 'none']
		);
		if (rows.length === 0) {
			// A terminal empty source set cannot keep serving the old display while
			// it waits for the cheap no-call prune. Clear the materialization and
			// leave an explicit due marker in the same transaction.
			await exec(`DELETE FROM species_similar_display WHERE species_code = $1`, [code]);
			await exec(
				`UPDATE species_enrichment
				    SET inat_resolution_fingerprint = NULL,
				        similar_candidates_hash = NULL,
				        updated_at = NOW()
				  WHERE species_code = $1`,
				[code]
			);
		}
		await stampPartnersStale(exec, code, affectedEdges);
	});
}

/**
 * Focal unmappable to iNat's taxonomy. One transaction: terminal status with
 * BOTH clocks restamped (retry-forever precedent — job-handlers wiki
 * no_mapping), stale edges deleted, and their former partners stamped
 * (self-review R6). inat_taxon_source is cleared so the P3151-removal clause
 * cannot re-fire against a mapping that no longer exists.
 */
export async function markInatNoMapping(code: string): Promise<void> {
	await withTransaction(async (client) => {
		const exec = clientExec(client);
		const stale = await exec<{ inat_taxon_id: string; inat_sci_name: string }>(
			`DELETE FROM species_inat_similar WHERE species_code = $1
			 RETURNING inat_taxon_id, inat_sci_name`,
			[code]
		);
		await exec(
			`INSERT INTO species_enrichment
			   (species_code, inat_similar_status, inat_similar_fetched_at,
			    inat_similar_attempted_at, inat_similar_error)
			 VALUES ($1, 'no_mapping', NOW(), NOW(), NULL)
			 ON CONFLICT (species_code) DO UPDATE SET
			   inat_similar_status = 'no_mapping', inat_similar_fetched_at = NOW(),
			   inat_similar_attempted_at = NOW(), inat_similar_error = NULL,
			   inat_taxon_id = NULL, inat_taxon_source = NULL,
			   updated_at = NOW()`,
			[code]
		);
		await exec(`DELETE FROM species_similar_display WHERE species_code = $1`, [code]);
		await exec(
			`UPDATE species_enrichment
			    SET inat_resolution_fingerprint = NULL,
			        similar_candidates_hash = NULL,
			        updated_at = NOW()
			  WHERE species_code = $1`,
			[code]
		);
		await stampPartnersStale(
			exec,
			code,
			stale.rows.map((r) => ({ taxonId: Number(r.inat_taxon_id), sciName: r.inat_sci_name }))
		);
	});
}

/**
 * Transient sourcing failure: status/error/attempted_at ONLY. Existing edges
 * are PRESERVED (last-good, matching markMediaError) and fetched_at does not
 * move — the 7-day error lane owns the retry.
 */
export async function markInatError(code: string, message: string): Promise<void> {
	await query(
		`INSERT INTO species_enrichment
		   (species_code, inat_similar_status, inat_similar_error, inat_similar_attempted_at)
		 VALUES ($1, 'error', $2, NOW())
		 ON CONFLICT (species_code) DO UPDATE SET
		   inat_similar_status = 'error', inat_similar_error = $2,
		   inat_similar_attempted_at = NOW(), updated_at = NOW()`,
		[code, sanitizeErrorText(message).slice(0, 500)]
	);
}

function commonsPhotoCandidate(filename: string, info: CommonsFileInfo): MediaCandidate | null {
	if (!isDisplayableImage(info.mimeType) || !info.licenseCode) return null;
	return {
		kind: 'photo',
		vocalization_type: null,
		rank: 1,
		provider: 'wikimedia_commons',
		provider_id: filename,
		media_url: info.url,
		thumbnail_url: info.thumbUrl,
		source_url: commonsSourceUrl(filename),
		title: null,
		creator: info.artist,
		license_code: info.licenseCode,
		license_url: info.licenseUrl,
		location: null,
		duration_seconds: null,
		width: info.width,
		height: info.height
	};
}

/** vocalization_type = null (§4/GROK gap #4 — P51 audio has no type from Commons). */
function commonsAudioCandidate(filename: string, info: CommonsFileInfo): MediaCandidate | null {
	if (!isPlayableAudio(info.mimeType) || !info.licenseCode) return null;
	return {
		kind: 'sound',
		vocalization_type: null,
		rank: 1,
		provider: 'wikimedia_commons',
		provider_id: filename,
		media_url: info.url,
		thumbnail_url: null,
		source_url: commonsSourceUrl(filename),
		title: null,
		creator: info.artist,
		license_code: info.licenseCode,
		license_url: info.licenseUrl,
		location: null,
		duration_seconds: info.duration,
		width: null,
		height: null
	};
}

function xenoCantoSoundCandidate(
	rec: XenoCantoRecording,
	vocalizationType: 'song' | 'call',
	rank: number
): MediaCandidate {
	return {
		kind: 'sound',
		vocalization_type: vocalizationType,
		rank,
		provider: 'xeno_canto',
		provider_id: rec.xcId,
		media_url: rec.mediaUrl,
		thumbnail_url: null,
		source_url: rec.sourceUrl,
		title: null,
		creator: rec.recordist,
		license_code: rec.license,
		license_url: rec.licenseUrl,
		location: rec.location,
		duration_seconds: rec.duration,
		width: null,
		height: null
	};
}

/**
 * One representative photo + up to two sounds (prefer song + call) for one
 * species. Fatal-vs-soft split (§6d): a Wikidata/Commons failure THROWS —
 * both are structural to finding ANY media, so the caller (runEnrichSpecies-
 * Media) catches and calls markMediaError, preserving last-good rows. A
 * xeno-canto failure (including a missing API key) is caught HERE and never
 * fails the whole operation — the Commons photo, if any, still gets written,
 * previously-stored xeno-canto sounds are preserved (last-good), and the
 * status downgrades to 'partial' (retried on the short ERROR window).
 */
export async function enrichSpeciesMedia(
	code: string,
	qid: string,
	sciName: string,
	opts: { signal?: AbortSignal; fetcher?: typeof fetch } = {}
): Promise<'ok' | 'partial' | 'no_media'> {
	const wdMedia = await fetchWikidataMedia([qid], opts);
	const wd = wdMedia.get(qid) ?? null;
	const filenames = [
		...new Set([wd?.imageFilename, wd?.audioFilename].filter((f): f is string => f != null))
	];
	const commonsInfo = await fetchCommonsFileInfo(filenames, opts);

	const candidates: MediaCandidate[] = [];
	if (wd?.imageFilename) {
		const info = commonsInfo.get(wd.imageFilename);
		const photo = info ? commonsPhotoCandidate(wd.imageFilename, info) : null;
		if (photo) candidates.push(photo);
	}
	let commonsAudioOk = false;
	if (wd?.audioFilename) {
		const info = commonsInfo.get(wd.audioFilename);
		const audio = info ? commonsAudioCandidate(wd.audioFilename, info) : null;
		if (audio) {
			candidates.push(audio);
			commonsAudioOk = true;
		}
	}

	// SOFT zone: ordinary xeno-canto failures (including a missing key) yield
	// a partial Commons result. A provider rate limit must retain ownership in
	// the worker so Retry-After is honored and last-good rows are preserved.
	let xcOk = true;
	let xc: {
		song: XenoCantoRecording | null;
		call: XenoCantoRecording | null;
		downloadsRestricted: boolean;
	} = {
		song: null,
		call: null,
		downloadsRestricted: false
	};
	try {
		xc = await fetchXenoCantoRecordings(sciName, opts);
	} catch (err) {
		if (err instanceof XenoCantoError && err.rateLimited) throw err;
		xcOk = false;
		const message = sanitizeErrorText(err instanceof Error ? err.message : String(err)).slice(
			0,
			200
		);
		console.warn(`[species-media] ${code} xeno-canto partial: ${message}`);
	}
	if (xcOk) {
		if (commonsAudioOk) {
			// Commons audio already occupies rank=1 — only the call fills rank=2.
			if (xc.call) candidates.push(xenoCantoSoundCandidate(xc.call, 'call', 2));
		} else {
			if (xc.song) candidates.push(xenoCantoSoundCandidate(xc.song, 'song', 1));
			if (xc.call) candidates.push(xenoCantoSoundCandidate(xc.call, 'call', 2));
		}
	} else {
		// Last-good preservation for the SOFT path (same invariant markMediaError
		// enforces for thrown errors): a transient xeno-canto failure must not
		// blank sounds that were already showing — upsertMediaOk is a full
		// replace, so carry surviving prior xeno-canto rows forward into slots
		// the new candidates don't occupy.
		const prior = await query<MediaRow>(
			`SELECT media_id, species_code, kind, vocalization_type, rank, provider, provider_id,
			        media_url, thumbnail_url, source_url, title, creator, license_code, license_url,
			        location, duration_seconds, width, height
			   FROM species_media
			  WHERE species_code = $1 AND kind = 'sound' AND provider = 'xeno_canto'
			  ORDER BY rank`,
			[code]
		);
		const takenRanks = new Set(
			candidates.filter((c) => c.kind === 'sound').map((c) => c.rank)
		);
		for (const row of prior.rows) {
			if (takenRanks.has(row.rank)) continue;
			const { media_id: _id, species_code: _code, ...candidate } = row;
			candidates.push(candidate);
			takenRanks.add(row.rank);
		}
	}

	// Belt-and-braces (§6d step 7) — the Commons builders enforce this by
	// construction; xeno-canto's license passes through unchecked, so an
	// empty-string license is still caught here.
	const accepted = candidates.filter(
		(c) => c.media_url.trim().length > 0 && c.source_url && c.license_code
	);
	const hasAcceptedSound = accepted.some((c) => c.kind === 'sound');
	const audioStatus = xcOk && xc.downloadsRestricted && !hasAcceptedSound ? 'restricted' : null;

	const status: 'ok' | 'partial' | 'no_media' = !xcOk
		? 'partial'
		: accepted.length > 0
			? 'ok'
			: 'no_media';

	// upsertMediaOk owns its own transaction when called without an executor.
	await upsertMediaOk(code, accepted, status, audioStatus);
	return status;
}

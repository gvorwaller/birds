/**
 * LLM annotation stage for species enrichment (plan Phase 2, td-47d6d5):
 * reads the STORED Wikipedia prose for one species and produces (a) tags
 * from the controlled vocabulary and (b) 2–4 hedged field-craft sentences —
 * including, for tidal species, which tide stage is most productive (the
 * question no dataset ships an answer to).
 *
 * Evidence rule (Gaylon-approved plan decision): this runs ONLY when
 * Wikipedia prose exists — the model annotates sourced text plus
 * well-established natural history, never free-associates from nothing.
 * Modeled on ai-guidance.ts: direct Messages API call, key from $env,
 * never logged.
 */
import { env } from '$env/dynamic/private';
import { TAG_VOCABULARY, TAG_DIMENSIONS, validateTags, MAX_TAGS } from '$lib/species-tags';
import { parseRetryAfterMs } from '$server/wikidata';
import type { WikiSection } from '$server/wikipedia';

/**
 * Opus tier, deliberately (td-8f0ed8): this stage is a knowledge-and-judgment
 * task — "given these candidates and this article, state the mark that
 * separates them" — and the failure mode is a plausible-but-wrong field mark,
 * which nobody can cheaply audit across ~1,400 notes. The cost delta over
 * Sonnet is tens of dollars one-time; a wrong field mark is wrong forever.
 */
export const AI_MODEL = 'claude-opus-5';
export const FIELD_CRAFT_MAX_CHARS = 700;
/** Prompt input cap — extract + selected sections, roughly 10k chars. */
const PROSE_CAP = 10_000;
/**
 * Per-request budget. Opus 5 with adaptive thinking runs 7-41s on this prompt,
 * so the previous 45s sat directly on the tail and silently cost species to
 * timeouts that were then mislabelled as network failures.
 */
export const AI_TIMEOUT_MS = 120_000;
/**
 * Upper bound on one distinguishing note.
 *
 * This is a safety valve, not a design target. The earlier value (200) was
 * chosen to fit a card row before any real note existed, which optimised
 * layout tidiness over field usefulness — the wrong trade for a birding app.
 * A real guide's Downy-vs-Hairy entry is several sentences (relative size,
 * bill-to-head ratio, outer tail pattern, call), and one clause cannot clinch
 * an ID that genuinely needs three marks.
 *
 * `species_similar.note` is Postgres TEXT — unbounded — so nothing downstream
 * requires a limit. This exists only to stop a runaway response from putting
 * an essay in a card.
 */
export const SIMILAR_NOTE_MAX_CHARS = 500;
/**
 * Cap on notes per species. Set to the measured maximum fan-out (7) rather than
 * below it: at 5 the schema could mark 6-7 slash keys required and the parser
 * would then truncate the surplus, discarding notes the model was obliged to
 * write. Over-cap rejections are still recorded, but they should now be
 * unreachable via the slash tier.
 */
export const MAX_SIMILAR = 7;
/**
 * Floor on a usable note.
 *
 * Making `similar` a required schema field guarantees the key is PRESENT, not
 * that it is MEANINGFUL — a live run returned a one-character note, satisfying
 * the schema with junk. A real separating mark ("Bill is longer than the head,
 * and the nape shows a dark spur") cannot be expressed in a handful of
 * characters, so anything shorter is treated as a non-answer and routed to the
 * retry rather than written to the page.
 *
 * Set to 20, not 40: "Voice only; plumage identical" is 29 characters and is
 * EXACTLY the answer the prompt asks for on an inseparable slash pair, so a
 * 40-char floor rejected the truth and pushed those pairs toward a permanent
 * miss (GROK P2). Length is a weak predicate in both directions — it cannot
 * tell a terse truth from a stub — which is why the malformed-text check below
 * carries the real quality load.
 */
export const SIMILAR_NOTE_MIN_CHARS = 20;

export class EnrichmentAiError extends Error {
	constructor(
		message: string,
		public status: number,
		public rateLimited: boolean,
		/** Parsed Retry-After when Anthropic sent one (CODEX1 P2 #3). */
		public retryAfterMs: number | null = null
	) {
		super(message);
		this.name = 'EnrichmentAiError';
	}
}

/** One candidate offered to the model — a CLOSED set it must choose from. */
export interface SimilarCandidate {
	code: string;
	comName: string;
	sciName: string;
	/**
	 * Which tier produced this candidate. Surfaced to the model because the two
	 * carry very different priors: an eBird slash taxon means Cornell groups the
	 * pair precisely BECAUSE field separation is hard, so "no useful difference"
	 * is essentially never right there. A same-genus candidate may genuinely not
	 * be a look-alike.
	 */
	basis: 'ebird_slash' | 'genus';
	/**
	 * This candidate already has a note about the focal species on ITS page, so
	 * a note is owed in return. Confusability is mutual even though the note is
	 * directional; without this the genus tier decides independently in each
	 * direction and one page ends up with a bare "Same genus" row.
	 */
	reciprocal?: boolean;
}

export interface SpeciesAnnotation {
	tags: string[];
	fieldCraft: string;
	/** Vocabulary misses the model attempted — surfaced in job events. */
	droppedTags: string[];
	/** Distinguishing notes, keyed to candidate codes. Empty is a valid result. */
	similar: { code: string; note: string }[];
	/** Codes the model returned that were not in the candidate set. */
	droppedSimilar: string[];
}

const SYSTEM =
	'You are a birding field-guidance assistant annotating one species from ' +
	'its Wikipedia article. Base everything on the provided text plus ' +
	'well-established natural history. Hedge behavioral claims ("often", ' +
	'"typically", "try"). Never invent specific sightings, numbers, or facts ' +
	'you are unsure of. Respond with ONLY the requested JSON object.';

function vocabularyBlock(): string {
	return TAG_DIMENSIONS.map((d) => `${d}: ${TAG_VOCABULARY[d].join(', ')}`).join('\n');
}

/** Sections most useful to field craft, capped for prompt size. */
function proseBlock(extract: string, sections: readonly WikiSection[]): string {
	// "description" is already stored by wikipedia.ts (SECTION_KEYWORDS) but was
	// never fed to the model — and it is the section most relevant to what a bird
	// LOOKS like, which the similar-species notes depend on (td-8f0ed8 Step 0).
	const wanted =
		/description|habitat|distribution|behavio|ecology|feeding|diet|breeding|migration/i;
	let out = extract;
	for (const s of sections) {
		if (!wanted.test(s.title)) continue;
		if (out.length >= PROSE_CAP) break;
		out += `\n\n${s.title}:\n${s.text}`;
	}
	return out.slice(0, PROSE_CAP);
}

/**
 * The candidate block. Codes are handed to the model verbatim so it SELECTS
 * from a closed set rather than naming species itself — the same containment
 * `validateTags` gives the tag vocabulary.
 */
function candidateBlock(candidates: readonly SimilarCandidate[]): string {
	return candidates
		.map(
			(c) =>
				`${c.code} = ${c.comName} (${c.sciName}) — ` +
				(c.basis === 'ebird_slash'
					? 'eBird reporting group: routinely confused in the field'
					: c.reciprocal === true
						? "same genus, and this app already explains the pair on that species' page — a note is owed here too"
						: 'same genus: may or may not be a look-alike')
		)
		.join('\n');
}

export function buildUserPrompt(input: {
	comName: string;
	sciName: string;
	family: string | null;
	extract: string;
	sections: readonly WikiSection[];
	candidates?: readonly SimilarCandidate[];
}): string {
	const candidates = input.candidates ?? [];
	return (
		`Species: ${input.comName} (${input.sciName})` +
		(input.family ? ` — family ${input.family}` : '') +
		`\n\nWikipedia article text:\n${proseBlock(input.extract, input.sections)}\n\n` +
		`Tag vocabulary (the ONLY allowed values, format "dimension:value"):\n` +
		`${vocabularyBlock()}\n\n` +
		(candidates.length > 0
			? `Species this one might be confused with (the ONLY allowed codes):\n` +
				`${candidateBlock(candidates)}\n` +
				// Observed in production on day one: for American White Pelican the
				// model returned "brnpel1" when the list said "brnpel". It knew the
				// right species and mistyped the identifier — almost certainly
				// pattern-matching eBird's common trailing-digit convention. The
				// closed-set check rejects that, so the cost is a silently missing
				// note rather than bad data; this line is the cheap way to stop
				// losing the note in the first place.
				`Copy each code EXACTLY as written above, character for character. ` +
				`Do not add or remove a trailing digit, do not "correct" a code to ` +
				`the form you expect, and do not construct a code for any species ` +
				`not listed.\n\n`
			: '') +
		`Produce:\n` +
		`1. "tags": up to ${MAX_TAGS} tags chosen ONLY from the vocabulary above, ` +
		`prefixed "dimension:value" (e.g. "habitat:mudflat"). Include tide: values ` +
		`ONLY for species that regularly use tidal habitats; every tidal species ` +
		`MUST get exactly one tide: value.\n` +
		`2. "field_craft": 2-4 hedged sentences answering when, where, and how a ` +
		`birder finds this species — habitat micro-placement, time of day, and the ` +
		`cue to look or listen for. For tidal species, explicitly state which tide ` +
		`stage is most productive and why. Under ${FIELD_CRAFT_MAX_CHARS} characters.\n` +
		(candidates.length > 0
			? `3. "similar": an object whose KEYS are candidate codes from the list ` +
				`above and whose values are the note for that species.\n` +
				// Calibration, not decoration. Under a flat "an empty list is a valid
				// answer" this stage returned NOTHING on roughly one call in three
				// during bring-up — including for pairs eBird itself groups as
				// confusable, where silence is close to always wrong.
				`   ALWAYS write a note for every "eBird reporting group" candidate: ` +
				`those are grouped because experienced birders confuse them, so a ` +
				`separating mark always exists even when it is subtle. Say what it is, ` +
				`and say plainly when the two are effectively inseparable except by ` +
				`voice or in certain plumages — that is itself the useful answer. For ` +
				`"same genus" candidates, include one only if the two could actually be ` +
				`mistaken for each other; skip the rest.\n` +
				`   Each "note" tells a birder in the field how to separate THAT species ` +
				`from ${input.comName}. Write about the candidate, not about ` +
				`${input.comName}. Lead with the single most reliable mark, then add the ` +
				`one or two secondary marks that confirm it — structure and proportion ` +
				`(bill-to-head ratio, relative size), plumage detail, or voice. Prefer ` +
				`marks visible on a bird in the field over range or behaviour. One to ` +
				`three sentences, under ${SIMILAR_NOTE_MAX_CHARS} characters — a pair that ` +
				`separates on one clean mark needs only one sentence.\n`
			: '') +
		`\nRespond with ONLY this JSON object, nothing else:\n` +
		(candidates.length > 0
			? `{"tags": ["..."], "field_craft": "...", "similar": {"<code>": "<note>"}}`
			: `{"tags": ["..."], "field_craft": "..."}`)
	);
}

/**
 * Response schema for structured outputs.
 *
 * This replaces asking nicely. Two failures were measured against a prose-only
 * prompt on live traffic:
 *   - `similar` omitted entirely on ~1 call in 5, which persisted as a terminal
 *     'none' and silently cost that species its notes;
 *   - a code returned as "brnpel1" when the list said "brnpel" — right species,
 *     invented identifier.
 * Pinning `code` to the offered candidates makes the second UNREPRESENTABLE —
 * that part is structural. Marking `similar` required does NOT do the same for
 * the first: it guarantees the key, not a sentence, and "" satisfies it. The
 * retry loop and the validator carry that load. (This sentence previously
 * claimed otherwise; it was wrong, in the same way three earlier claims in this
 * file were wrong.)
 *
 * Deliberately no maxLength/maxItems: the structured-output schema subset does
 * not support string or complex array constraints, so length capping stays in
 * clampNote() and the MAX_SIMILAR slice. The schema governs SHAPE; the parser
 * still governs SIZE.
 */
export function buildOutputSchema(candidates: readonly SimilarCandidate[]): Record<string, unknown> {
	const properties: Record<string, unknown> = {
		tags: { type: 'array', items: { type: 'string' } },
		field_craft: { type: 'string' }
	};
	const required = ['tags', 'field_craft'];

	if (candidates.length > 0) {
		// `similar` is an OBJECT keyed by species code, not an array of
		// {code, note}. That is what lets the schema distinguish the two tiers:
		// every eBird-slash candidate goes in `required`, so a note for it is
		// structurally mandatory, while genus candidates stay optional.
		//
		// The array form could not express this — the schema subset has no
		// minItems — and it showed: with one slash candidate and nothing else,
		// the model returned an empty array on 3 of 5 live runs, judging a hard
		// pair (Greater/Lesser Scaup) unseparable. But eBird grouping a pair IS
		// the claim that birders need help telling them apart, so silence is the
		// one answer that cannot be right. Now it must say something, including
		// "these are effectively inseparable except by X" — which is itself the
		// useful answer.
		//
		// `additionalProperties: false` plus one property per candidate makes an
		// invented code (the observed "brnpel1") unrepresentable — that part IS
		// structural. `required` is NOT: it guarantees the key exists, not that
		// its value is a sentence, and "" satisfies it (the subset has no
		// minLength, just as it has no maxLength). Live runs returned empty
		// values for required slash keys, so the retry loop and the validator
		// below are load-bearing, not belt-and-braces (GROK P2).
		const noteProps: Record<string, unknown> = {};
		for (const c of candidates) noteProps[c.code] = { type: 'string' };

		properties.similar = {
			type: 'object',
			properties: noteProps,
			// Required = Cornell says they are confused, OR we have already told the
			// user they are confused on the other species' page.
			required: candidates
				.filter((c) => c.basis === 'ebird_slash' || c.reciprocal === true)
				.map((c) => c.code),
			additionalProperties: false
		};
		required.push('similar');
	}

	return { type: 'object', properties, required, additionalProperties: false };
}

type Fetcher = typeof fetch;

/**
 * Annotate one species. Throws EnrichmentAiError on transport/API failures;
 * returns validated, vocabulary-enforced output on success.
 */
export async function generateSpeciesAnnotation(
	input: {
		comName: string;
		sciName: string;
		family: string | null;
		extract: string;
		sections: readonly WikiSection[];
		candidates?: readonly SimilarCandidate[];
		/** Excluded from its own similar list, belt-and-braces. */
		speciesCode?: string;
	},
	fetcher: Fetcher = fetch
): Promise<SpeciesAnnotation> {
	const apiKey = env.ANTHROPIC_API_KEY;
	if (!apiKey) {
		throw new EnrichmentAiError('AI enrichment is not configured (no API key set).', 0, false);
	}
	let res: Response;
	try {
		res = await fetcher('https://api.anthropic.com/v1/messages', {
			method: 'POST',
			headers: {
				'x-api-key': apiKey,
				'anthropic-version': '2023-06-01',
				// Gates the `fallbacks: 'default'` parameter below. The scalar
				// 'default' form takes THIS header specifically — the array form
				// takes -2026-06-01, and pairing either with the other returns 400.
				'anthropic-beta': 'server-side-fallback-2026-07-01',
				'content-type': 'application/json'
			},
			body: JSON.stringify({
				model: AI_MODEL,
				// max_tokens caps thinking AND response text together. Opus 5 thinks
				// by default, so the 1600 that fit Sonnet 4.6's no-thinking output
				// would now truncate mid-JSON. Sized for adaptive thinking at medium
				// effort plus tags + field craft + MAX_SIMILAR notes at the full
				// SIMILAR_NOTE_MAX_CHARS. This is a ceiling, not a reservation —
				// billing follows tokens actually generated, so headroom is free and
				// a truncated JSON response costs the whole species a 7-day retry.
				max_tokens: 8000,
				// Explicit rather than relying on the default: Opus 5 runs adaptive
				// when `thinking` is omitted, but stating it keeps the intent legible
				// and survives a future default change. Do NOT disable thinking here
				// — on Opus 5 that is documented to occasionally leak <thinking> tags
				// into the visible response, which would break parseAnnotation.
				thinking: { type: 'adaptive' },
				output_config: {
					// Default is `high`; medium is the cost/quality balance for a
					// bounded annotation task with the source text already supplied.
					effort: 'medium',
					// Constrains the response shape — see buildOutputSchema.
					format: { type: 'json_schema', schema: buildOutputSchema(input.candidates ?? []) }
				},
				// Opus 5 ships elevated safety classifiers that can decline a request
				// outright. Bird identification will not realistically trip them, but
				// a decline is otherwise a hard stop for that species, so let the API
				// re-run it on the recommended fallback rather than burning the
				// substage's 7-day error window.
				fallbacks: 'default',
				system: SYSTEM,
				messages: [{ role: 'user', content: buildUserPrompt(input) }]
			}),
			signal: AbortSignal.timeout(AI_TIMEOUT_MS)
		});
	} catch (err) {
		// Distinguishing these is not cosmetic: two species were lost on the first
		// Opus 5 drain to a 45s abort that was reported as a network failure, in
		// both the job event and similar_error (GROK P1). Happy-path latency is
		// 7-41s, so the old budget sat on the tail of the real distribution.
		if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
			throw new EnrichmentAiError(
				`AI request exceeded ${Math.round(AI_TIMEOUT_MS / 1000)}s.`,
				0,
				false
			);
		}
		throw new EnrichmentAiError('Could not reach the AI service.', 0, false);
	}
	if (res.status === 429) {
		throw new EnrichmentAiError(
			'AI service rate-limited.',
			429,
			true,
			parseRetryAfterMs(res.headers.get('retry-after'))
		);
	}
	if (res.status === 401) {
		throw new EnrichmentAiError('AI API key missing or invalid.', 401, false);
	}
	if (!res.ok) {
		throw new EnrichmentAiError(`AI service error (${res.status}).`, res.status, false);
	}

	/* eslint-disable @typescript-eslint/no-explicit-any */
	const data = (await res.json()) as any;
	if (data.stop_reason === 'refusal') {
		throw new EnrichmentAiError('The AI declined this species.', 0, false);
	}
	const text: string = (data.content ?? [])
		.filter((b: any) => b.type === 'text')
		.map((b: any) => b.text)
		.join('')
		.trim();
	/* eslint-enable @typescript-eslint/no-explicit-any */

	return parseAnnotation(text, {
		candidates: (input.candidates ?? []).map((c) => c.code),
		focalCode: input.speciesCode
	});
}

/**
 * Reject a note whose TEXT is malformed, independent of whether its content is
 * true. This is not a nonsense detector — no such thing exists for free prose —
 * but the one corrupted note that reached production had objective structural
 * damage, and that is codeable:
 *
 *   "...care on each individual., bircapped birds aside, focus on
 *    body tone.the bircolour is the cleanest mark."
 *
 * Two signatures there are ungrammatical in any English sentence: sentence-end
 * punctuation immediately followed by a comma or semicolon, and a sentence-end
 * period butted straight against a lowercase letter with no space. Both are
 * degeneration artefacts, not style.
 *
 * Deliberately conservative — it must never reject a correct note:
 *   - the period-then-lowercase rule ignores short leading tokens, so "e.g.",
 *     "i.e.", "cf.", "ssp." and similar abbreviations pass untouched;
 *   - nothing here judges meaning, so a fluent-but-wrong field mark still gets
 *     through. That risk is real and is why the card carries the verify-in-the-
 *     field caveat; this only catches text that is broken on its face.
 *
 * IMPORTANT, so the catch rate is not misread: this does NOT detect the
 * syllable-doubling itself. "plplainer", "parparrow", "slorter", "rufer" are
 * invisible to it. Every one of the 10 corrupted prod notes was caught because
 * it ALSO carried punctuation damage. A degenerated tail with clean punctuation
 * still ships. The audit rate is a property of that corpus, not a guarantee.
 */
export function isMalformedNote(note: string): boolean {
	// "individual., bircapped" — sentence end followed by more punctuation.
	if (/[.!?]\s*[,;]/.test(note)) return true;
	// "tone.the" — sentence end glued to the next word. A token of 4+ characters
	// before the period rules out the common abbreviations.
	if (/[A-Za-z]{4}\.[a-z]/.test(note)) return true;
	// Doubled sentence-enders that are not an ellipsis.
	if (/[!?]{2,}|\.{2}(?!\.)/.test(note)) return true;
	return false;
}

/**
 * Trim an over-long note to the cap WITHOUT cutting a word in half.
 *
 * A blunt `.slice()` was fine when this stage ran on a model that respected the
 * length instruction; on an Opus-tier model, which writes longer by default,
 * it reliably produced notes ending mid-word ("...roughly equal to hea"). That
 * reads as a rendering bug on the species page.
 *
 * Prefer the last sentence boundary inside the cap; fall back to the last word
 * boundary with an ellipsis so the truncation is visibly deliberate. The
 * ellipsis is not placeholder content — it marks elision of real text.
 */
export function clampNote(raw: string): string {
	const note = raw.trim().replace(/\s+/g, ' ');
	if (note.length <= SIMILAR_NOTE_MAX_CHARS) return note;

	const head = note.slice(0, SIMILAR_NOTE_MAX_CHARS);
	// Both boundaries need the same floor: a break too early in the string
	// (an abbreviation's period at char 6, or the single space in
	// "Approx. cccc…") would throw away almost the whole note. Below the floor
	// it is better to hard-cut at the cap than to emit a two-word fragment.
	const floor = SIMILAR_NOTE_MAX_CHARS * 0.5;

	const sentence = head.search(/[.!?](?=[^.!?]*$)/);
	if (sentence >= floor) return head.slice(0, sentence + 1);

	const word = head.lastIndexOf(' ');
	const cut = word >= floor ? head.slice(0, word) : head.slice(0, SIMILAR_NOTE_MAX_CHARS - 1);
	return `${cut.replace(/[,;:—-]$/, '')}…`;
}

/**
 * Closed-set validation for the similar-species list — the `validateTags`
 * analogue, and the whole reason an invented SPECIES cannot reach the page.
 *
 * Deliberately total: it never throws. `similar` is an OPTIONAL output, and a
 * malformed one must not cost the species its field craft. Everything rejected
 * is reported via `dropped` so job events can surface it.
 *
 * Note that this bounds WHICH species appear, not WHAT is said about them —
 * the note is free text and can still be wrong, which is why the UI carries the
 * same "verify in the field" caveat as field craft.
 */
function validateSimilar(
	raw: unknown,
	candidates: readonly string[],
	focalCode: string | null
): { similar: { code: string; note: string }[]; dropped: string[] } {
	// Structured outputs return `similar` as an object keyed by species code
	// (see buildOutputSchema). The array-of-{code,note} form is still accepted
	// because it is what an unconstrained response produces — the schema is the
	// guarantee, this is the fallback if a call ever runs without one.
	if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
		raw = Object.entries(raw as Record<string, unknown>).map(([code, note]) => ({
			code,
			note
		}));
	}
	if (!Array.isArray(raw)) return { similar: [], dropped: [] };

	const allowed = new Map(candidates.map((c) => [c.toLowerCase(), c]));
	const similar: { code: string; note: string }[] = [];
	const dropped: string[] = [];
	const seen = new Set<string>();

	for (const entry of raw) {
		if (similar.length >= MAX_SIMILAR) {
			// Observed fan-out reaches 7; silently dropping the tail would hide
			// which candidates never got a note (GROK P2).
			if (typeof (entry as { code?: unknown }).code === 'string') {
				dropped.push(`${String((entry as { code: string }).code).slice(0, 40)}:over-cap`);
			}
			continue;
		}
		if (typeof entry !== 'object' || entry === null) continue;
		const { code, note } = entry as { code?: unknown; note?: unknown };
		if (typeof code !== 'string') continue;

		const canonical = allowed.get(code.trim().toLowerCase());
		if (!canonical || canonical === focalCode) {
			dropped.push(code.trim().slice(0, 40));
			continue;
		}
		if (seen.has(canonical)) continue;

		const text = typeof note === 'string' ? clampNote(note) : '';
		// Every rejection is RECORDED. Empty used to be skipped silently, which
		// is how a required-but-empty value looked identical to "the model had
		// nothing to say" (GROK P1) — json_schema `required` guarantees the key,
		// not a sentence, and "" satisfies it.
		if (text.length === 0) {
			dropped.push(`${canonical}:empty`);
			continue;
		}
		if (text.length < SIMILAR_NOTE_MIN_CHARS) {
			dropped.push(`${canonical}:too-short`);
			continue;
		}
		if (isMalformedNote(text)) {
			dropped.push(`${canonical}:malformed`);
			continue;
		}

		seen.add(canonical);
		similar.push({ code: canonical, note: text });
	}
	return { similar, dropped };
}

/**
 * Pure response parser (unit-tested): bare-JSON extraction + validation.
 *
 * `candidates` is the closed set the model was offered. Omitting it means no
 * similar-species output is accepted at all — callers that want notes MUST pass
 * the same list they put in the prompt.
 */
export function parseAnnotation(
	text: string,
	opts: { candidates?: readonly string[]; focalCode?: string } = {}
): SpeciesAnnotation {
	let parsed: { tags?: unknown; field_craft?: unknown; similar?: unknown };
	try {
		const start = text.indexOf('{');
		const end = text.lastIndexOf('}');
		if (start < 0 || end < 0) throw new Error('no object');
		parsed = JSON.parse(text.slice(start, end + 1));
	} catch {
		throw new EnrichmentAiError('AI response was not readable JSON.', 0, false);
	}
	const { tags, dropped } = validateTags(parsed.tags);
	// The prompt requires EXACTLY ONE tide value for tidal species —
	// contradictory cardinality is code-enforceable and rejected as invalid
	// output rather than persisted (CODEX1 P2 #4).
	if (tags.filter((t) => t.startsWith('tide:')).length > 1) {
		throw new EnrichmentAiError('AI response had contradictory tide tags.', 0, false);
	}
	const fieldCraft =
		typeof parsed.field_craft === 'string'
			? parsed.field_craft.trim().slice(0, FIELD_CRAFT_MAX_CHARS)
			: '';
	if (fieldCraft.length === 0) {
		throw new EnrichmentAiError('AI response had no field craft text.', 0, false);
	}
	const { similar, dropped: droppedSimilar } = validateSimilar(
		parsed.similar,
		opts.candidates ?? [],
		opts.focalCode ?? null
	);
	return { tags, fieldCraft, droppedTags: dropped, similar, droppedSimilar };
}

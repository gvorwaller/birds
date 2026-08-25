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

export const AI_MODEL = 'claude-sonnet-4-6';
export const FIELD_CRAFT_MAX_CHARS = 700;
/** Prompt input cap — extract + selected sections, roughly 10k chars. */
const PROSE_CAP = 10_000;
/** One "how to tell them apart" line, sized for a compact card row. */
export const SIMILAR_NOTE_MAX_CHARS = 200;
/** Cap on notes per species — the observed maximum candidate fan-out is 7. */
export const MAX_SIMILAR = 5;

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
	return candidates.map((c) => `${c.code} = ${c.comName} (${c.sciName})`).join('\n');
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
				`${candidateBlock(candidates)}\n\n`
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
			? `3. "similar": up to ${MAX_SIMILAR} entries, each {"code", "note"}. Use ONLY ` +
				`codes from the list above — never invent a species. Include an entry ONLY ` +
				`where you can state a genuinely useful difference; omit a candidate rather ` +
				`than padding. Each "note" is ONE sentence, under ${SIMILAR_NOTE_MAX_CHARS} ` +
				`characters, telling a birder in the field how to separate THAT species from ` +
				`${input.comName} — plumage, structure, size, or voice. Write about the ` +
				`candidate, not about ${input.comName}. An empty list is a valid answer.\n`
			: '') +
		`\nRespond with ONLY this JSON object, nothing else:\n` +
		(candidates.length > 0
			? `{"tags": ["..."], "field_craft": "...", "similar": [{"code": "...", "note": "..."}]}`
			: `{"tags": ["..."], "field_craft": "..."}`)
	);
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
				'content-type': 'application/json'
			},
			body: JSON.stringify({
				model: AI_MODEL,
				// Headroom for up to MAX_SIMILAR notes alongside tags + field craft;
				// 800 fit the original two outputs with nothing to spare.
				max_tokens: 1600,
				system: SYSTEM,
				messages: [{ role: 'user', content: buildUserPrompt(input) }]
			}),
			signal: AbortSignal.timeout(45_000)
		});
	} catch {
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
	if (!Array.isArray(raw)) return { similar: [], dropped: [] };

	const allowed = new Map(candidates.map((c) => [c.toLowerCase(), c]));
	const similar: { code: string; note: string }[] = [];
	const dropped: string[] = [];
	const seen = new Set<string>();

	for (const entry of raw) {
		if (similar.length >= MAX_SIMILAR) break;
		if (typeof entry !== 'object' || entry === null) continue;
		const { code, note } = entry as { code?: unknown; note?: unknown };
		if (typeof code !== 'string') continue;

		const canonical = allowed.get(code.trim().toLowerCase());
		if (!canonical || canonical === focalCode) {
			dropped.push(code.trim().slice(0, 40));
			continue;
		}
		if (seen.has(canonical)) continue;

		const text = typeof note === 'string' ? note.trim().slice(0, SIMILAR_NOTE_MAX_CHARS) : '';
		// A candidate with no usable note is not worth a row: the structured
		// basis line already says why the link exists.
		if (text.length === 0) continue;

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

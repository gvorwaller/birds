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
import type { WikiSection } from '$server/wikipedia';

export const AI_MODEL = 'claude-sonnet-4-6';
export const FIELD_CRAFT_MAX_CHARS = 700;
/** Prompt input cap — extract + selected sections, roughly 10k chars. */
const PROSE_CAP = 10_000;

export class EnrichmentAiError extends Error {
	constructor(
		message: string,
		public status: number,
		public rateLimited: boolean
	) {
		super(message);
		this.name = 'EnrichmentAiError';
	}
}

export interface SpeciesAnnotation {
	tags: string[];
	fieldCraft: string;
	/** Vocabulary misses the model attempted — surfaced in job events. */
	droppedTags: string[];
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
	const wanted = /habitat|distribution|behavio|ecology|feeding|diet|breeding|migration/i;
	let out = extract;
	for (const s of sections) {
		if (!wanted.test(s.title)) continue;
		if (out.length >= PROSE_CAP) break;
		out += `\n\n${s.title}:\n${s.text}`;
	}
	return out.slice(0, PROSE_CAP);
}

export function buildUserPrompt(input: {
	comName: string;
	sciName: string;
	family: string | null;
	extract: string;
	sections: readonly WikiSection[];
}): string {
	return (
		`Species: ${input.comName} (${input.sciName})` +
		(input.family ? ` — family ${input.family}` : '') +
		`\n\nWikipedia article text:\n${proseBlock(input.extract, input.sections)}\n\n` +
		`Tag vocabulary (the ONLY allowed values, format "dimension:value"):\n` +
		`${vocabularyBlock()}\n\n` +
		`Produce:\n` +
		`1. "tags": up to ${MAX_TAGS} tags chosen ONLY from the vocabulary above, ` +
		`prefixed "dimension:value" (e.g. "habitat:mudflat"). Include tide: values ` +
		`ONLY for species that regularly use tidal habitats; every tidal species ` +
		`MUST get exactly one tide: value.\n` +
		`2. "field_craft": 2-4 hedged sentences answering when, where, and how a ` +
		`birder finds this species — habitat micro-placement, time of day, and the ` +
		`cue to look or listen for. For tidal species, explicitly state which tide ` +
		`stage is most productive and why. Under ${FIELD_CRAFT_MAX_CHARS} characters.\n\n` +
		`Respond with ONLY this JSON object, nothing else:\n` +
		`{"tags": ["..."], "field_craft": "..."}`
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
				max_tokens: 800,
				system: SYSTEM,
				messages: [{ role: 'user', content: buildUserPrompt(input) }]
			}),
			signal: AbortSignal.timeout(45_000)
		});
	} catch {
		throw new EnrichmentAiError('Could not reach the AI service.', 0, false);
	}
	if (res.status === 429) {
		throw new EnrichmentAiError('AI service rate-limited.', 429, true);
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

	return parseAnnotation(text);
}

/** Pure response parser (unit-tested): bare-JSON extraction + validation. */
export function parseAnnotation(text: string): SpeciesAnnotation {
	let parsed: { tags?: unknown; field_craft?: unknown };
	try {
		const start = text.indexOf('{');
		const end = text.lastIndexOf('}');
		if (start < 0 || end < 0) throw new Error('no object');
		parsed = JSON.parse(text.slice(start, end + 1));
	} catch {
		throw new EnrichmentAiError('AI response was not readable JSON.', 0, false);
	}
	const { tags, dropped } = validateTags(parsed.tags);
	const fieldCraft =
		typeof parsed.field_craft === 'string'
			? parsed.field_craft.trim().slice(0, FIELD_CRAFT_MAX_CHARS)
			: '';
	if (fieldCraft.length === 0) {
		throw new EnrichmentAiError('AI response had no field craft text.', 0, false);
	}
	return { tags, fieldCraft, droppedTags: dropped };
}

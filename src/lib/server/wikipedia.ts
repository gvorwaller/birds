/**
 * Wikipedia article fetch for species enrichment. ONE request per species:
 * MediaWiki action API extracts (full plain text with == heading == markers)
 * + revision id — live-verified 2026-08-17 (Marbled godwit → 4.5KB text,
 * revid, compound headings like "Distribution and habitat").
 *
 * Stored text is CC BY-SA 4.0 — the caller persists title/url/rev_id so the
 * UI can render the required attribution (revision permalink carries
 * contributor credit via history).
 */
import { env } from '$env/dynamic/private';
import { parseRetryAfterMs } from '$server/wikidata';

const API_URL = 'https://en.wikipedia.org/w/api.php';
const REQUEST_TIMEOUT_MS = 30_000;

/** Whitelist by KEYWORD — real headings are compound ("Behavior and ecology"). */
const SECTION_KEYWORDS = [
	'description',
	'taxonomy',
	'habitat',
	'distribution',
	'behavio', // behaviour/behavior
	'ecology',
	'feeding',
	'diet',
	'breeding',
	'migration',
	'status',
	'conservation'
] as const;

/** Caps: prose is stored in Postgres and rendered on phones — bound it. */
export const MAX_EXTRACT_CHARS = 4_000;
export const MAX_SECTION_CHARS = 8_000;
export const MAX_TOTAL_CHARS = 40_000;

export class WikipediaError extends Error {
	constructor(
		message: string,
		public status: number,
		public rateLimited: boolean,
		/** Parsed Retry-After when the server sent one (CODEX1 P2 #6). */
		public retryAfterMs: number | null = null
	) {
		super(message);
		this.name = 'WikipediaError';
	}
}

export interface WikiSection {
	title: string;
	text: string;
}

export interface WikiArticle {
	title: string;
	revId: number;
	extract: string;
	sections: WikiSection[];
}

/**
 * Pure section splitter (unit-tested with fixture text). Input: full-article
 * plaintext with `== Title ==` top-level markers (=== subsections stay inside
 * their parent's text). Lead = text before the first marker.
 */
export function splitSections(plaintext: string): { extract: string; sections: WikiSection[] } {
	const lines = plaintext.split('\n');
	const sections: WikiSection[] = [];
	let current: { title: string; keep: boolean; parts: string[] } | null = null;
	const lead: string[] = [];
	let total = 0;

	const flush = () => {
		if (!current || !current.keep) return;
		const text = current.parts.join('\n').trim().slice(0, MAX_SECTION_CHARS);
		if (text.length === 0) return;
		if (total + text.length > MAX_TOTAL_CHARS) return;
		total += text.length;
		sections.push({ title: current.title, text });
	};

	for (const line of lines) {
		const m = /^==\s*([^=].*?)\s*==$/.exec(line);
		if (m) {
			flush();
			const title = m[1].trim();
			const lower = title.toLowerCase();
			current = {
				title,
				keep: SECTION_KEYWORDS.some((k) => lower.includes(k)),
				parts: []
			};
		} else if (current) {
			current.parts.push(line);
		} else {
			lead.push(line);
		}
	}
	flush();
	return { extract: lead.join('\n').trim().slice(0, MAX_EXTRACT_CHARS), sections };
}

function userAgent(): string {
	const contact = env.ENRICHMENT_CONTACT ?? 'gaylon@vorwaller.net';
	return `birds.gaylon.photos species enrichment (${contact})`;
}

export function articleUrl(title: string): string {
	return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
}

export function revisionPermalink(title: string, revId: number): string {
	return `https://en.wikipedia.org/w/index.php?title=${encodeURIComponent(
		title.replace(/ /g, '_')
	)}&oldid=${revId}`;
}

/**
 * Fetch one article's full plaintext + current revid. Returns null when the
 * page does not exist (a data state, not an error). Throws WikipediaError on
 * transport/HTTP failures.
 */
export async function fetchArticlePlaintext(
	title: string,
	opts: { signal?: AbortSignal; fetcher?: typeof fetch } = {}
): Promise<WikiArticle | null> {
	const doFetch = opts.fetcher ?? fetch;
	const signal = opts.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const params = new URLSearchParams({
		action: 'query',
		format: 'json',
		formatversion: '2',
		prop: 'extracts|revisions',
		explaintext: '1',
		exsectionformat: 'wiki',
		redirects: '1',
		rvprop: 'ids',
		titles: title
	});
	let res: Response;
	try {
		res = await doFetch(`${API_URL}?${params}`, {
			headers: { 'User-Agent': userAgent() },
			signal
		});
	} catch (err) {
		throw new WikipediaError(
			`Wikipedia unreachable: ${err instanceof Error ? err.message : 'fetch failed'}`,
			0,
			false
		);
	}
	if (!res.ok) {
		throw new WikipediaError(
			`Wikipedia query failed (HTTP ${res.status})`,
			res.status,
			res.status === 429,
			parseRetryAfterMs(res.headers.get('retry-after'))
		);
	}
	const body = (await res.json()) as {
		query?: {
			pages?: {
				title?: string;
				missing?: boolean;
				extract?: string;
				revisions?: { revid?: number }[];
			}[];
		};
	};
	const page = body.query?.pages?.[0];
	if (!page || page.missing || !page.extract || !page.revisions?.[0]?.revid) {
		return null;
	}
	const { extract, sections } = splitSections(page.extract);
	return {
		title: page.title ?? title,
		revId: page.revisions[0].revid,
		extract,
		sections
	};
}

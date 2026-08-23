/**
 * Xeno-canto v3 gateway for field-guide sample sounds (td-86a2b6). Fills the
 * "song"/"call" slots Wikidata/Commons cannot type (P51 audio has no
 * vocalization-type metadata — see wikimedia-commons.ts).
 * Plan: docs/2026-08-23-field-guide-sample-media-CLAUDE.md §5.
 *
 * VERIFICATION NOTE (2026-08-23): xeno-canto v2 went offline 2025-10-10; v3
 * requires a key per https://xeno-canto.org/article/304. The live docs pages
 * (article/304 and /explore/api) are behind Anubis bot-protection and
 * returned "Access Denied" to both WebFetch and cached mirrors during this
 * implementation pass — they could NOT be read directly (cs.md
 * evidence-first-parsing: this is disclosed, not glossed over). What WAS
 * confirmed via web search of third-party API directories/wrappers
 * (publicapi.dev, the JoeSiu/xeno-canto-api-ts TypeScript wrapper) as of
 * 2026-08-23:
 *   - Endpoint: GET https://xeno-canto.org/api/3/recordings
 *   - Auth: the key is a QUERY PARAMETER named `key` (e.g. `&key=...`), NOT
 *     a request header — this contradicts the spec's draft X-API-Key header
 *     guess, so this implementation uses the query param.
 *   - Recording field names: id, file, type, q (quality), len (duration),
 *     rec (recordist), lic (license), loc (location), cnt (country).
 *   - Response envelope: { numRecordings, numSpecies, page, numPages,
 *     recordings: [...] }.
 * UNVERIFIED: the exact `len` duration format (mm:ss vs. plain seconds).
 * parseDuration() below defensively accepts both formats.
 * Query shape: this code uses the documented v3 species tag
 * `sp:"Genus species"` (the only form any reachable example shows). Quality
 * is NOT filtered server-side: xeno-canto tags combine with AND semantics,
 * so `q:A q:B` would request recordings that are simultaneously quality A
 * AND B (i.e. none) — the A/B filter is applied client-side below instead.
 * If species sound results look wrong in practice, re-verify against a real
 * response with a valid key before changing the query shape.
 */
import { env } from '$env/dynamic/private';
import { enrichmentUserAgent, parseRetryAfterMs, validSciName } from '$server/wikidata';

export const XENO_CANTO_API_URL = 'https://xeno-canto.org/api/3/recordings';
const REQUEST_TIMEOUT_MS = 30_000;
const MIN_DURATION_S = 3;
const MAX_DURATION_S = 60;

export class XenoCantoError extends Error {
	constructor(
		message: string,
		public status: number,
		/** 429 or explicit throttle — caller schedules a rate-limit retry. */
		public rateLimited: boolean,
		public retryAfterMs: number | null = null
	) {
		super(message);
		this.name = 'XenoCantoError';
	}
}

export interface XenoCantoRecording {
	/** "XC" + the numeric xeno-canto recording id. */
	xcId: string;
	/** Direct audio stream URL. */
	mediaUrl: string;
	/** Recording page on xeno-canto.org. */
	sourceUrl: string;
	/** Raw type string from the API (e.g. "song", "call, alarm call"). */
	type: string;
	/** "A" or "B". */
	quality: string;
	duration: number;
	recordist: string;
	/** Normalized, e.g. "CC BY-NC-SA 4.0". */
	license: string;
	licenseUrl: string;
	location: string | null;
}

/** Reads the configured key; null (not throwing) when unset. */
export function getXenoCantoApiKey(): string | null {
	const key = env.XENO_CANTO_API_KEY;
	return key && key.trim().length > 0 ? key.trim() : null;
}

/**
 * "song" vs everything else. Covers "call", "alarm call", "flight call",
 * etc. — xeno-canto's `type` field is a free-text, often comma-separated
 * list; a substring match on "song" is the only stable signal.
 */
export function categorizeType(type: string): 'song' | 'call' {
	return type.toLowerCase().includes('song') ? 'song' : 'call';
}

/**
 * "mm:ss" (or "h:mm:ss") → seconds. Defensively also accepts a bare integer
 * string (unverified whether v3's `len` field kept v2's mm:ss format — see
 * module doc comment). Unparsable input returns 0, which fails the
 * 3–60s acceptance window rather than throwing.
 */
export function parseDuration(dur: string): number {
	const trimmed = dur.trim();
	if (/^\d+$/.test(trimmed)) return Number(trimmed);
	const parts = trimmed.split(':').map((p) => Number(p));
	if (parts.length === 0 || parts.some((p) => !Number.isFinite(p))) return 0;
	return parts.reduce((acc, p) => acc * 60 + p, 0);
}

/**
 * xeno-canto license URLs look like
 * "//creativecommons.org/licenses/by-nc-sa/4.0/" (protocol-relative, no
 * scheme). Normalize to a short display code, e.g. "CC BY-NC-SA 4.0".
 * Public-domain grants ("publicdomain/zero/1.0") become "CC0 1.0".
 * Unrecognized shapes pass through verbatim rather than fabricating a code.
 */
export function normalizeLicense(lic: string): string {
	const m = /creativecommons\.org\/(licenses|publicdomain)\/([a-z-]+)\/([0-9.]+)/i.exec(lic);
	if (!m) return lic;
	const [, kind, type, version] = m;
	if (kind === 'publicdomain') {
		return type.toLowerCase() === 'zero' ? `CC0 ${version}` : `CC ${type.toUpperCase()} ${version}`;
	}
	return `CC ${type.toUpperCase()} ${version}`;
}

/** Ensures a scheme so the stored URL is directly usable (protocol-relative → https). */
export function licenseUrl(lic: string): string {
	return lic.startsWith('//') ? `https:${lic}` : lic;
}

interface XcApiRecording {
	id: string;
	file: string;
	type: string;
	q: string;
	len: string;
	rec: string;
	lic: string;
	loc?: string;
}

interface XcApiResponse {
	numRecordings?: string | number;
	recordings?: XcApiRecording[];
	/** v3 error payloads: a string, or an object carrying code/message. */
	error?: string | { code?: string; message?: string };
	message?: string;
}

function toRecording(r: XcApiRecording): XenoCantoRecording {
	return {
		xcId: r.id.startsWith('XC') ? r.id : `XC${r.id}`,
		mediaUrl: r.file,
		sourceUrl: `https://xeno-canto.org/${r.id.replace(/^XC/, '')}`,
		type: r.type,
		quality: r.q,
		duration: parseDuration(r.len),
		recordist: r.rec,
		license: normalizeLicense(r.lic),
		licenseUrl: licenseUrl(r.lic),
		location: r.loc ?? null
	};
}

/**
 * Fetch quality-A/B recordings for a species and pick one song + one call.
 * Ranking within each bucket: quality A before B, then shorter duration
 * preferred (§5b). Missing/invalid key throws XenoCantoError — the caller
 * (enrichSpeciesMedia) treats this as a soft, partial failure, never fatal.
 */
export async function fetchXenoCantoRecordings(
	sciName: string,
	opts: { signal?: AbortSignal; fetcher?: typeof fetch } = {}
): Promise<{ song: XenoCantoRecording | null; call: XenoCantoRecording | null }> {
	if (!validSciName(sciName)) {
		throw new Error(`invalid sci name: ${sciName}`);
	}
	const apiKey = getXenoCantoApiKey();
	if (!apiKey) {
		throw new XenoCantoError('xeno-canto API key not configured', 0, false);
	}
	const doFetch = opts.fetcher ?? fetch;
	const signal = opts.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const params = new URLSearchParams({
		// sp: is the documented species tag; quality A/B is filtered CLIENT-side
		// (see module doc — stacked q: tags AND together and would match nothing).
		query: `sp:"${sciName}"`,
		key: apiKey
	});
	let res: Response;
	try {
		res = await doFetch(`${XENO_CANTO_API_URL}?${params.toString()}`, {
			method: 'GET',
			headers: { Accept: 'application/json', 'User-Agent': enrichmentUserAgent() },
			signal
		});
	} catch (err) {
		throw new XenoCantoError(
			`xeno-canto unreachable: ${err instanceof Error ? err.message : 'fetch failed'}`,
			0,
			false
		);
	}
	if (!res.ok) {
		throw new XenoCantoError(
			`xeno-canto query failed (HTTP ${res.status})`,
			res.status,
			res.status === 429,
			// xeno-canto has no documented Retry-After header, but if one
			// arrives anyway it's honored; absent, the caller falls back to
			// the standard rate-limit delay.
			parseRetryAfterMs(res.headers.get('retry-after'))
		);
	}
	const body = (await res.json()) as XcApiResponse;
	if (body.error) {
		const detail =
			typeof body.error === 'string'
				? body.error
				: (body.error.message ?? body.error.code ?? 'unknown error');
		throw new XenoCantoError(`xeno-canto query failed: ${detail}`, 0, false);
	}
	// A well-formed success ALWAYS carries a recordings array (possibly empty).
	// A 200 body without one (e.g. `{"message":"invalid key"}`) is an error in
	// disguise — surfacing it keeps the species on the soft 'partial' path
	// instead of persisting a bogus "this bird has no recordings" for months.
	if (!Array.isArray(body.recordings)) {
		throw new XenoCantoError(
			`xeno-canto query failed: ${body.message ?? 'malformed response (no recordings array)'}`,
			0,
			false
		);
	}
	const candidates = body.recordings
		.filter((r) => r.q === 'A' || r.q === 'B')
		.map(toRecording)
		.filter((r) => r.duration >= MIN_DURATION_S && r.duration <= MAX_DURATION_S)
		.sort((a, b) => {
			if (a.quality !== b.quality) return a.quality === 'A' ? -1 : 1;
			return a.duration - b.duration;
		});
	const song = candidates.find((r) => categorizeType(r.type) === 'song') ?? null;
	const call = candidates.find((r) => categorizeType(r.type) === 'call') ?? null;
	return { song, call };
}

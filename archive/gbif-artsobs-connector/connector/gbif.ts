/**
 * GBIF client for the Norway connector (td-eec7db Phase 2).
 *
 * Request policy (Phase 0 finding 9): at most GBIF_CONCURRENCY requests in
 * flight, a 30 s deadline each, retries on 5xx / network errors using
 * Retry-After or exponential backoff with jitter, at most GBIF_MAX_TRIES
 * tries, then the load fails (retryable). A 429 (finding 15) pauses every
 * request for Retry-After or 15 s, 30 s, 60 s … up to 5 min, with its own
 * budget of GBIF_MAX_429_TRIES.
 */
import {
	BIRDS_TAXON_KEY,
	DATASET_KEY,
	GBIF_API,
	GBIF_CONCURRENCY,
	GBIF_DEADLINE_MS,
	GBIF_429_BASE_MS,
	GBIF_429_MAX_MS,
	GBIF_MAX_429_TRIES,
	GBIF_MAX_TRIES,
	USER_AGENT
} from './config';

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
export type SleepFn = (ms: number, signal: AbortSignal) => Promise<void>;

export class GbifError extends Error {
	constructor(
		message: string,
		readonly retryable: boolean
	) {
		super(message);
		this.name = 'GbifError';
	}
}

export const abortableSleep: SleepFn = (ms, signal) =>
	new Promise((resolve, reject) => {
		if (signal.aborted) return reject(signal.reason);
		const t = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(t);
			reject(signal.reason);
		};
		signal.addEventListener('abort', onAbort, { once: true });
	});

/** A FIFO counting semaphore. */
class Slots {
	private free: number;
	private waiting: (() => void)[] = [];
	constructor(n: number) {
		this.free = n;
	}
	async take(): Promise<void> {
		if (this.free > 0) {
			this.free--;
			return;
		}
		await new Promise<void>((resolve) => this.waiting.push(resolve));
	}
	give(): void {
		const next = this.waiting.shift();
		if (next) next();
		else this.free++;
	}
}

/** Retry-After in seconds or as an HTTP date; capped so a bad header can't stall a load. */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
	if (!header) return null;
	const secs = Number(header);
	const ms = Number.isFinite(secs) ? secs * 1000 : new Date(header).getTime() - now;
	return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), 120_000) : null;
}

export interface SearchPage {
	offset: number;
	limit: number;
	endOfRecords: boolean;
	count: number;
	results: unknown[];
}

export interface SpeciesInfo {
	key: number;
	canonicalName: string;
	scientificName: string;
	rank: string;
}

export interface DatasetCopy {
	/** When GBIF finished its latest successful (finishReason NORMAL) copy. */
	crawledAt: string;
	pubDate: string | null;
}

const facetField = (field: string) => field.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase();

/** The counts of a facet answer, or null when the answer isn't one. */
function facetCounts(r: { count?: unknown; facets?: unknown }, field: string): { name: string; count: number }[] | null {
	if (!r || !Number.isInteger(r.count) || !Array.isArray(r.facets)) return null;
	const f = r.facets.find((x) => (x as { field?: unknown })?.field === facetField(field)) as { counts?: unknown } | undefined;
	if (!f || !Array.isArray(f.counts)) return null;
	const ok = f.counts.every((c) => typeof c?.name === 'string' && Number.isInteger(c?.count) && c.count >= 0);
	return ok ? (f.counts as { name: string; count: number }[]) : null;
}

export class GbifClient {
	requests = 0;
	bytes = 0;
	/** 429 answers seen (logged per county read). */
	throttles = 0;
	private pausedUntil = 0;
	/** 429s since the last good answer, from any request: sets the next pause. */
	private throttleRun = 0;
	private readonly slots: Slots;
	private readonly fetchFn: FetchFn;
	private readonly sleep: SleepFn;
	private readonly base: string;
	private readonly now: () => number;
	private readonly species = new Map<number, SpeciesInfo>();

	constructor(opts: { fetch?: FetchFn; sleep?: SleepFn; now?: () => number; base?: string; concurrency?: number } = {}) {
		this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
		this.sleep = opts.sleep ?? abortableSleep;
		this.now = opts.now ?? Date.now;
		this.base = opts.base ?? GBIF_API;
		this.slots = new Slots(opts.concurrency ?? GBIF_CONCURRENCY);
	}

	/** GET a GBIF API path as JSON, under the request policy. */
	async getJson<T>(path: string, params: Record<string, string | number>, signal: AbortSignal): Promise<T> {
		const url = new URL(path, this.base);
		for (const [k, v] of Object.entries(params)) url.searchParams.append(k, String(v));
		// Errors name the slice and page, so a failed load says which request broke.
		const what = 'offset' in params ? `${path} ${params.stateProvince ?? ''} ${params.eventDate ?? ''} offset ${params.offset}`.replace(/\s+/g, ' ') : path;
		let lastProblem = '';
		let failures = 0;
		let throttled = 0;
		for (;;) {
			await this.acquire(signal);
			let wait: number | null = null;
			let was429 = false;
			try {
				if (signal.aborted) throw signal.reason;
				const res = await this.fetchFn(url.toString(), {
					headers: { accept: 'application/json', 'user-agent': USER_AGENT },
					signal: AbortSignal.any([signal, AbortSignal.timeout(GBIF_DEADLINE_MS)])
				});
				this.requests++;
				if (res.ok) {
					const text = await res.text();
					this.bytes += text.length;
					try {
						const body = JSON.parse(text) as T;
						this.throttleRun = 0;
						return body;
					} catch {
						lastProblem = `GBIF sent a body that is not JSON (${what})`;
					}
				} else if (res.status === 429) {
					was429 = true;
					this.throttles++;
					lastProblem = `GBIF answered 429 (${what})`;
					// Paused before this request gives up its slot, so nothing queued
					// behind it gets in first.
					const backoff = Math.min(GBIF_429_BASE_MS * 2 ** this.throttleRun++, GBIF_429_MAX_MS);
					const pause = Math.max(retryAfterMs(res.headers.get('retry-after')) ?? 0, backoff) + Math.floor(Math.random() * 1000);
					this.pausedUntil = Math.max(this.pausedUntil, this.now() + pause);
					await res.body?.cancel().catch(() => {});
				} else if (res.status >= 500) {
					lastProblem = `GBIF answered ${res.status} (${what})`;
					wait = retryAfterMs(res.headers.get('retry-after'));
					await res.body?.cancel().catch(() => {});
				} else {
					await res.body?.cancel().catch(() => {});
					throw new GbifError(`GBIF answered ${res.status} (${what})`, false);
				}
			} catch (err) {
				if (err instanceof GbifError) throw err;
				if (signal.aborted) throw signal.reason;
				lastProblem = `GBIF request failed (${what}): ${err instanceof Error ? err.message : String(err)}`;
			} finally {
				this.slots.give();
			}
			if (was429) {
				if (++throttled >= GBIF_MAX_429_TRIES) {
					throw new GbifError(`${lastProblem}; still throttled after ${GBIF_MAX_429_TRIES} tries`, true);
				}
				continue;
			}
			if (++failures >= GBIF_MAX_TRIES) throw new GbifError(`${lastProblem}; gave up after ${GBIF_MAX_TRIES} tries`, true);
			const backoff = Math.min(2 ** failures * 1000, 30_000);
			await this.sleep((wait ?? backoff) + Math.floor(Math.random() * 500), signal);
		}
	}

	/**
	 * Take a request slot outside any 429 pause. The pause is checked again
	 * once a slot is free, so a request queued behind the one that got the
	 * 429 waits too, and a sleeper whose pause was extended sleeps again.
	 * A paused request never holds a slot.
	 */
	private async acquire(signal: AbortSignal): Promise<void> {
		for (;;) {
			const paused = this.pausedUntil - this.now();
			if (paused > 0) {
				await this.sleep(paused, signal);
				continue;
			}
			await this.slots.take();
			if (signal.aborted) {
				this.slots.give();
				throw signal.reason;
			}
			if (this.pausedUntil <= this.now()) return;
			this.slots.give();
		}
	}

	/** Filters every occurrence query shares (contract principles: report semantics). */
	static baseFilters(): Record<string, string | number> {
		return { datasetKey: DATASET_KEY, taxonKey: BIRDS_TAXON_KEY, occurrenceStatus: 'PRESENT' };
	}

	async search(filters: Record<string, string | number>, offset: number, limit: number, signal: AbortSignal): Promise<SearchPage> {
		const page = await this.getJson<SearchPage>(
			'occurrence/search',
			{ ...GbifClient.baseFilters(), ...filters, offset, limit },
			signal
		);
		if (!page || !Number.isInteger(page.count) || !Array.isArray(page.results)) {
			throw new GbifError('GBIF search answered without a count or results', true);
		}
		return page;
	}

	/** Every value of a facet over a filter, paged until GBIF returns a short page. */
	async facet(field: string, filters: Record<string, string | number>, signal: AbortSignal): Promise<{ name: string; count: number }[]> {
		const out: { name: string; count: number }[] = [];
		const pageSize = 1000;
		for (let offset = 0; ; offset += pageSize) {
			const r = await this.getJson<{ count?: unknown; facets?: unknown }>(
				'occurrence/search',
				{ ...GbifClient.baseFilters(), ...filters, limit: 0, facet: field, facetLimit: pageSize, facetOffset: offset },
				signal
			);
			// GBIF answers even an empty facet with its entry
			// ({"count":0,"facets":[{"field":"STATE_PROVINCE","counts":[]}]}, checked
			// 2026-10-23), so anything else is a broken answer, never "no records".
			const counts = facetCounts(r, field);
			if (!counts) throw new GbifError(`GBIF sent a facet answer without its ${field} counts`, true);
			for (const c of counts) out.push(c);
			if (counts.length < pageSize) return out;
		}
	}

	/** Phase 0 finding 2: the latest copy GBIF finished normally. */
	async latestGoodCopy(signal: AbortSignal): Promise<DatasetCopy> {
		const crawls = await this.getJson<{ results?: { finishReason?: string; finishedCrawling?: string }[] }>(
			`dataset/${DATASET_KEY}/process`,
			{ limit: 20 },
			signal
		);
		const good = (crawls.results ?? [])
			.filter((c) => c.finishReason === 'NORMAL' && typeof c.finishedCrawling === 'string')
			.map((c) => c.finishedCrawling as string)
			.sort()
			.reverse();
		if (!good[0] || !Number.isFinite(new Date(good[0]).getTime())) {
			throw new GbifError('GBIF lists no successful copy of the dataset in its recent crawls', true);
		}
		const dataset = await this.getJson<{ pubDate?: string }>(`dataset/${DATASET_KEY}`, {}, signal);
		return { crawledAt: new Date(good[0]).toISOString(), pubDate: typeof dataset.pubDate === 'string' ? dataset.pubDate : null };
	}

	/** Backbone name and rank for a species key; cached for the life of the process. */
	async speciesInfo(key: number, signal: AbortSignal): Promise<SpeciesInfo> {
		const hit = this.species.get(key);
		if (hit) return hit;
		const r = await this.getJson<{ key?: number; canonicalName?: string; scientificName?: string; rank?: string; nameType?: string }>(
			`species/${key}`,
			{},
			signal
		);
		if (r.key !== key || typeof r.rank !== 'string') throw new GbifError(`GBIF has no usable record for species ${key}`, true);
		const name = r.canonicalName ?? r.scientificName ?? `GBIF ${key}`;
		// Only an ordinary scientific name is a species. GBIF also files hybrids
		// ("Mareca penelope x Anas platyrhynchos", nameType HYBRID, no
		// canonicalName) at rank SPECIES; those carry their name type as the
		// rank here, so the connector counts them as unkeyed, with a note.
		const ordinary = typeof r.canonicalName === 'string' && (r.nameType === undefined || r.nameType === 'SCIENTIFIC');
		const info: SpeciesInfo = {
			key,
			canonicalName: name,
			scientificName: r.scientificName ?? name,
			rank: ordinary ? r.rank : (r.nameType ?? 'NO_CANONICAL_NAME')
		};
		this.species.set(key, info);
		return info;
	}
}

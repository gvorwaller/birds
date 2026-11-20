/**
 * Artskart public API client (td-eec7db Phase 2 rev B): one request at a
 * time, a deadline per request, and a finite number of retries for network
 * errors, 429 and 5xx. An answer without its counts is a broken answer and
 * fails as retryable; it never reads as "no records".
 */
import { abortableSleep, retryAfterMs, type FetchFn, type SleepFn } from '../shared/http';
import { ARTSKART_API, ARTSKART_BACKOFF_MAX_MS, ARTSKART_DEADLINE_MS, ARTSKART_MAX_TRIES, BIRDS_TAXON_GROUP, COLLECTION, USER_AGENT } from './config';

export { abortableSleep, retryAfterMs, type FetchFn, type SleepFn };

export class ArtskartError extends Error {
	constructor(
		message: string,
		readonly retryable: boolean
	) {
		super(message);
		this.name = 'ArtskartError';
	}
}

export interface ListPage {
	total: number;
	totalPages: number;
	observations: unknown[];
}

export interface SliceQuery {
	county: number;
	from: string;
	to: string;
}

export class ArtskartClient {
	requests = 0;
	bytes = 0;
	private readonly fetchFn: FetchFn;
	private readonly sleep: SleepFn;

	constructor(opts: { fetch?: FetchFn; sleep?: SleepFn } = {}) {
		this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
		this.sleep = opts.sleep ?? abortableSleep;
	}

	/** The list URL for one slice and page. Both date bounds are inclusive (probe 2026-10-26). */
	static listUrl(q: SliceQuery, pageIndex: number, pageSize: number): string {
		const u = new URL('observations/list', ARTSKART_API);
		u.searchParams.append('countys[]', String(q.county));
		u.searchParams.append('taxongroups[]', String(BIRDS_TAXON_GROUP));
		u.searchParams.append('collections[]', COLLECTION);
		u.searchParams.set('fromDate', q.from);
		u.searchParams.set('toDate', q.to);
		u.searchParams.set('pageSize', String(pageSize));
		u.searchParams.set('pageIndex', String(pageIndex));
		return u.toString();
	}

	async page(q: SliceQuery, pageIndex: number, pageSize: number, signal: AbortSignal): Promise<ListPage> {
		const url = ArtskartClient.listUrl(q, pageIndex, pageSize);
		const where = `Artskart county ${q.county} ${q.from}–${q.to} page ${pageIndex}`;
		let last: ArtskartError | null = null;
		for (let attempt = 1; attempt <= ARTSKART_MAX_TRIES; attempt++) {
			let wait: number | null = null;
			try {
				if (signal.aborted) throw signal.reason;
				this.requests++;
				const res = await this.fetchFn(url, {
					headers: { accept: 'application/json', 'user-agent': USER_AGENT },
					redirect: 'error',
					signal: AbortSignal.any([signal, AbortSignal.timeout(ARTSKART_DEADLINE_MS)])
				});
				const text = await res.text();
				this.bytes += text.length;
				if (res.status === 200) return parsePage(text, where);
				last = new ArtskartError(`${where}: HTTP ${res.status}`, res.status === 429 || res.status >= 500);
				if (!last.retryable) throw last;
				wait = retryAfterMs(res.headers.get('retry-after'));
			} catch (err) {
				if (err instanceof ArtskartError && (!err.retryable || attempt === ARTSKART_MAX_TRIES)) throw err;
				if (signal.aborted) throw signal.reason;
				last = err instanceof ArtskartError ? err : new ArtskartError(`${where}: ${err instanceof Error ? err.message : String(err)}`, true);
			}
			if (attempt < ARTSKART_MAX_TRIES) {
				await this.sleep((wait ?? Math.min(2 ** attempt * 2000, ARTSKART_BACKOFF_MAX_MS)) + Math.floor(Math.random() * 500), signal);
			}
		}
		throw last ?? new ArtskartError(`${where}: failed`, true);
	}
}

function parsePage(text: string, where: string): ListPage {
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		throw new ArtskartError(`${where}: the answer is not JSON`, true);
	}
	const b = body as { TotalCount?: unknown; TotalPages?: unknown; Observations?: unknown };
	const total = b?.TotalCount;
	const totalPages = b?.TotalPages;
	if (
		typeof total !== 'number' ||
		!Number.isInteger(total) ||
		total < 0 ||
		typeof totalPages !== 'number' ||
		!Number.isInteger(totalPages) ||
		totalPages < 0 ||
		!Array.isArray(b.Observations)
	) {
		throw new ArtskartError(`${where}: the answer has no usable counts or records`, true);
	}
	return { total, totalPages, observations: b.Observations };
}

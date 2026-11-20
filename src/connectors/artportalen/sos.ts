/**
 * SLU Artdatabanken Species Observation System (SOS) client (td-99eebf): one
 * request at a time, a deadline per request, and a finite number of retries
 * for network errors, 429 and 5xx. An answer without its counts is a broken
 * answer and fails as retryable; it never reads as "no records".
 *
 * The subscription key goes only to SOS_API, in its header, and never into a
 * log line or an error message.
 */
import { abortableSleep, retryAfterMs, type FetchFn, type SleepFn } from '../shared/http';
import {
	BIRDS_TAXON,
	DATA_PROVIDER,
	OUTPUT_FIELDS,
	SOS_API,
	SOS_BACKOFF_MAX_MS,
	SOS_DEADLINE_MS,
	SOS_MAX_PAGE,
	SOS_MAX_TRIES,
	USER_AGENT
} from './config';

export class SosError extends Error {
	constructor(
		message: string,
		readonly retryable: boolean
	) {
		super(message);
		this.name = 'SosError';
	}
}

/** One county's birds started on dates from..to (both inclusive, Swedish local dates). */
export interface SliceQuery {
	county: number;
	from: string;
	to: string;
}

export interface CursorPage {
	total: number;
	records: unknown[];
	/** Null when there are no more pages. */
	next: string | null;
}

/**
 * The one SOS selection every Count and cursor page of a load uses (plan
 * [C1-1]): Artportalen only, birds and every taxon under them, present
 * reports, public records (the default), dated by their START date so a
 * report spanning midnight at a month's end belongs to exactly one month.
 */
export function sliceFilter(q: SliceQuery): Record<string, unknown> {
	return {
		dataProvider: { ids: [DATA_PROVIDER] },
		taxon: { ids: [BIRDS_TAXON], includeUnderlyingTaxa: true },
		geographics: { areas: [{ areaType: 'County', featureId: String(q.county) }] },
		date: { startDate: q.from, endDate: q.to, dateFilterType: 'OnlyStartDate' },
		occurrenceStatus: 'Present',
		output: { fields: [...OUTPUT_FIELDS] }
	};
}

/** What the fingerprint of a load's selection covers (the dates vary per slice). */
export function selectionFingerprintInput(county: number): Record<string, unknown> {
	const f = sliceFilter({ county, from: 'FROM', to: 'TO' });
	return { ...f, sort: 'modified asc' };
}

export class SosClient {
	requests = 0;
	bytes = 0;
	private readonly fetchFn: FetchFn;
	private readonly sleep: SleepFn;

	constructor(
		private readonly key: string,
		opts: { fetch?: FetchFn; sleep?: SleepFn } = {}
	) {
		this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
		this.sleep = opts.sleep ?? abortableSleep;
	}

	/** Observations/Count for the slice. */
	async count(q: SliceQuery, signal: AbortSignal): Promise<number> {
		const where = `Artportalen county ${q.county} ${q.from}–${q.to} count`;
		const body = await this.post('Observations/Count', sliceFilter(q), where, signal);
		if (typeof body !== 'number' || !Number.isInteger(body) || body < 0) {
			throw new SosError(`${where}: the answer is not a count`, true);
		}
		return body;
	}

	/** One page of Observations/SearchByCursor, sorted by modified time, ascending. */
	async page(q: SliceQuery, cursor: string | null, take: number, signal: AbortSignal): Promise<CursorPage> {
		if (!Number.isInteger(take) || take < 1 || take > SOS_MAX_PAGE) throw new SosError(`page size ${take} is outside 1–${SOS_MAX_PAGE}`, false);
		const params = new URLSearchParams({ take: String(take), sortBy: 'modified', sortOrder: 'Asc' });
		if (cursor) params.set('cursor', cursor);
		const where = `Artportalen county ${q.county} ${q.from}–${q.to} page`;
		const body = await this.post(`Observations/SearchByCursor?${params}`, sliceFilter(q), where, signal);
		return parsePage(body, where, take);
	}

	private async post(path: string, body: unknown, where: string, signal: AbortSignal): Promise<unknown> {
		const url = new URL(path, SOS_API).toString();
		const payload = JSON.stringify(body);
		let last: SosError | null = null;
		for (let attempt = 1; attempt <= SOS_MAX_TRIES; attempt++) {
			let wait: number | null = null;
			try {
				if (signal.aborted) throw signal.reason;
				this.requests++;
				const res = await this.fetchFn(url, {
					method: 'POST',
					headers: {
						accept: 'application/json',
						'content-type': 'application/json',
						'user-agent': USER_AGENT,
						'ocp-apim-subscription-key': this.key
					},
					body: payload,
					redirect: 'error',
					signal: AbortSignal.any([signal, AbortSignal.timeout(SOS_DEADLINE_MS)])
				});
				const text = await res.text();
				this.bytes += text.length;
				if (res.status === 200) {
					try {
						return JSON.parse(text);
					} catch {
						throw new SosError(`${where}: the answer is not JSON`, true);
					}
				}
				// 401/403: the key is missing, wrong or revoked; no retry will help.
				last = new SosError(
					res.status === 401 || res.status === 403
						? `${where}: SOS refused the subscription key (HTTP ${res.status})`
						: `${where}: HTTP ${res.status}`,
					res.status === 429 || res.status >= 500
				);
				if (!last.retryable) throw last;
				wait = retryAfterMs(res.headers.get('retry-after'));
			} catch (err) {
				if (err instanceof SosError && (!err.retryable || attempt === SOS_MAX_TRIES)) throw err;
				if (signal.aborted) throw signal.reason;
				last = err instanceof SosError ? err : new SosError(`${where}: ${err instanceof Error ? err.message : String(err)}`, true);
			}
			if (attempt < SOS_MAX_TRIES) {
				await this.sleep((wait ?? Math.min(2 ** attempt * 2000, SOS_BACKOFF_MAX_MS)) + Math.floor(Math.random() * 500), signal);
			}
		}
		throw last ?? new SosError(`${where}: failed`, true);
	}
}

function parsePage(body: unknown, where: string, take: number): CursorPage {
	const b = body as { totalCount?: unknown; records?: unknown; nextCursor?: unknown } | null;
	const total = b?.totalCount;
	if (typeof total !== 'number' || !Number.isInteger(total) || total < 0 || !Array.isArray(b?.records)) {
		throw new SosError(`${where}: the answer has no usable count or records`, true);
	}
	if (b.records.length > take) throw new SosError(`${where}: ${b.records.length} records came back for a page of ${take}`, true);
	const next = typeof b.nextCursor === 'string' && b.nextCursor.trim() !== '' ? b.nextCursor : null;
	if (b.nextCursor !== null && b.nextCursor !== undefined && typeof b.nextCursor !== 'string') {
		throw new SosError(`${where}: the next cursor is not text`, true);
	}
	return { total, records: b.records, next };
}

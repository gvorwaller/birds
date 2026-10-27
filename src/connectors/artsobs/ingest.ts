/**
 * The connector's side of ingest contract v1 (td-eec7db Phase 2 rev B).
 *
 * The bearer token is sent only to the configured ingest origin and path;
 * redirects are never followed [C-P2-6]. Network errors, 5xx and 429 are
 * retried (every call is idempotent: claims by key, chunks by digest, finish
 * by its stored result), and so is a success answer without the shape its
 * call sends (CODEX1 rev B finding 3): a garbled 200 from a proxy is never
 * read as "done". 204 is a success only for a claim (no work). The token
 * never appears in an error or log line.
 */
import { randomUUID } from 'node:crypto';
import { CONTRACT_VERSION, type Manifest } from '$server/external-sources/contract';
import { FINISH_DEADLINE_MS, INGEST_DEADLINE_MS, INGEST_MAX_TRIES } from './config';
import { abortableSleep, retryAfterMs, type FetchFn, type SleepFn } from './artskart';

export class IngestCallError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code: string
	) {
		super(message);
		this.name = 'IngestCallError';
	}
	/** The lease is gone (expired, taken over, revoked): stop without calling fail. */
	get leaseLost(): boolean {
		return this.status === 401 || this.status === 404 || (this.status === 409 && this.code !== 'chunk_conflict');
	}
	get retryable(): boolean {
		return this.status === 0 || this.status === 429 || this.status >= 500;
	}
}

export interface ClaimedLoad {
	id: string;
	region_code: string;
	attempt: number;
	lease_token: string;
	lease_expires_at: string;
	window_months: number;
	window_ends: string[];
}

export interface Progress {
	phase: string;
	done: number;
	total: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const int = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/** A real calendar date that is the last day of its month (what the app's window ends are). */
function isMonthEnd(v: unknown): boolean {
	if (typeof v !== 'string' || !DAY.test(v)) return false;
	const d = new Date(`${v}T00:00:00Z`);
	if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== v) return false;
	d.setUTCDate(d.getUTCDate() + 1);
	return d.getUTCDate() === 1;
}

/**
 * Every field of a claimed load, checked inside the claim's retry loop: a
 * malformed answer is retried under the same idempotency key, never run (a
 * load without its region would otherwise be failed for good; CODEX1 rev B
 * re-review).
 */
export function isClaimedLoad(v: unknown): v is ClaimedLoad {
	if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
	const l = v as Record<string, unknown>;
	return (
		typeof l.id === 'string' &&
		UUID.test(l.id) &&
		typeof l.region_code === 'string' &&
		/^[A-Z]{2}-[A-Z0-9]+$/.test(l.region_code) &&
		int(l.attempt, 1, 10) &&
		typeof l.lease_token === 'string' &&
		UUID.test(l.lease_token) &&
		typeof l.lease_expires_at === 'string' &&
		Number.isFinite(Date.parse(l.lease_expires_at)) &&
		int(l.window_months, 1, 120) &&
		Array.isArray(l.window_ends) &&
		l.window_ends.length > 0 &&
		l.window_ends.every(isMonthEnd)
	);
}

/** Validate the ingest base once: http(s), ending in /api/ingest/, no credentials. */
export function ingestBase(raw: string | undefined): URL | null {
	if (!raw) return null;
	try {
		const u = new URL(raw);
		if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || u.search || u.hash) return null;
		return u.pathname.endsWith('/api/ingest/') ? u : null;
	} catch {
		return null;
	}
}

export class IngestClient {
	private readonly fetchFn: FetchFn;
	private readonly sleep: SleepFn;

	constructor(
		private readonly base: URL,
		private readonly token: string,
		opts: { fetch?: FetchFn; sleep?: SleepFn } = {}
	) {
		this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
		this.sleep = opts.sleep ?? abortableSleep;
	}

	private url(path: string): string {
		const u = new URL(path, this.base);
		if (u.origin !== this.base.origin || !u.pathname.startsWith(this.base.pathname)) {
			throw new IngestCallError(`Refusing to send the token outside ${this.base.origin}${this.base.pathname}`, 0, 'origin');
		}
		return u.toString();
	}

	/**
	 * POST JSON; returns the parsed body (null for 204, where `allowNoContent`).
	 * A 200 whose body `accept` refuses is retried like a 5xx. Throws IngestCallError.
	 */
	async post(
		path: string,
		body: unknown,
		signal: AbortSignal,
		opts: { deadlineMs?: number; accept?: (body: Record<string, unknown>) => boolean; allowNoContent?: boolean } = {}
	): Promise<Record<string, unknown> | null> {
		const deadlineMs = opts.deadlineMs ?? INGEST_DEADLINE_MS;
		const url = this.url(path);
		const payload = JSON.stringify(body);
		let last: IngestCallError | null = null;
		for (let attempt = 1; attempt <= INGEST_MAX_TRIES; attempt++) {
			let wait: number | null = null;
			try {
				if (signal.aborted) throw signal.reason;
				const res = await this.fetchFn(url, {
					method: 'POST',
					redirect: 'manual',
					headers: {
						authorization: `Bearer ${this.token}`,
						'content-type': 'application/json',
						'x-request-id': randomUUID()
					},
					body: payload,
					signal: AbortSignal.any([signal, AbortSignal.timeout(deadlineMs)])
				});
				const text = await res.text();
				let parsed: Record<string, unknown> | null = null;
				try {
					const v: unknown = text ? JSON.parse(text) : null;
					parsed = v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
				} catch {
					parsed = null;
				}
				if (res.status === 204 && opts.allowNoContent) return null;
				if (res.status === 200 && parsed && (opts.accept?.(parsed) ?? true)) return parsed;
				if (res.status === 200 || res.status === 204) {
					// A success without its body: retried (status 0 is retryable).
					last = new IngestCallError(`${path}: the app answered ${res.status} without the expected body`, 0, 'bad_answer');
				} else {
					const code = typeof parsed?.error === 'string' ? parsed.error : `http_${res.status}`;
					const message = typeof parsed?.message === 'string' ? parsed.message : `The app answered ${res.status}.`;
					last = new IngestCallError(`${path}: ${res.status} ${code}: ${message}`.slice(0, 400), res.status, code);
					if (res.status >= 300 && res.status < 400) throw new IngestCallError(`${path}: the app redirected; not following`, res.status, 'redirect');
					if (!last.retryable) throw last;
					wait = retryAfterMs(res.headers.get('retry-after'));
				}
			} catch (err) {
				if (err instanceof IngestCallError) throw err;
				if (signal.aborted) throw signal.reason;
				last = new IngestCallError(`${path}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 400), 0, 'network');
			}
			if (attempt < INGEST_MAX_TRIES) await this.sleep((wait ?? Math.min(2 ** attempt * 1000, 30_000)) + Math.floor(Math.random() * 250), signal);
		}
		throw last ?? new IngestCallError(`${path}: failed`, 0, 'network');
	}

	async claim(idempotencyKey: string, signal: AbortSignal): Promise<ClaimedLoad | null> {
		const r = await this.post('loads/claim', { contract_version: CONTRACT_VERSION, idempotency_key: idempotencyKey }, signal, {
			allowNoContent: true,
			accept: (b) => isClaimedLoad(b.load)
		});
		return r === null ? null : (r.load as ClaimedLoad);
	}

	private fence(load: ClaimedLoad) {
		return { contract_version: CONTRACT_VERSION, lease_token: load.lease_token, attempt: load.attempt };
	}

	async heartbeat(load: ClaimedLoad, progress: Progress, signal: AbortSignal): Promise<void> {
		await this.post(`loads/${load.id}/heartbeat`, { ...this.fence(load), progress }, signal, {
			accept: (b) => typeof b.lease_expires_at === 'string'
		});
	}

	async chunk(load: ClaimedLoad, chunk: { chunk_id: string; kind: string; sha256: string; rows: unknown[] }, signal: AbortSignal): Promise<string> {
		const r = await this.post(`loads/${load.id}/chunks`, { ...this.fence(load), ...chunk }, signal, {
			accept: (b) => b.status === 'stored' || b.status === 'duplicate'
		});
		return String(r!.status);
	}

	async finish(load: ClaimedLoad, manifest: Manifest, signal: AbortSignal): Promise<Record<string, unknown>> {
		const r = await this.post(`loads/${load.id}/finish`, { ...this.fence(load), manifest }, signal, {
			deadlineMs: FINISH_DEADLINE_MS,
			accept: (b) => b.status === 'done' && typeof b.result === 'object' && b.result !== null && !Array.isArray(b.result)
		});
		return r!.result as Record<string, unknown>;
	}

	async fail(load: ClaimedLoad, reason: string, retryable: boolean, signal: AbortSignal): Promise<void> {
		await this.post(`loads/${load.id}/fail`, { ...this.fence(load), reason: reason.slice(0, 300), retryable }, signal, {
			accept: (b) => b.status === 'done' || b.status === 'failed' || b.status === 'queued'
		});
	}
}

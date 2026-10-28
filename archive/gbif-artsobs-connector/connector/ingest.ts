/**
 * The connector's side of ingest contract v1 (td-eec7db Phase 2).
 *
 * The bearer token is sent only to the configured ingest origin and path;
 * redirects are never followed [C-P2-6]. Network errors, 5xx and 429 are
 * retried (every call is idempotent: claims by key, chunks by digest, finish
 * by its stored result). The token never appears in an error or log line.
 */
import { randomUUID } from 'node:crypto';
import { CONTRACT_VERSION, type Manifest } from '$server/external-sources/contract';
import { FINISH_DEADLINE_MS, INGEST_DEADLINE_MS, INGEST_MAX_TRIES } from './config';
import { abortableSleep, retryAfterMs, type FetchFn, type SleepFn } from './gbif';

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

	/** POST JSON; returns the parsed body (null for 204). Throws IngestCallError. */
	async post(path: string, body: unknown, signal: AbortSignal, deadlineMs = INGEST_DEADLINE_MS): Promise<Record<string, unknown> | null> {
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
				if (res.status === 204) return null;
				let parsed: Record<string, unknown> | null = null;
				try {
					parsed = text ? (JSON.parse(text) as Record<string, unknown>) : null;
				} catch {
					parsed = null;
				}
				if (res.status === 200) return parsed;
				const code = typeof parsed?.error === 'string' ? parsed.error : `http_${res.status}`;
				const message = typeof parsed?.message === 'string' ? parsed.message : `The app answered ${res.status}.`;
				last = new IngestCallError(`${path}: ${res.status} ${code}: ${message}`.slice(0, 400), res.status, code);
				if (res.status >= 300 && res.status < 400) throw new IngestCallError(`${path}: the app redirected; not following`, res.status, 'redirect');
				if (!last.retryable) throw last;
				wait = retryAfterMs(res.headers.get('retry-after'));
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
		const r = await this.post('loads/claim', { contract_version: CONTRACT_VERSION, idempotency_key: idempotencyKey }, signal);
		if (r === null) return null;
		const load = r.load as ClaimedLoad | undefined;
		if (!load || typeof load.id !== 'string' || !Array.isArray(load.window_ends) || load.window_ends.length === 0) {
			throw new IngestCallError('loads/claim: the answer has no usable load', 200, 'bad_answer');
		}
		return load;
	}

	private fence(load: ClaimedLoad) {
		return { contract_version: CONTRACT_VERSION, lease_token: load.lease_token, attempt: load.attempt };
	}

	async heartbeat(load: ClaimedLoad, progress: Progress, signal: AbortSignal): Promise<void> {
		await this.post(`loads/${load.id}/heartbeat`, { ...this.fence(load), progress }, signal);
	}

	async chunk(load: ClaimedLoad, chunk: { chunk_id: string; kind: string; sha256: string; rows: unknown[] }, signal: AbortSignal): Promise<string> {
		const r = await this.post(`loads/${load.id}/chunks`, { ...this.fence(load), ...chunk }, signal);
		return typeof r?.status === 'string' ? r.status : 'stored';
	}

	async finish(load: ClaimedLoad, manifest: Manifest, signal: AbortSignal): Promise<Record<string, unknown>> {
		const r = await this.post(`loads/${load.id}/finish`, { ...this.fence(load), manifest }, signal, FINISH_DEADLINE_MS);
		return (r?.result as Record<string, unknown>) ?? {};
	}

	async fail(load: ClaimedLoad, reason: string, retryable: boolean, signal: AbortSignal): Promise<void> {
		await this.post(`loads/${load.id}/fail`, { ...this.fence(load), reason: reason.slice(0, 300), retryable }, signal);
	}
}

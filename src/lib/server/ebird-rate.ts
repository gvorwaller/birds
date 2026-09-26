/**
 * eBird per-key rate limits (td-5003e2).
 *
 * Measured 2026-09-26 with the owner's key: every eBird response carries IETF
 * RateLimit headers,
 *   ratelimit-policy: "policy";q=500;w=3600,"burst";q=25;w=5
 *   ratelimit:        "policy";r=<left>,"burst";r=<left>
 * i.e. 25 requests per 5 s and 500 per hour, per key. A back-to-back 4-wide
 * burst (Compare hotspots) got 429 "Too Many Requests", retry-after=1, on its
 * 26th request 420 ms in.
 *
 * This module holds what the process has learned about each key (remaining
 * allowance, Retry-After blocks) and a token-bucket pacer for bulk callers.
 * State is per process: the web app and worker each keep their own, which is
 * why the pacer leaves headroom rather than spending the whole burst window.
 * Keys are identified by a hash; the raw key is never stored here.
 */
import { createHash } from 'node:crypto';

export interface KeyRateState {
	/** Requests left in the hourly window, as of `observedAt`. */
	policyRemaining: number | null;
	/** Requests left in the 5 s burst window, as of `observedAt`. */
	burstRemaining: number | null;
	observedAt: number;
	/** No request for this key before this time (from a 429's Retry-After). */
	blockedUntil: number;
}

const states = new Map<string, KeyRateState>();

function keyId(apiKey: string): string {
	return createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
}

function stateFor(apiKey: string): KeyRateState {
	const id = keyId(apiKey);
	let s = states.get(id);
	if (!s) {
		s = { policyRemaining: null, burstRemaining: null, observedAt: 0, blockedUntil: 0 };
		states.set(id, s);
	}
	return s;
}

/** Remaining counts from a `ratelimit` header value, e.g. `"policy";r=474,"burst";r=0`. */
export function parseRateLimit(value: string | null): {
	policy: number | null;
	burst: number | null;
} {
	const pick = (name: string) => {
		const m = value?.match(new RegExp(`"${name}";r=(\\d+)`));
		return m ? Number(m[1]) : null;
	};
	return { policy: pick('policy'), burst: pick('burst') };
}

/** Retry-After in ms: delta-seconds or an HTTP date. Null when absent or unparseable. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
	if (value == null || value.trim() === '') return null;
	const v = value.trim();
	if (/^\d+$/.test(v)) return Number(v) * 1000;
	const at = Date.parse(v);
	return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/** Wait after a 429 with no usable Retry-After: the measured burst window is 5 s. */
export const DEFAULT_RETRY_AFTER_MS = 5000;

/** Record what one eBird response says about its key. */
export function noteEbirdResponse(
	apiKey: string,
	headers: Pick<Headers, 'get'> | undefined,
	status: number,
	now = Date.now()
): { retryAfterMs: number | null } {
	const s = stateFor(apiKey);
	const { policy, burst } = parseRateLimit(headers?.get('ratelimit') ?? null);
	if (policy != null || burst != null) {
		s.policyRemaining = policy;
		s.burstRemaining = burst;
		s.observedAt = now;
	}
	let retryAfterMs: number | null = null;
	if (status === 429) {
		retryAfterMs = parseRetryAfter(headers?.get('retry-after') ?? null, now) ?? DEFAULT_RETRY_AFTER_MS;
		s.blockedUntil = Math.max(s.blockedUntil, now + retryAfterMs);
	}
	return { retryAfterMs };
}

export function ebirdRateState(apiKey: string): Readonly<KeyRateState> {
	return stateFor(apiKey);
}

/**
 * Hourly requests kept back for the rest of the app when a bulk caller is
 * spending the key (Home, species pages, the worker's alerts). A full
 * 333-hotspot comparison from a fresh hour ends with ~167 left, so one run
 * fits; a second within the hour stops here instead of starving everything.
 */
export const HOURLY_RESERVE = 100;
/** How long an observed hourly count is trusted. It only rises with time, so
 * an old low reading would block needlessly; after this, let a request
 * through and read the header again. */
const POLICY_TRUST_MS = 60_000;

/** The trusted hourly count when it is below the reserve, else null. */
export function belowHourlyReserve(apiKey: string, now = Date.now()): number | null {
	const s = stateFor(apiKey);
	if (s.policyRemaining == null || now - s.observedAt > POLICY_TRUST_MS) return null;
	return s.policyRemaining <= HOURLY_RESERVE ? s.policyRemaining : null;
}

export class PaceAborted extends Error {
	constructor() {
		super('Pacing wait cancelled.');
		this.name = 'PaceAborted';
	}
}

export class PaceDeferred extends Error {
	constructor(
		public readonly reason: 'rate' | 'quota',
		public readonly retryAfterMs?: number,
		public readonly quotaRemaining?: number
	) {
		super(reason === 'rate' ? 'Pacing wait deferred.' : 'Hourly allowance reserved.');
		this.name = 'PaceDeferred';
	}
}

export interface PaceConstraints {
	/** Return a rate deferral instead of sleeping longer than this. */
	maxBlockMs?: number;
	/** Stop before a comparison spends the hourly reserve. */
	preserveHourlyReserve?: boolean;
}

export interface PacerOptions {
	/** Sustained requests per second, per key. */
	ratePerSec: number;
	/** Requests allowed back to back before the rate applies. */
	burst: number;
	now?: () => number;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new PaceAborted());
		const t = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(t);
			reject(new PaceAborted());
		};
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

/**
 * Token bucket per key, shared by every caller in the process that uses the
 * same pacer, so two tabs or a retry cannot each run their own burst. Also
 * waits out a key's Retry-After block.
 */
export class EbirdPacer {
	private buckets = new Map<string, { tokens: number; at: number; tail: Promise<void> }>();
	private readonly now: () => number;
	private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

	constructor(private readonly opts: PacerOptions) {
		this.now = opts.now ?? Date.now;
		this.sleep = opts.sleep ?? abortableSleep;
	}

	/** Resolves when this key may send one request. Rejects with PaceAborted. */
	acquire(
		apiKey: string,
		signal?: AbortSignal,
		constraints: PaceConstraints = {}
	): Promise<void> {
		const id = keyId(apiKey);
		let b = this.buckets.get(id);
		if (!b) {
			b = { tokens: this.opts.burst, at: this.now(), tail: Promise.resolve() };
			this.buckets.set(id, b);
		}
		const bucket = b;
		// Serialize per key so waiters take tokens in arrival order.
			const turn = bucket.tail.then(async () => {
				for (;;) {
					if (signal?.aborted) throw new PaceAborted();
					const now = this.now();
					if (constraints.preserveHourlyReserve) {
						const left = belowHourlyReserve(apiKey, now);
						if (left != null) throw new PaceDeferred('quota', undefined, left);
					}
					const blocked = stateFor(apiKey).blockedUntil - now;
					if (blocked > 0) {
						if (blocked > (constraints.maxBlockMs ?? Number.POSITIVE_INFINITY))
							throw new PaceDeferred('rate', blocked);
						await this.sleep(blocked, signal);
					continue;
				}
				bucket.tokens = Math.min(
					this.opts.burst,
					bucket.tokens + ((now - bucket.at) / 1000) * this.opts.ratePerSec
				);
				bucket.at = now;
				if (bucket.tokens >= 1) {
					bucket.tokens -= 1;
					return;
				}
				await this.sleep(Math.ceil(((1 - bucket.tokens) / this.opts.ratePerSec) * 1000), signal);
			}
		});
		// A cancelled waiter must not stall the ones behind it.
		bucket.tail = turn.catch(() => {});
		return turn;
	}
}

/**
 * Compare hotspots' pacer: at most 6 back to back, then 3 per second. In any
 * 5 s window that is at most 6 + 15 = 21 of eBird's 25, leaving room for the
 * page's other eBird reads. 333 cache misses take about 110 s.
 */
export const comparisonPacer = new EbirdPacer({ ratePerSec: 3, burst: 6 });

export function __resetEbirdRateForTests(): void {
	states.clear();
}

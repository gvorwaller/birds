/**
 * Per-request latency accounting (refactor plan Phase 1,
 * docs/2026-08-30-regions-reference-data-refactor-plan.md).
 *
 * An AsyncLocalStorage bag rides each HTTP request; the shared chokepoints
 * (db.query, ebirdFetch, the Google fetches, AI calls) record {count, ms}
 * into it. hooks.server.ts turns the bag into a Server-Timing header and a
 * stdout `perf` line.
 *
 * Two different numbers, deliberately kept apart (CODEX1 P1-2): the
 * Server-Timing header is written when `resolve()` returns, which for a
 * streamed page is when the SHELL is ready — deferred chunks drain later.
 * The stdout line is emitted when the response BODY finishes (close or
 * cancel), so it covers streamed sections too. Don't conflate them.
 *
 * The worker has no request context: recordTiming is a no-op there (the
 * store returns undefined), so shared modules can record unconditionally.
 * Never put query params or user identifiers in the log line.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export type TimingBucket = 'db' | 'ebird' | 'google' | 'ai';

export interface TimingBag {
	startedAt: number;
	buckets: Record<TimingBucket, { n: number; ms: number }>;
}

const store = new AsyncLocalStorage<TimingBag>();

export function newTimingBag(now = Date.now()): TimingBag {
	return {
		startedAt: now,
		buckets: {
			db: { n: 0, ms: 0 },
			ebird: { n: 0, ms: 0 },
			google: { n: 0, ms: 0 },
			ai: { n: 0, ms: 0 }
		}
	};
}

export function runWithTiming<T>(bag: TimingBag, fn: () => T): T {
	return store.run(bag, fn);
}

/** Record one operation into the current request's bag; no-op off-request. */
export function recordTiming(bucket: TimingBucket, ms: number): void {
	const bag = store.getStore();
	if (!bag) return;
	const b = bag.buckets[bucket];
	b.n += 1;
	b.ms += ms;
}

/** Convenience wrapper: time an async operation into a bucket. */
export async function timed<T>(bucket: TimingBucket, fn: () => Promise<T>): Promise<T> {
	const t0 = Date.now();
	try {
		return await fn();
	} finally {
		recordTiming(bucket, Date.now() - t0);
	}
}

/**
 * Server-Timing header value for the SHELL (see module docstring). Rendered
 * in the browser's Network → Timing panel. Buckets with zero calls are
 * omitted.
 */
export function serverTimingHeader(bag: TimingBag, shellMs: number): string {
	const parts = [`shell;dur=${shellMs}`];
	for (const [name, b] of Object.entries(bag.buckets)) {
		if (b.n > 0) parts.push(`${name};dur=${Math.round(b.ms)};desc="${b.n} call${b.n === 1 ? '' : 's'}"`);
	}
	return parts.join(', ');
}

/** Human-readable byte size for the perf line. */
function fmtBytes(n: number): string {
	if (n < 1024) return `${n}B`;
	if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
	return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * One stdout line, emitted at body completion. Path only — never the query.
 *
 * `weight` carries what the response COST the client: exact bytes, and for
 * HTML an approximate tag count as a stand-in for DOM size (hydration scales
 * with nodes, not bytes). Together with shell=/db=/ebird= this makes all
 * three costs of a slow page — server work, transfer, hydration — legible
 * from one line rather than inferred.
 */
export function perfLogLine(
	pathname: string,
	status: number,
	shellMs: number,
	totalMs: number,
	bag: TimingBag,
	weight?: { bytes: number; tags: number | null }
): string {
	const parts = [
		`perf path=${pathname}`,
		`status=${status}`,
		`shell=${shellMs}ms`,
		`total=${totalMs}ms`
	];
	if (weight) {
		parts.push(`bytes=${fmtBytes(weight.bytes)}`);
		if (weight.tags != null) parts.push(`tags=${weight.tags}`);
	}
	for (const [name, b] of Object.entries(bag.buckets)) {
		if (b.n > 0) parts.push(`${name}=${b.n}/${Math.round(b.ms)}ms`);
	}
	return parts.join(' ');
}

/** Log threshold: quiet pages stay out of the prod log. Dev logs everything. */
export const PERF_LOG_SLOW_MS = 750;

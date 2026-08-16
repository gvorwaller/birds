/**
 * Pure logic for the jobs poller — rune-free, unit-tested.
 * Plan: docs/2026-08-15-ebird-worker-job-queue-plan.md §7.
 */

export interface PolledJob {
	id: number;
	status: string;
	progress: { phase?: string; unitsDone?: number } | Record<string, never>;
}

export const ACTIVE_STATUSES = new Set(['pending', 'running']);
export const POLL_ACTIVE_MS = 2_500;
/** Everything active is just waiting out a long backoff — poll lazily (GROK #13). */
export const POLL_WAITING_MS = 15_000;
/** Tab hasn't had a good poll for this long → show the stale line (GROK #3). */
export const STALE_AFTER_MS = 10_000;
export const INVALIDATE_THROTTLE_MS = 15_000;

export function isActive(job: Pick<PolledJob, 'status'>): boolean {
	return ACTIVE_STATUSES.has(job.status);
}

/**
 * Stale = failing for longer than STALE_AFTER_MS. The MANAGER re-evaluates
 * this on every failed poll and stores the answer in rune state — a getter
 * over Date.now() alone is not reactive and the warning could stay absent
 * forever (CODEX1 re-review #4).
 */
export function isStaleNow(staleSince: number | null, now: number): boolean {
	return staleSince != null && now - staleSince > STALE_AFTER_MS;
}

/**
 * Next poll delay. null = stop (nothing active; the caller does one grace
 * poll before stopping so a just-enqueued job isn't missed).
 */
export function nextIntervalMs(jobs: readonly PolledJob[]): number | null {
	const active = jobs.filter(isActive);
	if (active.length === 0) return null;
	const allWaiting = active.every(
		(j) => j.status === 'pending' && (j.progress as { phase?: string }).phase === 'waiting_retry'
	);
	return allWaiting ? POLL_WAITING_MS : POLL_ACTIVE_MS;
}

export type PollParse =
	| { kind: 'ok' }
	| { kind: 'auth' } // session gone — stop quietly; jobs continue server-side
	| { kind: 'error' }; // transient — keep last state, retry next tick

/**
 * Classify a poll response WITHOUT trusting status codes alone: an expired
 * session historically produced a 303→login-page HTML that JSON.parse chokes
 * on (GROK #1) — that is auth, not a network error.
 */
export function classifyPollResponse(
	status: number,
	contentType: string | null,
	bodyLooksJson: boolean
): PollParse {
	if (status === 401 || status === 403) return { kind: 'auth' };
	if (status >= 300 && status < 400) return { kind: 'auth' };
	if (status === 200 && (contentType?.includes('json') || bodyLooksJson)) return { kind: 'ok' };
	if (status === 200) return { kind: 'auth' }; // 200 HTML = login page
	return { kind: 'error' };
}

/** Jobs that crossed from active to terminal between two polls. */
export function terminalTransitions(
	prev: readonly PolledJob[],
	next: readonly PolledJob[]
): number[] {
	const prevActive = new Set(prev.filter(isActive).map((j) => j.id));
	return next.filter((j) => prevActive.has(j.id) && !isActive(j)).map((j) => j.id);
}

/**
 * Refresh discipline (GROK #4): page data reloads on terminal transitions
 * always, and on unit-progress changes at most every INVALIDATE_THROTTLE_MS.
 * Never on heartbeat/phase-only ticks.
 */
export function shouldInvalidate(
	prev: readonly PolledJob[],
	next: readonly PolledJob[],
	lastInvalidateAt: number,
	now: number
): boolean {
	if (terminalTransitions(prev, next).length > 0) return true;
	if (now - lastInvalidateAt < INVALIDATE_THROTTLE_MS) return false;
	const unitsOf = (jobs: readonly PolledJob[]) =>
		jobs
			.filter(isActive)
			.map((j) => `${j.id}:${(j.progress as { unitsDone?: number }).unitsDone ?? 0}`)
			.join(',');
	return unitsOf(prev) !== unitsOf(next) && next.some(isActive);
}

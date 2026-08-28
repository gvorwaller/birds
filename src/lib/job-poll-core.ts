/**
 * Pure logic for the jobs poller — rune-free, unit-tested.
 * Plan: docs/2026-08-15-ebird-worker-job-queue-plan.md §7.
 */

export interface PolledJob {
	id: number;
	status: string;
	/** Parked recurring singleton (next run in the future) — never active. */
	scheduled?: boolean;
	progress: { phase?: string; unitsDone?: number } | Record<string, never>;
}

export interface PolledWorkerControl {
	alive: boolean;
	state: string | null;
	pauseRequested: boolean;
}

export const ACTIVE_STATUSES = new Set(['pending', 'running']);
export const POLL_ACTIVE_MS = 2_500;
/** Everything active is just waiting out a long backoff — poll lazily (GROK #13). */
export const POLL_WAITING_MS = 15_000;
/** Tab hasn't had a good poll for this long → show the stale line (GROK #3). */
export const STALE_AFTER_MS = 10_000;
export const INVALIDATE_THROTTLE_MS = 15_000;

/**
 * A pause/resume command has been stored, but the worker has not acknowledged
 * the requested state yet. Admin keeps its fast poll alive for this brief
 * transition even when the job queue itself is idle.
 */
export function isWorkerControlTransitioning(worker: PolledWorkerControl): boolean {
	if (!worker.alive) return false;
	return worker.pauseRequested ? worker.state !== 'paused' : worker.state === 'paused';
}

export function isActive(job: Pick<PolledJob, 'status' | 'scheduled'>): boolean {
	// A recurring singleton parked until its NEXT run (scheduled) is not
	// active work: it must not light the chip, hold the 2.5s poll cadence,
	// or render as "queued" (td-b7d021 GROK pin a).
	return ACTIVE_STATUSES.has(job.status) && job.scheduled !== true;
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

export interface InvalidateState {
	/** A qualifying change was observed but couldn't fire yet — owed. */
	pending: boolean;
	lastInvalidateAt: number;
}

/**
 * One poll tick's invalidation decision (td-671082 + CODEX1 review). A
 * qualifying change is LATCHED, not dropped, when it can't fire — firing is
 * blocked while a navigation is in flight (an invalidateAll would supersede
 * it) and while off /forecast pages. The latch drains on the first tick
 * that's quiet AND on a forecast page, so a job finishing mid-navigation
 * still refreshes the arrived page exactly once. prev/next snapshots may be
 * identical by then — the latch carries the memory the snapshots can't.
 */
export function invalidateStep(
	state: InvalidateState,
	prev: readonly PolledJob[],
	next: readonly PolledJob[],
	navigatingActive: boolean,
	onForecast: boolean,
	now: number
): { fire: boolean; state: InvalidateState } {
	const owed = state.pending || shouldInvalidate(prev, next, state.lastInvalidateAt, now);
	if (owed && !navigatingActive && onForecast) {
		return { fire: true, state: { pending: false, lastInvalidateAt: now } };
	}
	return { fire: false, state: { pending: owed, lastInvalidateAt: state.lastInvalidateAt } };
}

/**
 * App-level jobs poller — the client half of the background-worker design.
 * Replaces the old forecastBulkLoad fetch loop. Module-scoped runes state
 * survives in-app navigation; because the JOBS are server-side, progress also
 * survives reloads and tab-close (td-ca32f0): the layout starts the poller
 * once and any active jobs are picked up wherever you are.
 *
 * Poll failures are visible-but-calm (GROK #3): the last known state stays
 * up, a staleSince timestamp drives a muted "connection lost" line, and the
 * next good poll clears it. Session expiry (401 JSON or a login-page
 * response) stops polling quietly — the jobs keep running server-side.
 *
 * Safari reality (GROK #2): timers freeze in background tabs and bfcache
 * restores skip onMount — so visibilitychange + pageshow both trigger an
 * immediate poll, and there is no wall-clock stop condition.
 */
import { browser } from '$app/environment';
import { invalidateAll } from '$app/navigation';
import {
	classifyPollResponse,
	isActive,
	isStaleNow,
	nextIntervalMs,
	shouldInvalidate
} from '$lib/job-poll-core';

export interface WorkerInfo {
	alive: boolean;
	state: string | null;
	pid: number | null;
	version: string | null;
	heartbeatAt: string | null;
	currentJobId: number | null;
}

export interface JobInfo {
	id: number;
	type: string;
	status: string;
	label: string;
	displayName: string;
	statusColor: string;
	attempts: number;
	maxAttempts: number;
	nextRetryAt: string | null;
	cancelRequested: boolean;
	progress: {
		phase?: string;
		unitsTotal?: number;
		unitsDone?: number;
		unitsFailed?: number;
		unitsSkipped?: number;
		currentUnit?: { code: string; name: string };
		lastError?: string;
	};
	error: string | null;
	requestedBy: number;
	requestedByName: string | null;
	enqueuedAt: string;
	finishedAt: string | null;
	/** Region/loc identity for UI scoping; null for multi-loc loads. */
	target: string | null;
	/** Active jobs only: loc codes the job covers. */
	locCodes?: string[];
}

class JobsPoll {
	worker = $state<WorkerInfo | null>(null);
	jobs = $state<JobInfo[]>([]);
	/** Set while polls are failing; null when the last poll succeeded. */
	staleSince = $state<number | null>(null);
	/**
	 * Rune STATE, not a Date.now() getter: re-evaluated on every failed poll
	 * (failures keep rescheduling at the active cadence), so the >10s warning
	 * reliably appears and reliably clears (CODEX1 re-review #4).
	 */
	isStale = $state(false);
	/** True after an auth stop — session gone, polling suspended. */
	authStopped = $state(false);

	#timer: ReturnType<typeof setTimeout> | null = null;
	#running = false;
	#graceDone = false;
	#lastInvalidate = 0;
	#listenersBound = false;
	/**
	 * Loop generation token (GROK Phase-1 review #1): exactly ONE poll loop may
	 * be alive. Every (re)start increments it; a #poll continuation belonging
	 * to an older generation dies at its next checkpoint. Without this, a
	 * stale fired-timer id left in #timer after a stop let track() spawn a
	 * second loop beside start()'s — Safari fires pageshow AND
	 * visibilitychange together, doubling polls and invalidateAll churn.
	 */
	#gen = 0;

	get active(): JobInfo[] {
		return this.jobs.filter((j) => isActive(j));
	}
	get recent(): JobInfo[] {
		return this.jobs.filter((j) => !isActive(j));
	}

	/** Start (or wake) the poller. Safe to call repeatedly; used by layout mount, enqueue results, and track(). */
	start(): void {
		if (!browser) return;
		this.authStopped = false;
		this.#bindListeners();
		if (this.#running) return;
		this.#running = true;
		this.#graceDone = false;
		void this.#poll(++this.#gen);
	}

	/** An action just enqueued jobId — poll immediately so it appears at once. */
	track(_jobId: number): void {
		const wasRunning = this.#running;
		this.start();
		if (wasRunning) {
			// Already looping: supersede whatever is scheduled or in flight with
			// an immediate poll of a NEW generation — the old loop dies at its
			// next generation checkpoint, so this can never stack a second loop.
			if (this.#timer) clearTimeout(this.#timer);
			this.#timer = null;
			void this.#poll(++this.#gen);
		}
	}

	async cancel(jobId: number): Promise<void> {
		try {
			await fetch(`/api/jobs/${jobId}/cancel`, { method: 'POST' });
		} catch {
			// next poll shows reality either way
		}
		this.track(jobId);
	}

	#bindListeners(): void {
		if (this.#listenersBound || !browser) return;
		this.#listenersBound = true;
		document.addEventListener('visibilitychange', () => {
			if (document.visibilityState === 'visible' && !this.authStopped) this.track(0);
		});
		window.addEventListener('pageshow', () => {
			if (!this.authStopped) this.track(0);
		});
	}

	async #poll(gen: number): Promise<void> {
		if (!this.#running || gen !== this.#gen) return;
		this.#timer = null;
		let parsed: ReturnType<typeof classifyPollResponse> = { kind: 'error' };
		try {
			const res = await fetch('/api/jobs', { headers: { accept: 'application/json' } });
			const text = await res.text();
			const looksJson = text.trimStart().startsWith('{');
			parsed = classifyPollResponse(res.status, res.headers.get('content-type'), looksJson);
			if (parsed.kind === 'ok') {
				const data = JSON.parse(text) as { worker: WorkerInfo; jobs: JobInfo[] };
				const prev = this.jobs;
				this.worker = data.worker;
				this.jobs = data.jobs;
				this.staleSince = null;
				this.isStale = false;
				if (
					/^\/forecast(\/|$)/.test(location.pathname) &&
					shouldInvalidate(prev, data.jobs, this.#lastInvalidate, Date.now())
				) {
					this.#lastInvalidate = Date.now();
					void invalidateAll();
				}
			}
		} catch {
			parsed = { kind: 'error' };
		}

		// A newer generation superseded this loop while we awaited the fetch.
		if (gen !== this.#gen) return;

		if (parsed.kind === 'auth') {
			// Session gone: stop quietly. Jobs keep running server-side.
			this.authStopped = true;
			this.#running = false;
			this.#timer = null;
			return;
		}
		if (parsed.kind === 'error') {
			if (this.staleSince == null) this.staleSince = Date.now();
			this.isStale = isStaleNow(this.staleSince, Date.now());
		}

		const interval = nextIntervalMs(this.jobs);
		if (interval == null && parsed.kind === 'ok') {
			if (this.#graceDone) {
				this.#running = false;
				this.#timer = null;
				return;
			}
			this.#graceDone = true;
			this.#timer = setTimeout(() => void this.#poll(gen), 15_000);
			return;
		}
		this.#graceDone = false;
		// On failed polls keep trying at the active cadence — silence is the
		// point; staleSince carries the honesty.
		this.#timer = setTimeout(() => void this.#poll(gen), interval ?? 2_500);
	}
}

export const jobsPoll = new JobsPoll();

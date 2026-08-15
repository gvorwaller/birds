/**
 * App-level bulk hotspot loader (GBV 2026-08-15: "if I switch away and come
 * back, the load has quit"). Module-scoped runes state + a fetch-driven loop
 * against the /forecast?/loadData action, so a run keeps going across
 * IN-APP navigation (SPA) and the Forecast page shows live progress whenever
 * you return. A full page reload or tab close still ends the run — loaded
 * data persists and one click resumes; true keep-running-when-closed needs
 * the background worker this app deliberately doesn't have (yet).
 *
 * All politeness lives server-side (ensureFrequencies: 12/batch, spacing,
 * lease, timeouts, daily cap); this module only decides whether to send the
 * next batch, via the pure loopVerdict.
 */
import { browser } from '$app/environment';
import { deserialize } from '$app/forms';
import { invalidateAll } from '$app/navigation';
import {
	loopVerdict,
	mergeFailures,
	type BulkFailure,
	type EnsureShape
} from '$lib/forecast-load-core';

export interface BulkOrigin {
	lat: number;
	lng: number;
	dist: number;
	label: string;
}

class ForecastBulkLoad {
	running = $state(false);
	total = $state(0);
	remaining = $state(0);
	failed = $state<BulkFailure[]>([]);
	credentialProblem = $state<string | null>(null);
	busyConflict = $state(false);
	stalled = $state(false);
	capReached = $state(false);
	/** Where the current/last run is loading ("St. Petersburg, FL"). */
	label = $state('');

	get done(): number {
		return Math.max(0, this.total - this.remaining);
	}
	get hasResult(): boolean {
		return (
			!this.running &&
			(this.failed.length > 0 ||
				this.credentialProblem != null ||
				this.busyConflict ||
				this.capReached ||
				this.stalled)
		);
	}

	async start(origin: BulkOrigin, locIds: readonly string[]): Promise<void> {
		if (!browser || this.running || locIds.length === 0) return;
		this.running = true;
		this.total = locIds.length;
		this.remaining = locIds.length;
		this.failed = [];
		this.credentialProblem = null;
		this.busyConflict = false;
		this.stalled = false;
		this.capReached = false;
		this.label = origin.label;

		try {
			for (;;) {
				let ensure: EnsureShape | null = null;
				try {
					const body = new FormData();
					body.set('lat', String(origin.lat));
					body.set('lng', String(origin.lng));
					body.set('dist', String(origin.dist));
					for (const id of locIds) body.append('loc', id);
					const res = await fetch('/forecast?/loadData', {
						method: 'POST',
						body,
						headers: { 'x-sveltekit-action': 'true' }
					});
					const result = deserialize(await res.text());
					if (result.type === 'success' && result.data) {
						ensure = (result.data as { ensure?: EnsureShape }).ensure ?? null;
					} else if (result.type === 'failure') {
						this.credentialProblem = String(
							(result.data as { error?: string } | undefined)?.error ?? 'Load failed.'
						);
						break;
					} else {
						this.credentialProblem = 'Load failed — server error; try again.';
						break;
					}
				} catch {
					this.credentialProblem = 'Load interrupted — network error; try again.';
					break;
				}
				if (!ensure) break;

				this.failed = mergeFailures(this.failed, ensure.failed);
				this.remaining = ensure.notAttempted.length;
				if (ensure.credentialProblem) this.credentialProblem = ensure.credentialProblem;
				if (ensure.busy) this.busyConflict = true;

				// Refresh the CURRENT page's data so /forecast (or /forecast/data)
				// updates live; other pages refresh naturally on navigation.
				if (/^\/forecast(\/|$)?/.test(location.pathname)) {
					await invalidateAll();
				}

				const verdict = loopVerdict(ensure);
				if (verdict.next === 'continue') continue;
				if (verdict.next === 'stop') {
					if (verdict.reason === 'stalled') this.stalled = true;
					if (verdict.reason === 'cap') this.capReached = true;
				}
				break;
			}
		} finally {
			this.running = false;
		}
	}

	/** Clear the finished-run result banner. */
	dismiss(): void {
		this.failed = [];
		this.credentialProblem = null;
		this.busyConflict = false;
		this.stalled = false;
		this.capReached = false;
		this.total = 0;
		this.remaining = 0;
	}
}

export const forecastBulkLoad = new ForecastBulkLoad();

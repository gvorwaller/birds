/**
 * Watch external-source loads the page shows as in progress (td-eec7db
 * Phase 3, CODEX1 F3). The signed-in user's own loads end through the jobs
 * poll, which reloads the page; a load someone else started never appears
 * there, so the card would show "Loading" forever. While any watched load is
 * in progress, ask /api/external/load-state every WATCH_MS and reload the
 * page's data once one of them has ended.
 */
import { invalidateAll } from '$app/navigation';

export const WATCH_MS = 15_000;

export interface WatchedLoad {
	sourceId: string;
	regionCode: string;
}

/** Call from a component's script; `watched` is read reactively. */
export function watchExternalLoads(watched: () => WatchedLoad[]): void {
	$effect(() => {
		const list = watched();
		if (list.length === 0) return;
		const query = list.map((w) => `k=${encodeURIComponent(`${w.sourceId}:${w.regionCode}`)}`).join('&');
		let stopped = false;
		const timer = setInterval(async () => {
			if (stopped || document.visibilityState === 'hidden') return;
			try {
				const res = await fetch(`/api/external/load-state?${query}`);
				if (!res.ok) return;
				const body = (await res.json()) as { states: { active: boolean }[] };
				if (!stopped && body.states.some((s) => !s.active)) {
					stopped = true;
					clearInterval(timer);
					await invalidateAll();
				}
			} catch {
				/* A failed check is retried on the next tick. */
			}
		}, WATCH_MS);
		return () => {
			stopped = true;
			clearInterval(timer);
		};
	});
}

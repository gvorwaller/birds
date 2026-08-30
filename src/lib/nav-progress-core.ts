/**
 * Pure state machine for the global navigation progress bar (refactor plan
 * Phase 8) — split from the component so the timing logic is unit-testable
 * without a DOM, mirroring the job-poll.svelte.ts / job-poll-core.ts pattern.
 *
 * The WIDTH IS DRIVEN BY JS STATE, not CSS animation, on purpose: app.css's
 * reduced-motion block sets `animation: none !important` globally, which
 * would freeze a keyframe-driven bar at its initial width — a stuck bar is
 * worse than none. JS width assignments still take effect instantly; the CSS
 * transition on the fill is pure polish that the global block may remove.
 */

/** Don't flash on fast navigations. */
export const SHOW_DELAY_MS = 150;
/** Let the bar visibly reach 100% before it leaves. */
export const HOLD_AFTER_DONE_MS = 200;
/** How often the trickle recomputes. */
export const TICK_MS = 100;

/** The bar appears only once a navigation has outlived the flash window. */
export function shouldShow(startedAt: number, now: number): boolean {
	return now - startedAt >= SHOW_DELAY_MS;
}

/**
 * Indeterminate trickle: fast start, asymptotic approach to 90% — never
 * pretends to finish on its own. Completion snaps to 100 in the component.
 */
export function widthAt(elapsedMs: number): number {
	if (elapsedMs <= 0) return 0;
	return 90 * (1 - Math.exp(-elapsedMs / 1500));
}

import { describe, expect, it } from 'vitest';
import { HOLD_AFTER_DONE_MS, SHOW_DELAY_MS, shouldShow, widthAt } from './nav-progress-core';

describe('nav-progress-core', () => {
	it('holds the bar back during the flash window, shows it after', () => {
		expect(shouldShow(1000, 1000 + SHOW_DELAY_MS - 1)).toBe(false);
		expect(shouldShow(1000, 1000 + SHOW_DELAY_MS)).toBe(true);
	});

	it('width starts at 0, advances monotonically, never reaches 90', () => {
		expect(widthAt(0)).toBe(0);
		let prev = 0;
		for (const t of [100, 300, 800, 1500, 3000, 10_000, 60_000]) {
			const w = widthAt(t);
			expect(w).toBeGreaterThan(prev);
			expect(w).toBeLessThan(90);
			prev = w;
		}
	});

	it('advances purely from elapsed time — no CSS animation dependency', () => {
		// The reduced-motion guarantee: two successive JS evaluations differ,
		// so the bar moves even with every transition/animation disabled.
		expect(widthAt(500)).not.toBe(widthAt(600));
	});

	it('exports a positive completion hold', () => {
		expect(HOLD_AFTER_DONE_MS).toBeGreaterThan(0);
	});
});

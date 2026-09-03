import { describe, expect, it } from 'vitest';
import { bottomNavViewportCorrection } from './bottom-nav';

describe('bottomNavViewportCorrection', () => {
	it('moves a standalone nav through a stale keyboard-sized viewport gap', () => {
		expect(
			bottomNavViewportCorrection({
				layoutHeight: 844,
				visualOffsetTop: 0,
				visualHeight: 472,
				standalone: true
			})
		).toBe(372);
	});

	it('accounts for a panned visual viewport', () => {
		expect(
			bottomNavViewportCorrection({
				layoutHeight: 844,
				visualOffsetTop: 40,
				visualHeight: 700,
				standalone: true
			})
		).toBe(104);
	});

	it('does nothing when the viewport is restored or the app is not standalone', () => {
		expect(
			bottomNavViewportCorrection({
				layoutHeight: 844,
				visualOffsetTop: 0,
				visualHeight: 844,
				standalone: true
			})
		).toBe(0);
		expect(
			bottomNavViewportCorrection({
				layoutHeight: 844,
				visualOffsetTop: 0,
				visualHeight: 472,
				standalone: false
			})
		).toBe(0);
	});

	it('ignores animation rounding below one pixel', () => {
		expect(
			bottomNavViewportCorrection({
				layoutHeight: 844,
				visualOffsetTop: 0.3,
				visualHeight: 843.1,
				standalone: true
			})
		).toBe(0);
	});
});

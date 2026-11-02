import { describe, expect, it } from 'vitest';
import { fixedBarOffsets, opensKeyboard } from './bottom-nav';

describe('fixedBarOffsets', () => {
	it('leaves a healthy viewport alone', () => {
		expect(
			fixedBarOffsets({ layoutHeight: 812, visualOffsetTop: 0, visualHeight: 812, scale: 1 })
		).toEqual({ top: 0, bottom: 0 });
	});

	it('moves both bars down onto the screen edges of a panned visual viewport', () => {
		// The owner's screenshot (2026-11-02): both bars ~326 pt up the screen,
		// the top bar out of sight, after the keyboard had closed.
		expect(
			fixedBarOffsets({ layoutHeight: 812, visualOffsetTop: 326, visualHeight: 812, scale: 1 })
		).toEqual({ top: 326, bottom: 326 });
	});

	it('moves the bottom bar down when the layout viewport stays keyboard-sized', () => {
		// Measured in the iOS 26.5 simulator while a field had the keyboard:
		// innerHeight 588 under a full-height screen.
		expect(
			fixedBarOffsets({ layoutHeight: 588, visualOffsetTop: 0, visualHeight: 812, scale: 1 })
		).toEqual({ top: 0, bottom: 224 });
	});

	it('handles an offset that only hides part of the top bar', () => {
		// WebKit 297779: offsetTop stuck at 24 with height 24 short of innerHeight.
		expect(
			fixedBarOffsets({ layoutHeight: 844, visualOffsetTop: 24, visualHeight: 820, scale: 1 })
		).toEqual({ top: 24, bottom: 0 });
	});

	it('does not chase the visual viewport while pinch-zoomed', () => {
		expect(
			fixedBarOffsets({ layoutHeight: 812, visualOffsetTop: 200, visualHeight: 406, scale: 2 })
		).toEqual({ top: 0, bottom: 0 });
	});

	it('ignores animation rounding below one pixel', () => {
		expect(
			fixedBarOffsets({ layoutHeight: 844, visualOffsetTop: 0.3, visualHeight: 843.1, scale: 1 })
		).toEqual({ top: 0, bottom: 0 });
	});
});

describe('opensKeyboard', () => {
	const input = (type: string, more: Record<string, boolean> = {}) => ({
		tagName: 'INPUT',
		type,
		...more
	});

	it('is true for text entry fields', () => {
		expect(opensKeyboard(input('text'))).toBe(true);
		expect(opensKeyboard(input('search'))).toBe(true);
		expect(opensKeyboard(input('password'))).toBe(true);
		expect(opensKeyboard(input('number'))).toBe(true);
		expect(opensKeyboard({ tagName: 'TEXTAREA' })).toBe(true);
		expect(opensKeyboard({ tagName: 'DIV', isContentEditable: true })).toBe(true);
	});

	it('is false for controls without a keyboard, read-only or disabled fields', () => {
		expect(opensKeyboard(null)).toBe(false);
		expect(opensKeyboard({ tagName: 'BODY', isContentEditable: false })).toBe(false);
		expect(opensKeyboard({ tagName: 'BUTTON', type: 'submit' })).toBe(false);
		expect(opensKeyboard({ tagName: 'SELECT', type: 'select-one' })).toBe(false);
		expect(opensKeyboard(input('checkbox'))).toBe(false);
		expect(opensKeyboard(input('submit'))).toBe(false);
		expect(opensKeyboard(input('text', { readOnly: true }))).toBe(false);
		expect(opensKeyboard(input('text', { disabled: true }))).toBe(false);
	});
});

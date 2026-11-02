interface ViewportMeasurements {
	layoutHeight: number;
	visualOffsetTop: number;
	visualHeight: number;
	scale: number;
}

export interface FixedBarOffsets {
	top: number;
	bottom: number;
}

/**
 * How far to move the fixed top and bottom bars so they sit on the edges of
 * the visual viewport (what is on screen) rather than the layout viewport.
 * The two agree on a healthy page; iOS 26 installed apps can keep them apart
 * after the keyboard closes, which leaves both bars floating up the screen.
 * Pinch zoom is left alone: fixed bars are meant to stay put while zoomed.
 * A sub-pixel discrepancy is normal during viewport animation and does not
 * warrant promoting a bar to a transformed layer.
 */
export function fixedBarOffsets({
	layoutHeight,
	visualOffsetTop,
	visualHeight,
	scale
}: ViewportMeasurements): FixedBarOffsets {
	if (Math.abs(scale - 1) > 0.01) return { top: 0, bottom: 0 };
	const top = visualOffsetTop;
	const bottom = visualOffsetTop + visualHeight - layoutHeight;
	return {
		top: Math.abs(top) >= 1 ? Math.round(top) : 0,
		bottom: Math.abs(bottom) >= 1 ? Math.round(bottom) : 0
	};
}

const NON_TEXT_INPUTS = new Set([
	'button',
	'checkbox',
	'color',
	'file',
	'hidden',
	'image',
	'radio',
	'range',
	'reset',
	'submit'
]);

interface FocusTarget {
	tagName: string;
	type?: string;
	readOnly?: boolean;
	disabled?: boolean;
	isContentEditable?: boolean;
}

/** Whether focusing this element brings up the on-screen keyboard. */
export function opensKeyboard(element: FocusTarget | null): boolean {
	if (!element) return false;
	const tag = element.tagName.toUpperCase();
	if (tag === 'TEXTAREA' || (tag === 'INPUT' && !NON_TEXT_INPUTS.has(element.type ?? 'text'))) {
		return !element.readOnly && !element.disabled;
	}
	return element.isContentEditable === true;
}

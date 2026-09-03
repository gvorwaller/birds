interface ViewportMeasurements {
	layoutHeight: number;
	visualOffsetTop: number;
	visualHeight: number;
	standalone: boolean;
}

/**
 * Return the unpainted strip below a stale iOS standalone visual viewport.
 * A sub-pixel discrepancy is normal during viewport animation and does not
 * warrant promoting the nav to a transformed layer.
 */
export function bottomNavViewportCorrection({
	layoutHeight,
	visualOffsetTop,
	visualHeight,
	standalone
}: ViewportMeasurements): number {
	if (!standalone) return 0;
	const gap = layoutHeight - (visualOffsetTop + visualHeight);
	return gap >= 1 ? Math.round(gap) : 0;
}

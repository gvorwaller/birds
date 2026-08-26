/**
 * Dominant meter figure for a window/cell. Unpriced (unknown-spend) rows
 * contribute 0 to the numeric sum, so a window whose only rows are aborts
 * or 200-missing-usage would otherwise render as a $0.00 receipt. Null
 * means "render —", matching dollarsForRow.
 */
export function meterDollars(dollars: number, unpricedAttempts: number): number | null {
	if (unpricedAttempts > 0 && !(dollars > 0)) return null;
	return dollars;
}

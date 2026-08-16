/**
 * Pure remembered-search restore decision for the Forecast tabs (td-671082,
 * plan Part B). Rune-free and unit-tested; the LIFECYCLE (afterNavigate,
 * goto, the invalidate race) lives in ForecastTabs.svelte and is covered by
 * the browser charter — pure tests cannot prove races (CODEX1 #8).
 *
 * Rules (unchanged from the original design):
 * - Identity = an actual selection key PRESENT in the url. An explicit
 *   cleared search has the key present-but-empty, so it WINS over the saved
 *   search (no restore).
 * - month/dist alone are NOT identity (GROK #5): a month-only URL still
 *   deserves its remembered search, with the current month/dist merged over
 *   the restored params.
 */

export const IDENTITY_KEYS = ['place', 'lat', 'loc', 'species', 'q', 'region', 'county'] as const;

/** Saved-side identity needs a VALUE (an empty saved place restores nothing). */
const SAVED_IDENTITY_KEYS = ['place', 'lat', 'species', 'q', 'region'] as const;

export function hasIdentityParam(search: string): boolean {
	const sp = new URLSearchParams(search);
	return IDENTITY_KEYS.some((k) => sp.has(k));
}

export type RestoreDecision = { restore: false } | { restore: true; target: string };

/**
 * Decide whether a just-arrived-at URL (query string, no leading "?") should
 * be replaced by the saved search, and compute the merged target params.
 */
export function restoreDecision(currentSearch: string, saved: string | null): RestoreDecision {
	const current = new URLSearchParams(currentSearch);
	if (IDENTITY_KEYS.some((k) => current.has(k))) return { restore: false };
	const ssp = new URLSearchParams(saved ?? '');
	if (!SAVED_IDENTITY_KEYS.some((k) => ssp.get(k))) return { restore: false };
	for (const k of ['month', 'dist']) {
		const cur = current.get(k);
		if (cur) ssp.set(k, cur);
	}
	return { restore: true, target: ssp.toString() };
}

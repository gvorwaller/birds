/**
 * Exact-match active state for the drawer's Field guide item (GROK
 * contract): /species/[code] detail pages must NOT light it — extracted
 * pure so the invariant is testable (CODEX1 Phase-3 #1).
 */
export function isFieldGuideActive(path: string): boolean {
	return path === '/species' || path === '/species/';
}

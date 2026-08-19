/**
 * Nearest-lifer target selection (td-a6c322). Pure — the /nearest loader
 * feeds it this month's forecastNeedsNear species list.
 * GROK pins: cap 6, likely band only (never padded with possible/longshot),
 * lowSample rows skipped, back locked to 14.
 */
import { FREQ_LIKELY } from '$server/forecast';

export const AUTO_RUN_CAP = 6;
export const NEAREST_BACK_DAYS = 14;

export interface AutoRunCandidate {
	code: string;
	comName: string;
	areaFreq: number;
	lowSample: boolean;
}

export function pickAutoRunTargets<T extends AutoRunCandidate>(
	species: readonly T[]
): { picks: T[]; likelyCount: number } {
	const likely = species.filter((s) => !s.lowSample && s.areaFreq >= FREQ_LIKELY);
	return { picks: likely.slice(0, AUTO_RUN_CAP), likelyCount: likely.length };
}

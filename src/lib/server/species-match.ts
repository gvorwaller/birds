/**
 * Species-name → eBird species_code matching, shared by the gallery sync and
 * the life-list/CSV import. Match order (cs.md): override table → exact
 * normalized common name → exact normalized scientific name → unmatched.
 */
import { query } from '$lib/db';

export function normalizeName(s: string): string {
	return s
		.normalize('NFD')
		.replace(/\p{M}/gu, '') // strip diacritics
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ') // punctuation/hyphens → single space
		.trim();
}

export type MatchMethod = 'override' | 'common' | 'scientific';

export interface SpeciesMatcher {
	match(
		comName: string | null | undefined,
		sciName?: string | null
	): { code: string; method: MatchMethod } | null;
	taxonomySize: number;
}

/** Loads taxonomy + overrides into memory (one query each; ~17k rows is fine). */
export async function buildMatcher(): Promise<SpeciesMatcher> {
	const taxa = await query<{ species_code: string; com_name: string; sci_name: string }>(
		`SELECT species_code, com_name, sci_name FROM taxonomy_cache WHERE category = 'species'`
	);
	const overrides = await query<{ source_name: string; species_code: string }>(
		'SELECT source_name, species_code FROM species_match_overrides'
	);

	const byCom = new Map<string, string>();
	const bySci = new Map<string, string>();
	for (const t of taxa.rows) {
		byCom.set(normalizeName(t.com_name), t.species_code);
		bySci.set(normalizeName(t.sci_name), t.species_code);
	}
	const byOverride = new Map<string, string>();
	for (const o of overrides.rows) {
		byOverride.set(normalizeName(o.source_name), o.species_code);
	}

	return {
		taxonomySize: taxa.rows.length,
		match(comName, sciName) {
			const com = comName ? normalizeName(comName) : '';
			const sci = sciName ? normalizeName(sciName) : '';
			if (com && byOverride.has(com)) return { code: byOverride.get(com)!, method: 'override' };
			if (com && byCom.has(com)) return { code: byCom.get(com)!, method: 'common' };
			if (sci && bySci.has(sci)) return { code: bySci.get(sci)!, method: 'scientific' };
			return null;
		}
	};
}

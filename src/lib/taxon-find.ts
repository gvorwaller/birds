/**
 * Admin → Sources → Change a match → "Find a taxon" (td-e5b164). The owner
 * typed "Kråka" for kråke: nothing contained it, every row hid, and the list
 * looked gone. Text is compared without case or accents (å→a, ø→o, æ→ae),
 * and when nothing contains it the closest names are offered instead: a word
 * that starts with the text less its last letter, so one wrong ending still
 * finds the taxon.
 */

/** Lower case, accents dropped, the Nordic letters spelled the way they are typed without them. */
export function foldText(s: string): string {
	return s
		.toLowerCase()
		.replace(/æ/g, 'ae')
		.replace(/ø/g, 'o')
		.normalize('NFD')
		.replace(/\p{M}/gu, '')
		.trim();
}

/** Shortest start of a word the close match looks for. */
const MIN_STEM = 3;

export type FindMode = 'all' | 'contains' | 'close' | 'none';

export interface FindResult<T> {
	mode: FindMode;
	/** The rows to show (all of them when nothing is typed). */
	shown: Set<T>;
}

/**
 * Which rows to show for the typed text. `names` gives each row's searchable
 * names (Norwegian, scientific, eBird name, code).
 */
export function findTaxa<T>(rows: readonly T[], query: string, names: (row: T) => (string | null | undefined)[]): FindResult<T> {
	const q = foldText(query);
	if (!q) return { mode: 'all', shown: new Set(rows) };
	const folded = rows.map((r) => ({ r, names: names(r).filter((v): v is string => !!v).map(foldText) }));

	const contains = folded.filter((x) => x.names.some((v) => v.includes(q)));
	if (contains.length) return { mode: 'contains', shown: new Set(contains.map((x) => x.r)) };

	const stem = q.slice(0, -1);
	if (stem.length >= MIN_STEM) {
		const close = folded.filter((x) => x.names.some((v) => v.split(/[\s\-·]+/).some((w) => w.startsWith(stem))));
		if (close.length) return { mode: 'close', shown: new Set(close.map((x) => x.r)) };
	}
	return { mode: 'none', shown: new Set() };
}

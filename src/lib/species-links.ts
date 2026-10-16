/**
 * Outbound species-link builders (pure, client-safe).
 *
 * All About Birds guide slugs strip punctuation from common names:
 * "Anna's Hummingbird" → /guide/Annas_Hummingbird (verified against
 * Cornell's live canonical URLs — CODEX1 td-09fdc0 review). Hyphens are
 * KEPT ("Black-capped_Chickadee"); apostrophes/periods dropped; diacritics
 * folded to ASCII; whitespace → underscores.
 */
export function allAboutBirdsUrl(comName: string): string {
	const slug = comName
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '') // fold combining diacritics
		.replace(/[\u0027\u2018\u2019\u02BB.]/g, '') // apostrophes (straight/curly/okina) + periods
		.trim()
		.replace(/\s+/g, '_');
	return `https://www.allaboutbirds.org/guide/${encodeURIComponent(slug)}`;
}

/**
 * Birds of the World species account, keyed by the eBird species code (the
 * same code BOW uses). Null unless the signed-in account subscribes, and for
 * any non-species taxon: BOW 404s for forms, hybrids, slashes, spuhs, ISSFs,
 * intergrades and domestics (verified live, td-9308e2).
 */
export function birdsOfTheWorldUrl(
	taxon: { species_code: string; category: string },
	subscriber: boolean
): string | null {
	if (!subscriber || taxon.category !== 'species') return null;
	return `https://birdsoftheworld.org/bow/species/${encodeURIComponent(taxon.species_code)}/cur/introduction`;
}

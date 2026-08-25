/**
 * Expansion of eBird "slash" taxa into their member species (td-8f0ed8).
 *
 * A slash taxon exists precisely because birders routinely CANNOT separate its
 * members in the field — "Greater/Lesser Scaup", "Downy/Hairy Woodpecker",
 * "Sharp-shinned/Cooper's Hawk". That makes the 1,035 `category = 'slash'` rows
 * already sitting in `taxonomy_cache` a curated confusion list, sourced from
 * Cornell, free, and offline. This module turns one slash row's scientific name
 * back into the binomials of its members so they can be resolved to species
 * codes.
 *
 * THE RULE IS NOT "PREFIX THE FIRST GENUS". Each "/"-separated part is either a
 * full binomial or a bare epithet, and a bare epithet inherits the genus of the
 * NEAREST PRECEDING part that carried one:
 *
 *   Porzana porzana/Zapornia parva/pusilla
 *     -> Porzana porzana, Zapornia parva, Zapornia pusilla   (correct)
 *     -> ...,            ...,            Porzana pusilla     (does not exist)
 *
 * Getting that wrong yields plausible-looking binomials that resolve to nothing,
 * so the carry-forward case is the regression guard in the tests. Measured
 * against the live taxonomy: 2,109 of 2,116 member slots (99.7%) resolve to real
 * species codes. 42 slash taxa have three or more members, up to five
 * ("Larus smithsonianus/vegae/mongolicus/argentatus/fuscus"), and members can
 * cross genera ("Accipiter striatus/Astur cooperii").
 *
 * Client-safe on purpose: no DB, no imports, unit-testable in isolation.
 */

/**
 * Expand a slash taxon's scientific name into its member binomials, in the
 * order eBird prints them.
 *
 * Case is PRESERVED — callers comparing against `taxonomy_cache.sci_name` must
 * lowercase BOTH sides, since the stored values are capitalised too.
 *
 * Returns `[]` for anything that is not an expandable slash name: no "/" at
 * all, or a leading part that carries no genus to inherit from.
 *
 * Contract: species-level slash taxa only (`category = 'slash'`). Subspecies
 * slashes such as "Astur bicolor bicolor/fidens" (category `issf`) are NOT
 * handled — a bare epithet there is a third rank, not a second, and this
 * function would pair it with the genus alone.
 */
export function expandSlashSciNames(sciName: string): string[] {
	if (!sciName.includes('/')) return [];

	const out: string[] = [];
	let genus = '';

	for (const raw of sciName.split('/')) {
		const part = raw.trim().replace(/\s+/g, ' ');
		if (part.length === 0) return [];

		if (part.includes(' ')) {
			// A full binomial: use it verbatim, and it becomes the genus that any
			// following bare epithet inherits.
			genus = part.slice(0, part.indexOf(' '));
			out.push(part);
		} else {
			// A bare epithet. With no genus seen yet there is nothing to inherit,
			// which means this is not a name we can expand — bail rather than
			// synthesise something (cs.md forbids placeholder data).
			if (genus.length === 0) return [];
			out.push(`${genus} ${part}`);
		}
	}

	return out;
}

/**
 * The candidates a slash taxon contributes to one focal species: every OTHER
 * member, paired with its position in the slash name.
 *
 * The ordinal is what gives a stable order WITHIN one slash row. It is not
 * sufficient on its own — a species can belong to several slash taxa (Cooper's
 * Hawk sits in both "Accipiter striatus/Astur cooperii" and
 * "Astur cooperii/atricapillus"), so the caller must also order by the slash
 * taxon's own code before deduplicating by target.
 *
 * Comparison is case-insensitive; `focalSciName` need not match the stored
 * capitalisation.
 */
export function slashPartnersFor(
	focalSciName: string,
	slashSciName: string
): { sciName: string; ordinal: number }[] {
	const members = expandSlashSciNames(slashSciName);
	const focal = focalSciName.trim().toLowerCase();
	if (!members.some((m) => m.toLowerCase() === focal)) return [];

	return members
		.map((sciName, i) => ({ sciName, ordinal: i }))
		.filter((m) => m.sciName.toLowerCase() !== focal);
}

import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { query, withTransaction } from '$lib/db';
import {
	allPhotoLinks,
	refreshGalleryIfStale,
	syncGallery,
	type PhotoLink
} from '$server/gallery';
import { buildMatcher, normalizeName } from '$server/species-match';

export interface SpeciesGroup {
	speciesCode: string;
	comName: string;
	sciName: string | null;
	photos: PhotoLink[];
}

export const load: PageServerLoad = async () => {
	await refreshGalleryIfStale();
	const links = await allPhotoLinks();

	const groups = new Map<string, SpeciesGroup>();
	const unmatched = new Map<string, PhotoLink[]>();
	for (const link of links) {
		if (link.species_code) {
			let g = groups.get(link.species_code);
			if (!g) {
				g = {
					speciesCode: link.species_code,
					comName: link.com_name ?? link.source_species,
					sciName: link.source_sci_name,
					photos: []
				};
				groups.set(link.species_code, g);
			}
			g.photos.push(link);
		} else {
			const key = link.source_species || '(no species set)';
			if (!unmatched.has(key)) unmatched.set(key, []);
			unmatched.get(key)!.push(link);
		}
	}

	const newest = await query<{ newest: string | null }>(
		'SELECT MAX(fetched_at)::text AS newest FROM photo_links'
	);

	return {
		groups: [...groups.values()].sort((a, b) => b.photos.length - a.photos.length),
		unmatched: [...unmatched.entries()].map(([name, photos]) => ({ name, photos })),
		total: links.length,
		fetchedAt: newest.rows[0]?.newest ?? null
	};
};

export const actions: Actions = {
	refresh: async () => {
		try {
			const result = await syncGallery();
			return { ok: true as const, message: `Synced ${result.total} photos (${result.matched} matched).` };
		} catch (err) {
			return fail(502, {
				error: `Sync failed: ${err instanceof Error ? err.message : err}. Showing the cached index.`
			});
		}
	},

	override: async ({ request }) => {
		const form = await request.formData();
		const sourceName = (form.get('source_name') ?? '').toString().trim();
		const speciesText = (form.get('species') ?? '').toString().trim();
		if (!sourceName || !speciesText) {
			return fail(400, { error: 'Both the photo name and a species are required.' });
		}

		// Accept an exact eBird common name, scientific name, or species code.
		const matcher = await buildMatcher();
		let match = matcher.match(speciesText, speciesText);
		if (!match) {
			const byCode = await query<{ species_code: string }>(
				'SELECT species_code FROM taxonomy_cache WHERE species_code = $1',
				[speciesText.toLowerCase()]
			);
			if (byCode.rows[0]) match = { code: byCode.rows[0].species_code, method: 'override' };
		}
		if (!match) {
			return fail(404, {
				error: `"${speciesText}" is not in the eBird taxonomy — use the exact common name, scientific name, or species code.`
			});
		}
		const code = match.code;

		const normalized = normalizeName(sourceName);
		await withTransaction(async (client) => {
			await client.query(
				`INSERT INTO species_match_overrides (source_name, species_code, note)
				 VALUES ($1, $2, 'set from /photos')
				 ON CONFLICT (source_name) DO UPDATE SET species_code = EXCLUDED.species_code`,
				[normalized, code]
			);
			// Apply to current unmatched photos with the same normalized source name.
			const candidates = await client.query<{ photo_id: string; source_species: string }>(
				`SELECT photo_id, source_species FROM photo_links WHERE species_code IS NULL`
			);
			for (const c of candidates.rows) {
				if (normalizeName(c.source_species) === normalized) {
					await client.query(
						`UPDATE photo_links SET species_code = $1, match_method = 'override' WHERE photo_id = $2`,
						[code, c.photo_id]
					);
				}
			}
		});

		return { ok: true as const, message: `Matched "${sourceName}" → ${code}.` };
	}
};

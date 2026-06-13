/**
 * gaylon.photos gallery link sync (link-out gallery — this app stores no
 * photos, only a cached index of CDN links). Source of truth:
 * GET https://gaylon.photos/api/photos?collection=birds (public).
 */
import { env } from '$env/dynamic/private';
import { query, withTransaction } from '$lib/db';
import { buildMatcher } from '$server/species-match';

const DEFAULT_API = 'https://gaylon.photos/api/photos?collection=birds';
const PHOTO_PAGE_BASE = 'https://gaylon.photos/birds/photo/';
export const GALLERY_STALE_HOURS = 48;

interface GalleryPhoto {
	id: string;
	url: string;
	thumbnail: string;
	species?: string | null;
	scientificName?: string | null;
	date?: string | null;
	gps?: { lat: number; lng: number } | null;
}

export interface GallerySyncResult {
	total: number;
	matched: number;
	unmatched: number;
}

export async function syncGallery(): Promise<GallerySyncResult> {
	const apiUrl = env.GALLERY_API_URL ?? DEFAULT_API;
	const res = await fetch(apiUrl, { headers: { Accept: 'application/json' } });
	if (!res.ok) {
		throw new Error(`gaylon.photos API returned ${res.status}`);
	}
	const body = (await res.json()) as { photos?: GalleryPhoto[] } | GalleryPhoto[];
	const photos = Array.isArray(body) ? body : (body.photos ?? []);
	if (photos.length === 0) {
		throw new Error('gaylon.photos returned no photos — refusing to wipe the local cache.');
	}

	const matcher = await buildMatcher();
	let matched = 0;

	await withTransaction(async (client) => {
		await client.query('DELETE FROM photo_links');
		for (const p of photos) {
			if (!p.id || !p.thumbnail || !p.url) continue;
			const m = matcher.taxonomySize > 0 ? matcher.match(p.species, p.scientificName) : null;
			if (m) matched++;
			const taken = p.date ? new Date(p.date) : null;
			await client.query(
				`INSERT INTO photo_links
				   (photo_id, species_code, source_species, source_sci_name, url, thumbnail,
				    page_url, taken_on, lat, lng, match_method, fetched_at)
				 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())`,
				[
					p.id,
					m?.code ?? null,
					p.species ?? '',
					p.scientificName ?? null,
					p.url,
					p.thumbnail,
					`${PHOTO_PAGE_BASE}${encodeURIComponent(p.id)}`,
					taken && !Number.isNaN(taken.getTime()) ? taken.toISOString().slice(0, 10) : null,
					p.gps?.lat ?? null,
					p.gps?.lng ?? null,
					m?.method ?? 'unmatched'
				]
			);
		}
	});

	return { total: photos.length, matched, unmatched: photos.length - matched };
}

/**
 * Re-run species matching over the existing photo_links rows without
 * refetching from gaylon.photos. Used after taxonomy syncs and new overrides.
 */
export async function rematchPhotoLinks(): Promise<{ matched: number; unmatched: number }> {
	const matcher = await buildMatcher();
	const rows = await query<{
		photo_id: string;
		source_species: string;
		source_sci_name: string | null;
	}>('SELECT photo_id, source_species, source_sci_name FROM photo_links');

	let matched = 0;
	await withTransaction(async (client) => {
		for (const r of rows.rows) {
			const m =
				matcher.taxonomySize > 0 ? matcher.match(r.source_species, r.source_sci_name) : null;
			if (m) matched++;
			await client.query(
				`UPDATE photo_links SET species_code = $2, match_method = $3 WHERE photo_id = $1`,
				[r.photo_id, m?.code ?? null, m?.method ?? 'unmatched']
			);
		}
	});
	return { matched, unmatched: rows.rows.length - matched };
}

export type GallerySourceState = 'ok' | 'stale' | 'not_configured' | 'error';

export async function galleryHealth(): Promise<GallerySourceState> {
	try {
		const r = await query<{ newest: string | null }>(
			'SELECT MAX(fetched_at)::text AS newest FROM photo_links'
		);
		const newest = r.rows[0]?.newest;
		if (!newest) return 'not_configured';
		const ageHours = (Date.now() - new Date(newest).getTime()) / 3_600_000;
		return ageHours <= GALLERY_STALE_HOURS ? 'ok' : 'stale';
	} catch {
		return 'error';
	}
}

/** Lazy refresh: re-sync when the cache is older than the TTL. Fails soft to stale cache. */
export async function refreshGalleryIfStale(): Promise<void> {
	const state = await galleryHealth();
	if (state === 'ok') return;
	try {
		await syncGallery();
	} catch {
		// keep serving stale cache; health endpoint reports the state
	}
}

export interface PhotoLink {
	photo_id: string;
	species_code: string | null;
	source_species: string;
	source_sci_name: string | null;
	url: string;
	thumbnail: string;
	page_url: string;
	taken_on: string | null;
	lat: number | null;
	lng: number | null;
	match_method: string;
	fetched_at: string;
	com_name: string | null; // joined from taxonomy_cache
}

export async function allPhotoLinks(): Promise<PhotoLink[]> {
	const r = await query<PhotoLink>(
		`SELECT pl.*, t.com_name
		   FROM photo_links pl
		   LEFT JOIN taxonomy_cache t ON t.species_code = pl.species_code
		  ORDER BY pl.species_code NULLS LAST, pl.taken_on DESC NULLS LAST`
	);
	return r.rows;
}

export async function photoCountsBySpecies(): Promise<Map<string, number>> {
	const r = await query<{ species_code: string; n: string }>(
		`SELECT species_code, COUNT(*) AS n FROM photo_links
		  WHERE species_code IS NOT NULL GROUP BY species_code`
	);
	return new Map(r.rows.map((row) => [row.species_code, Number(row.n)]));
}

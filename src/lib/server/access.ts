/**
 * Data-access scoping (multi-user). Centralizes "whose data does this request
 * read" so strict per-user isolation today can grow into family-sharing (#2)
 * by changing this one module, not the routes.
 */
import { query } from '$lib/db';
import { photoCountsBySpecies } from '$server/gallery';
import type { SessionUser } from '$server/session';

/**
 * The owner whose data this account reads: self for normal users (isolation),
 * or the linked owner for the transitional `family` viewer (`views_user_id`).
 */
export function scopeOwnerId(user: SessionUser): number {
	return user.views_user_id ?? user.id;
}

/**
 * The set of user_ids whose data this account may read. Today: just the scope
 * owner. #2 (family-sharing) expands this to self + owners who shared with the
 * user (a `shares` table), and list-reads will UNION over the set.
 */
export function readableUserIds(user: SessionUser): number[] {
	return [scopeOwnerId(user)];
}

/** The scope owner's configured photo-gallery source, or null. Gates gallery UI. */
export async function ownerGalleryUrl(ownerId: number): Promise<string | null> {
	const r = await query<{ gallery_url: string | null }>(
		'SELECT gallery_url FROM users WHERE id = $1',
		[ownerId]
	);
	return r.rows[0]?.gallery_url ?? null;
}

/**
 * Gallery state for a scope owner: whether they have a photo source, and the
 * per-species photo counts (empty when they don't, so non-gallery users never
 * see another owner's photo badges). The gallery is a single global collection;
 * gating here keeps it owner-scoped without per-user photo storage.
 */
export async function galleryContext(
	ownerId: number
): Promise<{ hasGallery: boolean; photoCounts: Map<string, number> }> {
	const hasGallery = (await ownerGalleryUrl(ownerId)) != null;
	return { hasGallery, photoCounts: hasGallery ? await photoCountsBySpecies() : new Map() };
}

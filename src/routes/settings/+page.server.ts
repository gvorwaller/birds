import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { query } from '$lib/db';
import { decryptSecret, encryptSecret } from '$server/crypto';
import { getEbirdApiKey, syncTaxonomy, taxonomyCount, EbirdError } from '$server/ebird';
import {
	importLifeList,
	parseLifeListCsv,
	syncLifeListFromEbird,
	testEbirdLogin,
	EbirdLoginError
} from '$server/ebird-account';
import { rematchPhotoLinks, syncGallery } from '$server/gallery';

export const load: PageServerLoad = async ({ locals }) => {
	const userId = locals.user!.id;

	const [ebird, user, taxCount, seenBySource, photoStats] = await Promise.all([
		query<{
			api_key_set: boolean;
			login_set: boolean;
			login_username_enc: string | null;
			life_list_synced_at: string | null;
			life_list_status: string | null;
			life_list_error: string | null;
		}>(
			`SELECT api_key_enc IS NOT NULL AS api_key_set,
			        (login_username_enc IS NOT NULL AND login_password_enc IS NOT NULL) AS login_set,
			        login_username_enc,
			        life_list_synced_at, life_list_status, life_list_error
			   FROM user_ebird WHERE user_id = $1`,
			[userId]
		),
		query<{ home_lat: number | null; home_lon: number | null; home_label: string | null }>(
			'SELECT home_lat, home_lon, home_label FROM users WHERE id = $1',
			[userId]
		),
		taxonomyCount(),
		query<{ source: string; n: string }>(
			'SELECT source, COUNT(*) AS n FROM seen_species WHERE user_id = $1 GROUP BY source',
			[userId]
		),
		query<{ total: string; matched: string }>(
			`SELECT COUNT(*) AS total, COUNT(species_code) AS matched FROM photo_links`
		)
	]);

	const row = ebird.rows[0];
	// The eBird username is an identifier (low-sensitivity) — show it so the
	// user can confirm which account is saved. The password is never returned.
	let loginUsername: string | null = null;
	if (row?.login_username_enc) {
		try {
			loginUsername = decryptSecret(row.login_username_enc);
		} catch {
			loginUsername = null;
		}
	}

	return {
		ebird: {
			api_key_set: row?.api_key_set ?? false,
			login_set: row?.login_set ?? false,
			login_username: loginUsername,
			life_list_synced_at: row?.life_list_synced_at ?? null,
			life_list_status: row?.life_list_status ?? null,
			life_list_error: row?.life_list_error ?? null
		},
		home: user.rows[0] ?? { home_lat: null, home_lon: null, home_label: null },
		taxonomyCount: taxCount,
		seenBySource: seenBySource.rows.map((r) => ({ source: r.source, n: Number(r.n) })),
		photoTotal: Number(photoStats.rows[0]?.total ?? 0),
		photoMatched: Number(photoStats.rows[0]?.matched ?? 0)
	};
};

async function ensureEbirdRow(userId: number): Promise<void> {
	await query(`INSERT INTO user_ebird (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [
		userId
	]);
}

export const actions: Actions = {
	save_api_key: async ({ locals, request }) => {
		const userId = locals.user!.id;
		const form = await request.formData();
		const key = (form.get('api_key') ?? '').toString().trim();
		if (!key) return fail(400, { error: 'Enter an eBird API key (ebird.org/api/keygen).' });
		await ensureEbirdRow(userId);
		await query(`UPDATE user_ebird SET api_key_enc = $2, updated_at = NOW() WHERE user_id = $1`, [
			userId,
			encryptSecret(key)
		]);
		return { ok: true as const, message: 'eBird API key saved (encrypted).' };
	},

	save_login: async ({ locals, request }) => {
		const userId = locals.user!.id;
		const form = await request.formData();
		const username = (form.get('ebird_username') ?? '').toString().trim();
		const password = (form.get('ebird_password') ?? '').toString();
		if (!username || !password) {
			return fail(400, { error: 'Enter both the eBird username and password.' });
		}
		await ensureEbirdRow(userId);
		await query(
			`UPDATE user_ebird SET login_username_enc = $2, login_password_enc = $3, updated_at = NOW()
			  WHERE user_id = $1`,
			[userId, encryptSecret(username), encryptSecret(password)]
		);
		return { ok: true as const, message: 'eBird account credentials saved (encrypted).' };
	},

	reveal_api_key: async ({ locals }) => {
		const userId = locals.user!.id;
		const key = await getEbirdApiKey(userId);
		if (!key) return fail(404, { error: 'No API key saved.' });
		return { ok: true as const, apiKey: key };
	},

	clear_api_key: async ({ locals }) => {
		const userId = locals.user!.id;
		await query('UPDATE user_ebird SET api_key_enc = NULL, updated_at = NOW() WHERE user_id = $1', [
			userId
		]);
		return { ok: true as const, message: 'eBird API key removed.' };
	},

	clear_login: async ({ locals }) => {
		const userId = locals.user!.id;
		await query(
			`UPDATE user_ebird SET login_username_enc = NULL, login_password_enc = NULL,
			        life_list_status = NULL, life_list_error = NULL, updated_at = NOW()
			  WHERE user_id = $1`,
			[userId]
		);
		return { ok: true as const, message: 'eBird account credentials removed.' };
	},

	test_login: async ({ locals }) => {
		const userId = locals.user!.id;
		try {
			await testEbirdLogin(userId);
			return { ok: true as const, message: 'eBird login works — credentials accepted.' };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return fail(502, { error: `eBird login test failed: ${msg}` });
		}
	},

	save_home: async ({ locals, request }) => {
		const userId = locals.user!.id;
		const form = await request.formData();
		const lat = Number(form.get('home_lat'));
		const lon = Number(form.get('home_lon'));
		const label = (form.get('home_label') ?? '').toString().trim() || null;
		if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
			return fail(400, { error: 'Pick a location on the map first.' });
		}
		await query('UPDATE users SET home_lat = $2, home_lon = $3, home_label = $4 WHERE id = $1', [
			userId,
			lat,
			lon,
			label
		]);
		return { ok: true as const, message: `Home location saved${label ? `: ${label}` : ''}.` };
	},

	sync_taxonomy: async ({ locals }) => {
		const userId = locals.user!.id;
		const apiKey = await getEbirdApiKey(userId);
		if (!apiKey) return fail(400, { error: 'Save your eBird API key first.' });
		try {
			const n = await syncTaxonomy(apiKey);
			const rematch = await rematchPhotoLinks();
			return {
				ok: true as const,
				message: `Taxonomy synced: ${n} taxa. Photos re-matched: ${rematch.matched} matched, ${rematch.unmatched} unmatched.`
			};
		} catch (err) {
			return fail(502, {
				error: err instanceof EbirdError ? err.message : `Taxonomy sync failed: ${err}`
			});
		}
	},

	sync_lifelist: async ({ locals }) => {
		const userId = locals.user!.id;
		try {
			const result = await syncLifeListFromEbird(userId);
			const unmatchedNote =
				result.unmatched.length > 0
					? ` ${result.unmatched.length} names didn't match the taxonomy (first few: ${result.unmatched.slice(0, 3).join(', ')}).`
					: '';
			return {
				ok: true as const,
				message: `Life list synced from eBird: ${result.matched} species.${unmatchedNote}`
			};
		} catch (err) {
			const msg =
				err instanceof EbirdLoginError || err instanceof Error ? err.message : String(err);
			return fail(502, {
				error: `Life-list sync failed (your last synced list is unchanged): ${msg}`
			});
		}
	},

	import_csv: async ({ locals, request }) => {
		const userId = locals.user!.id;
		const form = await request.formData();
		const file = form.get('csv');
		if (!(file instanceof File) || file.size === 0) {
			return fail(400, { error: 'Choose a CSV file exported from eBird.' });
		}
		try {
			const parsed = parseLifeListCsv(await file.text());
			const result = await importLifeList(userId, parsed, 'csv_import');
			return {
				ok: true as const,
				message: `CSV imported: ${result.matched} species (${result.unmatched.length} unmatched names).`
			};
		} catch (err) {
			return fail(400, { error: `CSV import failed: ${err instanceof Error ? err.message : err}` });
		}
	},

	sync_gallery: async () => {
		try {
			const result = await syncGallery();
			return {
				ok: true as const,
				message: `Gallery synced: ${result.total} photos, ${result.matched} matched, ${result.unmatched} unmatched.`
			};
		} catch (err) {
			return fail(502, { error: `Gallery sync failed: ${err instanceof Error ? err.message : err}` });
		}
	}
};

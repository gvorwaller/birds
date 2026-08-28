import { describe, expect, it } from 'vitest';
import { query } from '$lib/db';
import {
	inatDueCodes,
	inatFresh,
	upsertInatSimilar,
	markInatNoMapping,
	markInatError
} from './species-enrichment';

// DB-backed cases run only when the test cluster is up (jobs-db pattern).
const dbUp = await query('SELECT 1')
	.then(() => true)
	.catch(() => false);

// The restored prod-scale cluster makes the scope UNION cost ~2.4s per call
// (td-c41126), so every test calling inatDueCodes gets an explicit budget.
const T = 60_000;

const FOCAL = 'zzitst1';
const PARTNER = 'zzitst2';
const CODES = [FOCAL, PARTNER];

async function seed() {
	for (const [code, sci] of [
		[FOCAL, 'Testus focalis'],
		[PARTNER, 'Testus partneris']
	] as const) {
		await query(
			`INSERT INTO taxonomy_cache (species_code, com_name, sci_name, category, family)
			 VALUES ($1, 'INat Test Bird', $2, 'species', 'Testidae')
			 ON CONFLICT (species_code) DO UPDATE SET sci_name = $2, category = 'species'`,
			[code, sci]
		);
	}
	const uid = (await query<{ id: number }>(`SELECT id FROM users ORDER BY id LIMIT 1`)).rows[0].id;
	for (const code of CODES) {
		await query(
			`INSERT INTO seen_species (user_id, species_code, source)
			 VALUES ($1, $2, 'manual') ON CONFLICT DO NOTHING`,
			[uid, code]
		);
		await query(
			`INSERT INTO species_enrichment (species_code) VALUES ($1)
			 ON CONFLICT (species_code) DO NOTHING`,
			[code]
		);
	}
}

async function cleanup() {
	await query(`DELETE FROM species_inat_similar WHERE species_code = ANY($1)`, [CODES]);
	await query(`DELETE FROM species_enrichment WHERE species_code = ANY($1)`, [CODES]);
	await query(`DELETE FROM seen_species WHERE species_code = ANY($1)`, [CODES]);
	await query(`DELETE FROM taxonomy_cache WHERE species_code = ANY($1)`, [CODES]);
}

async function enrichmentRow(code: string) {
	const r = await query<{
		inat_similar_status: string | null;
		inat_taxon_id: string | null;
		inat_taxon_source: string | null;
		inat_sci_name: string | null;
		similar_candidates_hash: string | null;
		inat_similar_fetched_at: Date | null;
	}>(
		`SELECT inat_similar_status, inat_taxon_id, inat_taxon_source, inat_sci_name,
		        similar_candidates_hash, inat_similar_fetched_at
		   FROM species_enrichment WHERE species_code = $1`,
		[code]
	);
	return r.rows[0];
}

const EDGE_A = { taxonId: 777, misidCount: 40, sciName: 'Testus partneris', comName: 'Partner' };
const EDGE_B = { taxonId: 888, misidCount: 10, sciName: 'Testus tertius', comName: null };

describe.runIf(dbUp)('iNat sourcing writers + due scanner (td-460b1c Phase A)', () => {
	it(
		'upsertInatSimilar stores ranked edges, stamps ok, and preserves declined_at across refetches',
		{ timeout: T },
		async () => {
			await seed();
			try {
				await upsertInatSimilar(FOCAL, { taxonId: 4368, source: 'cross', sciName: 'Testus focalis' }, [
					EDGE_A,
					EDGE_B
				]);
				const edges = await query<{ inat_taxon_id: string; rank: number; misid_count: number }>(
					`SELECT inat_taxon_id, rank, misid_count FROM species_inat_similar
					  WHERE species_code = $1 ORDER BY rank`,
					[FOCAL]
				);
				expect(edges.rows.map((e) => [Number(e.inat_taxon_id), e.rank])).toEqual([
					[777, 1],
					[888, 2]
				]);
				const row = await enrichmentRow(FOCAL);
				expect(row.inat_similar_status).toBe('ok');
				expect(Number(row.inat_taxon_id)).toBe(4368);
				expect(row.inat_taxon_source).toBe('cross');
				expect(row.inat_sci_name).toBe('Testus focalis');

				// Terminal per-pair decline survives a refetch (self-review R2).
				await query(
					`UPDATE species_inat_similar SET declined_at = NOW()
					  WHERE species_code = $1 AND inat_taxon_id = 777`,
					[FOCAL]
				);
				await upsertInatSimilar(
					FOCAL,
					{ taxonId: 4368, source: 'cross', sciName: 'Testus focalis' },
					[{ ...EDGE_A, misidCount: 55 }] // EDGE_B dropped by provider this time
				);
				const after = await query<{
					inat_taxon_id: string;
					misid_count: number;
					declined_at: Date | null;
				}>(
					`SELECT inat_taxon_id, misid_count, declined_at FROM species_inat_similar
					  WHERE species_code = $1`,
					[FOCAL]
				);
				expect(after.rows).toHaveLength(1); // 888 pruned
				expect(after.rows[0].misid_count).toBe(55); // counts refreshed
				expect(after.rows[0].declined_at).not.toBeNull(); // decline preserved
			} finally {
				await cleanup();
			}
		}
	);

	it(
		'edge diff stamps partners stale on ADD and on DROP; no_mapping deletes edges and stamps too',
		{ timeout: T },
		async () => {
			await seed();
			try {
				// Partner resolvable via BOTH arms: cross_ids id 777 and its sci name.
				await query(
					`UPDATE species_enrichment
					    SET cross_ids = jsonb_build_object('inat_taxon_id', '777'),
					        similar_candidates_hash = 'h-add'
					  WHERE species_code = $1`,
					[PARTNER]
				);
				await upsertInatSimilar(FOCAL, { taxonId: 4368, source: 'search', sciName: null }, [EDGE_A]);
				expect((await enrichmentRow(PARTNER)).similar_candidates_hash).toBeNull(); // ADD stamped

				await query(
					`UPDATE species_enrichment SET similar_candidates_hash = 'h-drop'
					  WHERE species_code = $1`,
					[PARTNER]
				);
				await upsertInatSimilar(FOCAL, { taxonId: 4368, source: 'search', sciName: null }, [EDGE_B]);
				expect((await enrichmentRow(PARTNER)).similar_candidates_hash).toBeNull(); // DROP stamped

				// no_mapping: edges deleted, their partners stamped, mapping cleared.
				await query(
					`UPDATE species_enrichment SET similar_candidates_hash = 'h-nomap'
					  WHERE species_code = $1`,
					[PARTNER]
				);
				await upsertInatSimilar(FOCAL, { taxonId: 4368, source: 'search', sciName: null }, [EDGE_A]);
				await query(
					`UPDATE species_enrichment SET similar_candidates_hash = 'h-nomap2'
					  WHERE species_code = $1`,
					[PARTNER]
				);
				await markInatNoMapping(FOCAL);
				const edges = await query(
					`SELECT 1 FROM species_inat_similar WHERE species_code = $1`,
					[FOCAL]
				);
				expect(edges.rows).toHaveLength(0);
				const focal = await enrichmentRow(FOCAL);
				expect(focal.inat_similar_status).toBe('no_mapping');
				expect(focal.inat_taxon_id).toBeNull();
				expect(focal.inat_taxon_source).toBeNull();
				expect((await enrichmentRow(PARTNER)).similar_candidates_hash).toBeNull();
			} finally {
				await cleanup();
			}
		}
	);

	it(
		'markInatError preserves edges (last-good) and does not advance fetched_at',
		{ timeout: T },
		async () => {
			await seed();
			try {
				await upsertInatSimilar(FOCAL, { taxonId: 4368, source: 'cross', sciName: null }, [EDGE_A]);
				const fetchedAt = (await enrichmentRow(FOCAL)).inat_similar_fetched_at;
				await markInatError(FOCAL, 'iNaturalist unreachable: boom');
				const row = await enrichmentRow(FOCAL);
				expect(row.inat_similar_status).toBe('error');
				expect(row.inat_similar_fetched_at?.getTime()).toBe(fetchedAt?.getTime());
				const edges = await query(
					`SELECT 1 FROM species_inat_similar WHERE species_code = $1`,
					[FOCAL]
				);
				expect(edges.rows).toHaveLength(1);
			} finally {
				await cleanup();
			}
		}
	);

	it(
		'inatDueCodes lifecycle: null due; error backs off 7d (even with cross_ids present — R3); ok honors mapping-mismatch and P3151-removal clauses',
		{ timeout: T },
		async () => {
			await seed();
			try {
				// Never attempted → due.
				expect(await inatDueCodes()).toContain(FOCAL);
				expect(await inatFresh(FOCAL)).toBe(false);

				// Fresh 'ok' → not due. (cross_ids must agree with the stored
				// 'cross'-sourced id — that's the only state the worker can write.)
				await query(
					`UPDATE species_enrichment
					    SET cross_ids = jsonb_build_object('inat_taxon_id', '4368')
					  WHERE species_code = $1`,
					[FOCAL]
				);
				await upsertInatSimilar(FOCAL, { taxonId: 4368, source: 'cross', sciName: null }, [EDGE_A]);
				expect(await inatDueCodes()).not.toContain(FOCAL);
				expect(await inatFresh(FOCAL)).toBe(true);

				// R3: an ERROR row whose cross_ids carries an id must NOT bypass
				// the 7-day backoff (inat_taxon_id stays set here, but the clause
				// must not fire on 'error' regardless).
				await query(
					`UPDATE species_enrichment
					    SET cross_ids = jsonb_build_object('inat_taxon_id', '4368')
					  WHERE species_code = $1`,
					[FOCAL]
				);
				await markInatError(FOCAL, 'transient');
				await query(
					`UPDATE species_enrichment SET inat_taxon_id = NULL WHERE species_code = $1`,
					[FOCAL]
				);
				expect(await inatDueCodes()).not.toContain(FOCAL);
				expect(await inatFresh(FOCAL)).toBe(true);
				// …and past the window it retries.
				await query(
					`UPDATE species_enrichment
					    SET inat_similar_attempted_at = NOW() - INTERVAL '8 days'
					  WHERE species_code = $1`,
					[FOCAL]
				);
				expect(await inatDueCodes()).toContain(FOCAL);

				// G6: an 'ok' row whose cross_ids id DIFFERS from the stored one is
				// due immediately, at any freshness.
				await upsertInatSimilar(FOCAL, { taxonId: 4368, source: 'cross', sciName: null }, [EDGE_A]);
				await query(
					`UPDATE species_enrichment
					    SET cross_ids = jsonb_build_object('inat_taxon_id', '9999')
					  WHERE species_code = $1`,
					[FOCAL]
				);
				expect(await inatDueCodes()).toContain(FOCAL);
				expect(await inatFresh(FOCAL)).toBe(false);

				// R3 removal: cross_ids loses the key under a 'cross'-sourced
				// mapping → due once; a 'search' re-resolution self-clears it.
				await query(
					`UPDATE species_enrichment
					    SET cross_ids = '{}'::jsonb, inat_taxon_id = 4368, inat_taxon_source = 'cross',
					        inat_similar_status = 'ok', inat_similar_fetched_at = NOW()
					  WHERE species_code = $1`,
					[FOCAL]
				);
				expect(await inatDueCodes()).toContain(FOCAL);
				await upsertInatSimilar(FOCAL, { taxonId: 4368, source: 'search', sciName: null }, [EDGE_A]);
				expect(await inatDueCodes()).not.toContain(FOCAL);
			} finally {
				await cleanup();
			}
		}
	);
});

import { describe, expect, it } from 'vitest';
import { query } from '$lib/db';
import {
	inatDueCodes,
	inatFresh,
	upsertInatSimilar,
	markInatNoMapping,
	markInatError,
	selectInatCandidates,
	similarCandidatesFor,
	similarCandidatesHash,
	markSimilarDeclined,
	upsertResolution,
	type ResolvedEdgeInput
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
	await query(`DELETE FROM species_similar_display WHERE species_code = ANY($1)`, [CODES]);
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
	it('Wikidata no_mapping clears a removed P3151 and invalidates affected partners', { timeout: T }, async () => {
		await seed();
		try {
			await query(
				`UPDATE species_enrichment SET cross_ids = jsonb_build_object('inat_taxon_id', '4368'),
				        inat_sci_name = 'Testus focalis' WHERE species_code = $1`, [FOCAL]);
			await query(
				`INSERT INTO species_inat_similar
				   (species_code, inat_taxon_id, rank, misid_count, inat_sci_name)
				 VALUES ($1, 4368, 1, 20, 'Testus focalis')`, [PARTNER]);
			await query(`UPDATE species_enrichment SET similar_candidates_hash = 'stable' WHERE species_code = $1`, [PARTNER]);
			await upsertResolution(FOCAL, null);
			const focal = await query<{ cross_ids: Record<string, string>; resolution: string }>(
				`SELECT cross_ids, resolution FROM species_enrichment WHERE species_code = $1`, [FOCAL]);
			expect(focal.rows[0]).toEqual({ cross_ids: {}, resolution: 'no_mapping' });
			expect((await enrichmentRow(PARTNER)).similar_candidates_hash).toBeNull();
		} finally { await cleanup(); }
	});

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
				await query(`UPDATE species_enrichment SET similar_candidates_hash = 'h-count' WHERE species_code = $1`, [PARTNER]);
				await upsertInatSimilar(FOCAL, { taxonId: 4368, source: 'search', sciName: null }, [
					{ ...EDGE_A, misidCount: 41 }
				]);
				expect((await enrichmentRow(PARTNER)).similar_candidates_hash).toBeNull();

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
					`INSERT INTO species_similar_display
					   (species_code, position, resolved_code, inat_taxon_id, inat_sci_name, origin, unresolved)
					 VALUES ($1, 1, $2, 777, 'Testus partneris', 'forward', FALSE)`,
					[FOCAL, PARTNER]
				);
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
				const display = await query(`SELECT 1 FROM species_similar_display WHERE species_code = $1`, [FOCAL]);
				expect(display.rows).toHaveLength(0);
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


// ---------------------------------------------------------------------------
// selectInatCandidates — pure selection rules (Phase B)
// ---------------------------------------------------------------------------

function edge(over: Partial<ResolvedEdgeInput> & { id: string; count: number }): ResolvedEdgeInput {
	return {
		inatTaxonId: over.id,
		misidCount: over.count,
		inatSciName: over.inatSciName ?? `Testus sp${over.id}`,
		inatComName: over.inatComName ?? null,
		declined: over.declined ?? false,
		resolution:
			over.resolution !== undefined
				? over.resolution
				: {
						speciesCode: `sp${over.id}`,
						comName: `Species ${over.id}`,
						sciName: over.inatSciName ?? `Testus sp${over.id}`,
						family: 'Testidae',
						inScope: true
					}
	};
}

describe('selectInatCandidates — floors, families, scope (GROK G1/G7, AGY A4, R8)', () => {
	it('weak data (leader < 3): same-family only, leader still emits, seats cap at 3', () => {
		const sel = selectInatCandidates(
			[
				edge({ id: '1', count: 1 }),
				edge({ id: '2', count: 1 }),
				edge({ id: '3', count: 1 }),
				edge({ id: '4', count: 1 }),
				edge({
					id: '5',
					count: 2,
					resolution: {
						speciesCode: 'spX',
						comName: 'Cross Family',
						sciName: 'Alius alius',
						family: 'Aliidae',
						inScope: true
					}
				})
			],
			'Testidae'
		);
		// Leader=2 < 3: cross-family spX excluded despite being the leader row's
		// count; same-family rows pass but at most 3 seats.
		expect(sel.selected.length).toBe(3);
		expect(sel.selected.every((s) => s.speciesCode.startsWith('sp'))).toBe(true);
		expect(sel.selected.map((s) => s.speciesCode)).not.toContain('spX');
	});

	it('leader=1 still emits the leader (Eskimo Curlew case) — never an empty fake-none', () => {
		const sel = selectInatCandidates([edge({ id: '9', count: 1 })], 'Testidae');
		expect(sel.selected.map((s) => s.speciesCode)).toEqual(['sp9']);
	});

	it('Downy-shaped distribution keeps its mid-tier (no 5% relative floor)', () => {
		const sel = selectInatCandidates(
			[
				edge({ id: '1', count: 4693 }),
				edge({ id: '2', count: 312 }),
				edge({ id: '3', count: 233 }),
				edge({ id: '4', count: 171 }),
				edge({ id: '5', count: 70 })
			],
			'Testidae'
		);
		expect(sel.selected.length).toBe(5);
	});

	it('cross-family pairs need max(20, 10% of leader); same-family passes the base floor', () => {
		const cross = (id: string, count: number) =>
			edge({
				id,
				count,
				resolution: {
					speciesCode: `x${id}`,
					comName: `Cross ${id}`,
					sciName: `Alius a${id}`,
					family: 'Aliidae',
					inScope: true
				}
			});
		const sel = selectInatCandidates(
			[
				edge({ id: '1', count: 600 }), // same-family leader
				cross('2', 55), // eagle→goose shape: 55 < max(20, 60) → dropped
				cross('3', 80), // ≥ 60 and ≥ 20 → kept
				edge({ id: '4', count: 4 }) // same-family small → kept (floor 3)
			],
			'Testidae'
		);
		const codes = sel.selected.map((s) => s.speciesCode);
		expect(codes).toContain('x3');
		expect(codes).not.toContain('x2');
		expect(codes).toContain('sp4');
	});

	it('out-of-scope resolved rows are DROPPED (not unresolved); unmappable/ambiguous surface as unresolved', () => {
		const sel = selectInatCandidates(
			[
				edge({ id: '1', count: 50 }),
				edge({
					id: '2',
					count: 40,
					resolution: {
						speciesCode: 'spFar',
						comName: 'Faraway',
						sciName: 'Testus peregrinus',
						family: 'Testidae',
						inScope: false
					}
				}),
				edge({ id: '3', count: 30, resolution: null, inatSciName: 'Ignotus ignotus' }),
				edge({ id: '4', count: 20, resolution: 'ambiguous', inatSciName: 'Dubius dubius' })
			],
			'Testidae'
		);
		expect(sel.selected.map((s) => s.speciesCode)).toEqual(['sp1']);
		expect(sel.unresolved.map((u) => u.inat_sci_name)).toEqual(['Ignotus ignotus', 'Dubius dubius']);
	});

	it('declined edges are excluded from selection entirely (self-review R2)', () => {
		const sel = selectInatCandidates(
			[edge({ id: '1', count: 50, declined: true }), edge({ id: '2', count: 10 })],
			'Testidae'
		);
		expect(sel.selected.map((s) => s.speciesCode)).toEqual(['sp2']);
	});

	it('dedupes two iNat taxa resolving to the same eBird code, keeping the higher count', () => {
		const shared = {
			speciesCode: 'spdup',
			comName: 'Dup',
			sciName: 'Testus dup',
			family: 'Testidae',
			inScope: true
		};
		const sel = selectInatCandidates(
			[
				edge({ id: '1', count: 30, resolution: shared }),
				edge({ id: '2', count: 50, resolution: shared })
			],
			'Testidae'
		);
		expect(sel.selected).toHaveLength(1);
		expect(sel.selected[0].misidCount).toBe(50);
	});
});

// ---------------------------------------------------------------------------
// similarCandidatesFor — reconcile end-to-end on the test cluster
// ---------------------------------------------------------------------------

describe.runIf(dbUp)('similarCandidatesFor — reconcile persists display + reverse support', () => {
	const F = 'zzrec1';
	const P = 'zzrec2';
	const RCODES = [F, P];

	async function seedPair() {
		for (const [code, sci, inatId] of [
			[F, 'Testus recfocal', 9101],
			[P, 'Testus recpartner', 9102]
		] as const) {
			await query(
				`INSERT INTO taxonomy_cache (species_code, com_name, sci_name, category, family)
				 VALUES ($1, 'Rec Test Bird', $2, 'species', 'Testidae')
				 ON CONFLICT (species_code) DO UPDATE SET sci_name = $2, category = 'species'`,
				[code, sci]
			);
			const uid = (await query<{ id: number }>(`SELECT id FROM users ORDER BY id LIMIT 1`))
				.rows[0].id;
			await query(
				`INSERT INTO seen_species (user_id, species_code, source)
				 VALUES ($1, $2, 'manual') ON CONFLICT DO NOTHING`,
				[uid, code]
			);
			await query(
				`INSERT INTO species_enrichment (species_code, inat_taxon_id, inat_similar_status,
				    inat_similar_fetched_at, inat_similar_attempted_at)
				 VALUES ($1, $2, 'ok', NOW(), NOW())
				 ON CONFLICT (species_code) DO UPDATE SET
				   inat_taxon_id = $2, inat_similar_status = 'ok',
				   inat_similar_fetched_at = NOW(), inat_similar_attempted_at = NOW()`,
				[code, inatId]
			);
		}
	}
	async function cleanPair() {
		await query(`DELETE FROM species_similar_display WHERE species_code = ANY($1)`, [RCODES]);
		await query(`DELETE FROM species_inat_similar WHERE species_code = ANY($1)`, [RCODES]);
		await query(`DELETE FROM species_enrichment WHERE species_code = ANY($1)`, [RCODES]);
		await query(`DELETE FROM seen_species WHERE species_code = ANY($1)`, [RCODES]);
		await query(`DELETE FROM taxonomy_cache WHERE species_code = ANY($1)`, [RCODES]);
	}

	it(
		'reverse-current-source union: P selects F, so F offers P as a reverse extra; display persists',
		{ timeout: 60_000 },
		async () => {
			await seedPair();
			try {
				// P's raw edges point at F (resolvable via sci name). F has NO
				// forward edges at all.
				await query(
					`INSERT INTO species_inat_similar
					   (species_code, inat_taxon_id, rank, misid_count, inat_sci_name, inat_com_name)
					 VALUES ($1, 9101, 1, 25, 'Testus recfocal', 'Rec Test Bird'),
					        ($1, 9991, 2, 10, 'Testus recfocal', 'Rec Test Bird')
					 ON CONFLICT DO NOTHING`,
					[P]
				);
				const offered = await similarCandidatesFor(F);
				expect(offered.map((c) => c.code)).toEqual([P]);
				expect(offered[0].misidCount).toBeNull(); // reverse extra
				const disp = await query<{ resolved_code: string; origin: string; inat_taxon_id: string }>(
					`SELECT resolved_code, origin, inat_taxon_id::text FROM species_similar_display
					  WHERE species_code = $1 ORDER BY position`,
					[F]
				);
				expect(disp.rows).toEqual([{ resolved_code: P, origin: 'reverse', inat_taxon_id: '9101' }]);
				const state = await query<{ similar_candidates_hash: string | null; similar_status: string | null }>(
					`SELECT similar_candidates_hash, similar_status FROM species_enrichment WHERE species_code = $1`, [F]);
				expect(state.rows[0]).toEqual({ similar_candidates_hash: similarCandidatesHash([P]), similar_status: null });

				// Second call with unchanged data returns the same offered set
				// (fingerprint short-circuit needs a stored hash — simulate the
				// AI stage having written it).
				await query(
					`UPDATE species_enrichment SET similar_status = 'ok'
					  WHERE species_code = $1`,
					[F]
				);
				const again = await similarCandidatesFor(F);
				expect(again.map((c) => c.code)).toEqual([P]);
				await query(`UPDATE species_enrichment SET similar_candidates_hash = 'partner-ok' WHERE species_code = $1`, [P]);
				await markSimilarDeclined(F, [P]);
				const declined = await query<{ count: string }>(
					`SELECT COUNT(*)::text AS count FROM species_inat_similar
					  WHERE species_code = $1 AND declined_at IS NOT NULL`, [P]);
				expect(Number(declined.rows[0]?.count)).toBe(2);
				expect((await enrichmentRow(P)).similar_candidates_hash).toBeNull();
				expect(await similarCandidatesFor(F)).toEqual([]);
				const afterDecline = await query(`SELECT 1 FROM species_similar_display WHERE species_code = $1`, [F]);
				expect(afterDecline.rows).toHaveLength(0);
			} finally {
				await cleanPair();
			}
		}
	);
});


describe.runIf(dbUp)('reverse-support cap (Gaylon 2026-08-28: hub species bounded at MAX_SIMILAR)', () => {
	const HUB = 'zzhub1';
	const SATS = Array.from({ length: 9 }, (_, i) => `zzsat${i + 1}`);
	const HCODES = [HUB, ...SATS];

	async function seedHub() {
		const uid = (await query<{ id: number }>(`SELECT id FROM users ORDER BY id LIMIT 1`)).rows[0]
			.id;
		for (let i = 0; i < HCODES.length; i++) {
			const code = HCODES[i];
			await query(
				`INSERT INTO taxonomy_cache (species_code, com_name, sci_name, category, family)
				 VALUES ($1, 'Hub Test Bird', $2, 'species', 'Testidae')
				 ON CONFLICT (species_code) DO UPDATE SET sci_name = $2, category = 'species'`,
				[code, `Testus hub${i}`]
			);
			await query(
				`INSERT INTO seen_species (user_id, species_code, source)
				 VALUES ($1, $2, 'manual') ON CONFLICT DO NOTHING`,
				[uid, code]
			);
			await query(
				`INSERT INTO species_enrichment (species_code, inat_taxon_id, inat_similar_status,
				    inat_similar_fetched_at, inat_similar_attempted_at)
				 VALUES ($1, $2, 'ok', NOW(), NOW())
				 ON CONFLICT (species_code) DO UPDATE SET
				   inat_taxon_id = $2, inat_similar_status = 'ok',
				   inat_similar_fetched_at = NOW(), inat_similar_attempted_at = NOW()`,
				[code, 9200 + i]
			);
		}
		// Every satellite's raw edges select the hub (count = 10 + i so the cap
		// keeps the HIGHEST-count partners). The hub has no forward edges.
		for (let i = 0; i < SATS.length; i++) {
			await query(
				`INSERT INTO species_inat_similar
				   (species_code, inat_taxon_id, rank, misid_count, inat_sci_name, inat_com_name)
				 VALUES ($1, 9200, 1, $2, 'Testus hub0', 'Hub Test Bird')
				 ON CONFLICT DO NOTHING`,
				[SATS[i], 10 + i]
			);
		}
	}
	async function cleanHub() {
		await query(`DELETE FROM species_similar_display WHERE species_code = ANY($1)`, [HCODES]);
		await query(`DELETE FROM species_inat_similar WHERE species_code = ANY($1)`, [HCODES]);
		await query(`DELETE FROM species_enrichment WHERE species_code = ANY($1)`, [HCODES]);
		await query(`DELETE FROM seen_species WHERE species_code = ANY($1)`, [HCODES]);
		await query(`DELETE FROM taxonomy_cache WHERE species_code = ANY($1)`, [HCODES]);
	}

	it(
		'nine reverse supporters collapse to the seven strongest pairs',
		{ timeout: 60_000 },
		async () => {
			await seedHub();
			try {
				const offered = await similarCandidatesFor(HUB);
				expect(offered).toHaveLength(7);
				// Counts were 10..18; the cap drops the two weakest (zzsat1/zzsat2).
				const codes = offered.map((c) => c.code);
				expect(codes).not.toContain('zzsat1');
				expect(codes).not.toContain('zzsat2');
				expect(codes).toContain('zzsat9');
				// Display set matches the offered set exactly (hash coherence).
				const disp = await query<{ c: string }>(
					`SELECT count(*) AS c FROM species_similar_display
					  WHERE species_code = $1 AND resolved_code IS NOT NULL`,
					[HUB]
				);
				expect(Number(disp.rows[0].c)).toBe(7);
			} finally {
				await cleanHub();
			}
		}
	);
});

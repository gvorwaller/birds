import { describe, expect, it } from 'vitest';
import {
	fetchInatSimilarSpecies,
	fetchInatTaxonName,
	searchInatTaxonBySciName,
	normalizeSimilarResults,
	InatError,
	INAT_MAX_STORED,
	type InatSimilarRaw
} from './inaturalist';
import { isRateLimitedError } from './wikidata';

/**
 * Real captured envelope shape (GBBG, 2026-08-28) trimmed to two results —
 * the regression for "extra keys are ignored" (self-review/G9: the live taxon
 * object carries ~25 keys beyond the required four).
 */
const REAL_ENVELOPE = {
	total_results: 24,
	page: 1,
	per_page: 100,
	results: [
		{
			count: 757,
			taxon: {
				id: 4381,
				name: 'Larus fuscus',
				rank: 'species',
				rank_level: 10,
				preferred_common_name: 'Lesser Black-backed Gull',
				min_species_taxon_id: 4381,
				min_species_ancestry: '48460/1/2/355675/67561/71261/67562/4342/4344/4345/4381',
				parent_id: 4345,
				ancestor_ids: [48460, 1, 2],
				iconic_taxon_name: 'Aves',
				default_photo: { id: 1, url: 'https://example.invalid/p.jpg' },
				observations_count: 123456,
				is_active: true,
				extinct: false,
				flag_counts: { resolved: 0, unresolved: 0 }
			}
		},
		{
			count: 403,
			taxon: {
				id: 144297,
				name: 'Larus smithsonianus',
				rank: 'species',
				min_species_taxon_id: 144297,
				preferred_common_name: 'American Herring Gull'
			}
		}
	]
};

function fakeFetcher(
	handler: (url: string) => { status?: number; body?: unknown; headers?: Record<string, string> }
): { fetcher: typeof fetch; calls: string[] } {
	const calls: string[] = [];
	const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push(url);
		// The shared UA must ride every request (iNat terms want a contact).
		const ua = new Headers(init?.headers).get('User-Agent') ?? '';
		if (!ua.includes('enrichment')) throw new Error(`missing enrichment UA, got "${ua}"`);
		const r = handler(url);
		return new Response(JSON.stringify(r.body ?? {}), {
			status: r.status ?? 200,
			headers: r.headers
		});
	}) as typeof fetch;
	return { fetcher, calls };
}

describe('fetchInatSimilarSpecies', () => {
	it('parses the real envelope, ignoring the dozens of extra taxon keys', async () => {
		const { fetcher } = fakeFetcher(() => ({ body: REAL_ENVELOPE }));
		const rows = await fetchInatSimilarSpecies(4368, { fetcher });
		expect(rows).toHaveLength(2);
		expect(rows[0]).toEqual({
			taxonId: 4381,
			misidCount: 757,
			sciName: 'Larus fuscus',
			comName: 'Lesser Black-backed Gull',
			rank: 'species',
			minSpeciesTaxonId: 4381
		});
		// Absent optional fields degrade to null, never throw.
		expect(rows[1].minSpeciesTaxonId).toBe(144297);
	});

	it('rejects a 200 body without a results array (provider-shape error)', async () => {
		const { fetcher } = fakeFetcher(() => ({ body: { message: 'nope' } }));
		await expect(fetchInatSimilarSpecies(4368, { fetcher })).rejects.toThrow(/malformed/);
	});

	it('rejects a result missing required fields', async () => {
		const { fetcher } = fakeFetcher(() => ({
			body: { results: [{ count: 'many', taxon: { id: 1, name: 'X y', rank: 'species' } }] }
		}));
		await expect(fetchInatSimilarSpecies(4368, { fetcher })).rejects.toThrow(/count/);
	});

	it('429 surfaces as a structural rate-limit error with Retry-After honored', async () => {
		const { fetcher } = fakeFetcher(() => ({ status: 429, headers: { 'retry-after': '120' } }));
		const err = await fetchInatSimilarSpecies(4368, { fetcher }).catch((e) => e);
		expect(err).toBeInstanceOf(InatError);
		expect(isRateLimitedError(err)).toBe(true);
		expect(err.retryAfterMs).toBe(120_000);
	});

	it('rejects a non-positive taxon id before any network call', async () => {
		const { fetcher, calls } = fakeFetcher(() => ({ body: REAL_ENVELOPE }));
		await expect(fetchInatSimilarSpecies(0, { fetcher })).rejects.toThrow(/invalid/);
		expect(calls).toHaveLength(0);
	});
});

describe('searchInatTaxonBySciName', () => {
	it('accepts only a case-insensitive exact canonical-name match', async () => {
		const { fetcher } = fakeFetcher(() => ({
			body: {
				results: [
					{ id: 99, name: 'Larus fuscus fuscus' }, // synonym-y near miss first
					{ id: 4381, name: 'Larus Fuscus' } // case difference is fine
				]
			}
		}));
		const hit = await searchInatTaxonBySciName('Larus fuscus', { fetcher });
		expect(hit).toEqual({ taxonId: 4381, sciName: 'Larus Fuscus' });
	});

	it('returns null when nothing matches exactly (synonym hits are not proof)', async () => {
		const { fetcher } = fakeFetcher(() => ({
			body: { results: [{ id: 7, name: 'Larus argentatus' }] }
		}));
		expect(await searchInatTaxonBySciName('Larus fuscus', { fetcher })).toBeNull();
	});
});

describe('fetchInatTaxonName', () => {
	it('returns the canonical name for an id', async () => {
		const { fetcher } = fakeFetcher(() => ({
			body: { results: [{ id: 4368, name: 'Larus marinus', rank: 'species' }] }
		}));
		expect(await fetchInatTaxonName(4368, { fetcher })).toEqual({ sciName: 'Larus marinus' });
	});
});

function raw(over: Partial<InatSimilarRaw>): InatSimilarRaw {
	return {
		taxonId: 1,
		misidCount: 1,
		sciName: 'Genus species',
		comName: null,
		rank: 'species',
		minSpeciesTaxonId: null,
		...over
	};
}

describe('normalizeSimilarResults', () => {
	const FOCAL = { taxonId: 4368, sciName: 'Larus marinus' };

	it('keeps species rows, drops hybrids and other ranks', () => {
		const rows = normalizeSimilarResults(FOCAL, [
			raw({ taxonId: 4381, sciName: 'Larus fuscus', misidCount: 10 }),
			raw({ taxonId: 555, sciName: 'Larus fuscus × Larus argentatus', rank: 'hybrid', misidCount: 99 }),
			raw({ taxonId: 556, sciName: 'Larus', rank: 'genus', misidCount: 99 })
		]);
		expect(rows.map((r) => r.sciName)).toEqual(['Larus fuscus']);
	});

	it('collapses infraspecific rows to the binomial, SUMMING counts, keyed by min_species_taxon_id', () => {
		const rows = normalizeSimilarResults(FOCAL, [
			raw({
				taxonId: 900001,
				sciName: 'Larus fuscus graellsii',
				rank: 'subspecies',
				misidCount: 5,
				minSpeciesTaxonId: 4381
			}),
			raw({
				taxonId: 900002,
				sciName: 'Larus fuscus intermedius',
				rank: 'subspecies',
				misidCount: 3,
				minSpeciesTaxonId: 4381
			}),
			raw({ taxonId: 4381, sciName: 'Larus fuscus', misidCount: 10, minSpeciesTaxonId: 4381 })
		]);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ taxonId: 4381, sciName: 'Larus fuscus', misidCount: 18 });
	});

	it('excludes the focal by id, min-species id, and binomial', () => {
		const rows = normalizeSimilarResults(FOCAL, [
			raw({ taxonId: 4368, sciName: 'Larus marinus', misidCount: 50 }),
			raw({
				taxonId: 910000,
				sciName: 'Larus marinus marinus',
				rank: 'subspecies',
				misidCount: 5,
				minSpeciesTaxonId: 4368
			}),
			raw({ taxonId: 4381, sciName: 'Larus fuscus', misidCount: 10 })
		]);
		expect(rows.map((r) => r.sciName)).toEqual(['Larus fuscus']);
	});

	it('re-ranks by merged count desc with deterministic id tiebreak and caps at INAT_MAX_STORED', () => {
		const many = Array.from({ length: 40 }, (_, i) =>
			raw({ taxonId: 1000 + i, sciName: `Testus sp${i}`, misidCount: 5 })
		);
		const rows = normalizeSimilarResults(FOCAL, [
			raw({ taxonId: 4381, sciName: 'Larus fuscus', misidCount: 100 }),
			...many
		]);
		expect(rows).toHaveLength(INAT_MAX_STORED);
		expect(rows[0].sciName).toBe('Larus fuscus');
		// Equal counts → ascending taxon id, stable across runs (hash-churn guard).
		expect(rows[1].taxonId).toBe(1000);
		expect(rows[2].taxonId).toBe(1001);
	});
});

/**
 * Upstream taxon → eBird species_code for external sources (td-eec7db
 * Phase 1, [C-P1-4], [A-P2-3]).
 *
 * Order: this source's override (external_taxon_overrides, keyed on the
 * upstream taxon id) → exact normalized scientific name among eBird
 * `species` → unmatched. The gallery's common-name overrides are never
 * consulted, and nothing is guessed: a scientific name shared by two eBird
 * species is "ambiguous" and stays unmatched. Name normalization is the
 * gallery matcher's (species-match.ts), so both match the same way.
 */
import type pg from 'pg';
import { normalizeName } from '$server/species-match';

export type TaxonMatch =
	| { code: string; method: 'override' | 'scientific' }
	| { code: null; reason: 'no_match' | 'ambiguous' | 'override_code_missing' };

export interface UpstreamTaxon {
	upstreamTaxonId: string;
	canonicalName: string;
}

type Db = Pick<pg.PoolClient, 'query'>;

/**
 * Matches are keyed by (upstream id, name): two regions loaded at different
 * upstream taxonomy snapshots may carry one id under two names, and each
 * pair is matched on its own — never whichever row a query returned last.
 */
export function taxonKey(upstreamTaxonId: string, canonicalName: string): string {
	return `${upstreamTaxonId}\u0000${canonicalName}`;
}

export async function matchExternalTaxa(
	db: Db,
	sourceId: string,
	taxa: UpstreamTaxon[]
): Promise<Map<string, TaxonMatch>> {
	const out = new Map<string, TaxonMatch>();
	if (taxa.length === 0) return out;
	const species = await db.query<{ species_code: string; sci_name: string }>(
		`SELECT species_code, sci_name FROM taxonomy_cache WHERE category = 'species'`
	);
	const codes = new Set<string>();
	const bySci = new Map<string, string[]>();
	for (const t of species.rows) {
		codes.add(t.species_code);
		const key = normalizeName(t.sci_name);
		const list = bySci.get(key);
		if (list) list.push(t.species_code);
		else bySci.set(key, [t.species_code]);
	}
	const overrides = await db.query<{ upstream_taxon_id: string; species_code: string }>(
		`SELECT upstream_taxon_id, species_code FROM external_taxon_overrides
		  WHERE source_id = $1 AND upstream_taxon_id = ANY($2::text[])`,
		[sourceId, taxa.map((t) => t.upstreamTaxonId)]
	);
	const byOverride = new Map(overrides.rows.map((o) => [o.upstream_taxon_id, o.species_code]));

	for (const t of taxa) {
		const key = taxonKey(t.upstreamTaxonId, t.canonicalName);
		const override = byOverride.get(t.upstreamTaxonId);
		if (override !== undefined) {
			out.set(
				key,
				codes.has(override) ? { code: override, method: 'override' } : { code: null, reason: 'override_code_missing' }
			);
			continue;
		}
		const hits = bySci.get(normalizeName(t.canonicalName)) ?? [];
		out.set(
			key,
			hits.length === 1
				? { code: hits[0], method: 'scientific' }
				: { code: null, reason: hits.length === 0 ? 'no_match' : 'ambiguous' }
		);
	}
	return out;
}

/** Parallel arrays for `unnest` (one round trip, no row cap). */
export function matchArrays(
	taxa: UpstreamTaxon[],
	matches: Map<string, TaxonMatch>
): {
	ids: string[];
	names: string[];
	codes: (string | null)[];
	reasons: (string | null)[];
} {
	const ids: string[] = [];
	const names: string[] = [];
	const codes: (string | null)[] = [];
	const reasons: (string | null)[] = [];
	for (const t of taxa) {
		const m = matches.get(taxonKey(t.upstreamTaxonId, t.canonicalName))!;
		ids.push(t.upstreamTaxonId);
		names.push(t.canonicalName);
		codes.push(m.code);
		reasons.push(m.code === null ? m.reason : null);
	}
	return { ids, names, codes, reasons };
}

/**
 * Serializes everything that reads raw taxa and rewrites a source's derived
 * rows: finish, rematch and saving/removing an override. Taken first in the
 * transaction, before any read, so a rebuild never mixes one snapshot's
 * matches with another snapshot's rows.
 */
export async function lockSourceDerived(db: Db, sourceId: string): Promise<void> {
	await db.query(`SELECT pg_advisory_xact_lock(hashtext('external-source:' || $1))`, [sourceId]);
}

/**
 * Re-derive the species rows, the recent reports' species codes and the
 * unmatched list for one region (or every region) of a source from the
 * stored raw taxa. Runs inside the caller's transaction. Used by finish and
 * after an override is saved; no upstream fetch is needed.
 */
export async function deriveSpecies(db: Db, sourceId: string, regionCode: string | null): Promise<void> {
	const taxa = await db.query<{ upstream_taxon_id: string; canonical_name: string }>(
		`SELECT DISTINCT upstream_taxon_id, canonical_name FROM (
		   SELECT upstream_taxon_id, canonical_name FROM external_taxon_month
		    WHERE source_id = $1 AND ($2::text IS NULL OR region_code = $2)
		   UNION ALL
		   SELECT upstream_taxon_id, canonical_name FROM external_recent_reports
		    WHERE source_id = $1 AND ($2::text IS NULL OR region_code = $2)
		 ) t`,
		[sourceId, regionCode]
	);
	const pairs = taxa.rows.map((t) => ({ upstreamTaxonId: t.upstream_taxon_id, canonicalName: t.canonical_name }));
	const matches = await matchExternalTaxa(db, sourceId, pairs);
	const { ids, names, codes, reasons } = matchArrays(pairs, matches);
	const scope = `source_id = $1 AND ($2::text IS NULL OR region_code = $2)`;

	await db.query(`DELETE FROM external_place_month_species WHERE ${scope}`, [sourceId, regionCode]);
	await db.query(
		`INSERT INTO external_place_month_species (source_id, region_code, place_key, species_code, month, reports, load_id)
		 SELECT tm.source_id, tm.region_code, tm.place_key, m.code, tm.month, SUM(tm.reports)::int, MIN(tm.load_id::text)::uuid
		   FROM external_taxon_month tm
		   JOIN unnest($3::text[], $4::text[], $5::text[]) AS m(id, name, code)
		     ON m.id = tm.upstream_taxon_id AND m.name = tm.canonical_name
		  WHERE tm.source_id = $1 AND ($2::text IS NULL OR tm.region_code = $2) AND m.code IS NOT NULL
		  GROUP BY tm.source_id, tm.region_code, tm.place_key, m.code, tm.month`,
		[sourceId, regionCode, ids, names, codes]
	);
	await db.query(
		`UPDATE external_recent_reports r SET species_code = m.code
		   FROM unnest($3::text[], $4::text[], $5::text[]) AS m(id, name, code)
		  WHERE r.source_id = $1 AND ($2::text IS NULL OR r.region_code = $2)
		    AND r.upstream_taxon_id = m.id AND r.canonical_name = m.name
		    AND r.species_code IS DISTINCT FROM m.code`,
		[sourceId, regionCode, ids, names, codes]
	);
	await db.query(`DELETE FROM external_unmatched WHERE ${scope}`, [sourceId, regionCode]);
	// Reports come from the region-level place only, so a county's municipal
	// rows are not counted twice. A taxon seen only in recent reports is
	// listed with the reports it has there.
	await db.query(
		`INSERT INTO external_unmatched (source_id, region_code, upstream_taxon_id, canonical_name, reason, reports, load_id)
		 SELECT u.source_id, u.region_code, u.upstream_taxon_id, MIN(u.canonical_name), MIN(m.reason),
		        COALESCE(SUM(u.reports) FILTER (WHERE u.kind = 'taxon'), SUM(u.reports)),
		        MIN(u.load_id::text)::uuid
		   FROM (
		     SELECT source_id, region_code, upstream_taxon_id, canonical_name, reports, load_id, 'taxon' AS kind
		       FROM external_taxon_month
		      WHERE source_id = $1 AND ($2::text IS NULL OR region_code = $2) AND place_key = region_code
		     UNION ALL
		     SELECT source_id, region_code, upstream_taxon_id, canonical_name, 1, load_id, 'recent'
		       FROM external_recent_reports
		      WHERE source_id = $1 AND ($2::text IS NULL OR region_code = $2)
		   ) u
		   JOIN unnest($3::text[], $4::text[], $5::text[]) AS m(id, name, reason)
		     ON m.id = u.upstream_taxon_id AND m.name = u.canonical_name
		  WHERE m.reason IS NOT NULL
		  GROUP BY u.source_id, u.region_code, u.upstream_taxon_id`,
		[sourceId, regionCode, ids, names, reasons]
	);
}

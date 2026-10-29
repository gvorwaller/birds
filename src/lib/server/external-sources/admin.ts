/**
 * Admin → Sources (td-eec7db Phase 1): the registry, connector health, loads
 * and unmatched taxa, plus the admin actions. Callers check role==='admin'.
 */
import { query, withTransaction } from '$lib/db';
import { buildMatcher } from '$server/species-match';
import type { LoadResult } from './lifecycle';
import { deriveSpecies, lockSourceDerived } from './taxa';

export interface AdminConnector {
	id: number;
	label: string;
	createdAt: string;
	lastSeenAt: string | null;
	revokedAt: string | null;
}

export interface AdminLoad {
	id: string;
	regionCode: string;
	regionName: string;
	status: string;
	attempt: number;
	maxAttempts: number;
	requestedByName: string | null;
	createdAt: string;
	finishedAt: string | null;
	heartbeatAt: string | null;
	leaseExpiresAt: string | null;
	overdue: boolean;
	progress: { phase: string; done: number; total: number } | null;
	error: string | null;
	result: LoadResult | null;
	/** Every connector note of the load (none are dropped). */
	notes: { code: string; detail: string; count: number }[];
}

export interface AdminUnmatched {
	upstreamTaxonId: string;
	canonicalName: string;
	/** The source's own common name (Artskart: Norwegian), when it sent one. */
	localName: string | null;
	reason: string;
	reports: number;
	regions: string[];
	/** An eBird species to offer with one tap; never applied without the owner. */
	suggestion: { code: string; comName: string; sciName: string } | null;
}

/** A taxon that counts as an eBird species, so the owner can change a wrong automatic match. */
export interface AdminMatched {
	upstreamTaxonId: string;
	canonicalName: string;
	localName: string | null;
	speciesCode: string;
	comName: string | null;
	/** How it was matched: 'scientific' | 'subspecies' | 'override'. */
	method: string;
	/** Stored reports (td-769300 records) for the taxon, across loaded regions. */
	reports: number;
}

export interface AdminSource {
	id: string;
	name: string;
	publisher: string;
	license: string;
	active: boolean;
	windowMonths: number;
	storeObservers: boolean;
	connectors: AdminConnector[];
	regions: { code: string; name: string; loadedAt: string | null; window: { start: string; end: string } | null }[];
	loads: AdminLoad[];
	oldestQueuedAt: string | null;
	overdueLeases: number;
	unmatched: AdminUnmatched[];
	matched: AdminMatched[];
	overrides: {
		upstreamTaxonId: string;
		canonicalName: string;
		localName: string | null;
		speciesCode: string;
		comName: string | null;
		setAt: string;
	}[];
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * The eBird binomials worth offering for an unmatched trinomial "Genus
 * species sub", best first: the subspecies as its own species ("Corvus
 * corone cornix" → Corvus cornix, Hooded Crow), then its parent species
 * ("Lagopus lagopus lagopus" → Lagopus lagopus). Anything else gets none.
 */
export function suggestionCandidates(canonicalName: string): string[] {
	const parts = canonicalName.trim().split(/\s+/);
	if (parts.length !== 3) return [];
	const [genus, species, sub] = parts;
	return sub === species ? [`${genus} ${species}`] : [`${genus} ${sub}`, `${genus} ${species}`];
}

/** The first candidate that names exactly one eBird species. */
export function pickSuggestion(
	canonicalName: string,
	species: { species_code: string; sci_name: string; com_name: string }[]
): { code: string; comName: string; sciName: string } | null {
	for (const name of suggestionCandidates(canonicalName)) {
		const hits = species.filter((t) => t.sci_name.toLowerCase() === name.toLowerCase());
		if (hits.length === 1) return { code: hits[0].species_code, comName: hits[0].com_name, sciName: hits[0].sci_name };
	}
	return null;
}

const byLocalName = (a: { localName: string | null; canonicalName: string }, b: typeof a) =>
	(a.localName ?? a.canonicalName).localeCompare(b.localName ?? b.canonicalName, 'nb') ||
	a.canonicalName.localeCompare(b.canonicalName);

export async function adminSources(): Promise<AdminSource[]> {
	const sources = await query<{
		id: string;
		name: string;
		publisher: string;
		license: string;
		active: boolean;
		window_months: number;
		store_observers: boolean;
	}>(`SELECT id, name, publisher, license, active, window_months, store_observers FROM external_sources ORDER BY name, id`);
	const out: AdminSource[] = [];
	for (const s of sources.rows) {
		const [connectors, regions, loads, queue, unmatched, matched, overrides] = await Promise.all([
			query<{ id: string; label: string; created_at: Date; last_seen_at: Date | null; revoked_at: Date | null }>(
				`SELECT id, label, created_at, last_seen_at, revoked_at FROM external_connectors
				  WHERE source_id = $1 ORDER BY revoked_at NULLS FIRST, created_at DESC`,
				[s.id]
			),
			query<{ code: string; name: string; finished_at: Date | null; window_start: string | null; window_end: string | null }>(
				`SELECT m.region_code AS code, r.name, d.finished_at,
				        to_char(d.window_start, 'YYYY-MM-DD') AS window_start, to_char(d.window_end, 'YYYY-MM-DD') AS window_end
				   FROM external_region_map m JOIN regions r ON r.code = m.region_code
				   LEFT JOIN external_loads d ON d.source_id = m.source_id AND d.region_code = m.region_code AND d.status = 'done'
				  WHERE m.source_id = $1 ORDER BY r.name`,
				[s.id]
			),
			query<{
				id: string;
				region_code: string;
				region_name: string;
				status: string;
				attempt: number;
				max_attempts: number;
				requested_by_name: string | null;
				created_at: Date;
				finished_at: Date | null;
				heartbeat_at: Date | null;
				lease_expires_at: Date | null;
				overdue: boolean;
				progress: AdminLoad['progress'];
				error: string | null;
				result: LoadResult | null;
				notes: AdminLoad['notes'] | null;
			}>(
				`SELECT l.id, l.region_code, r.name AS region_name, l.status, l.attempt, l.max_attempts,
				        u.display_name AS requested_by_name, l.created_at, l.finished_at, l.heartbeat_at,
				        l.lease_expires_at,
				        (l.status IN ('leased', 'staging') AND l.lease_expires_at <= now()) AS overdue,
				        l.progress, l.error, l.result,
				        (SELECT json_agg(json_build_object('code', d.code, 'detail', d.detail, 'count', d.count)
				                         ORDER BY d.code, d.detail)
				           FROM external_load_diagnostics d WHERE d.load_id = l.id) AS notes
				   FROM external_loads l
				   JOIN regions r ON r.code = l.region_code
				   LEFT JOIN users u ON u.id = l.requested_by
				  WHERE l.source_id = $1
				  ORDER BY l.created_at DESC LIMIT 30`,
				[s.id]
			),
			query<{ oldest: Date | null; overdue: string }>(
				`SELECT MIN(created_at) FILTER (WHERE status = 'queued') AS oldest,
				        COUNT(*) FILTER (WHERE status IN ('leased', 'staging') AND lease_expires_at <= now()) AS overdue
				   FROM external_loads WHERE source_id = $1`,
				[s.id]
			),
			query<{
				upstream_taxon_id: string;
				canonical_name: string;
				local_name: string | null;
				reason: string;
				reports: string;
				regions: string[];
			}>(
				`SELECT u.upstream_taxon_id, MIN(u.canonical_name) AS canonical_name,
				        (SELECT MIN(x.local_name) FROM external_taxa x
				          WHERE x.source_id = $1 AND x.upstream_taxon_id = u.upstream_taxon_id) AS local_name,
				        MIN(u.reason) AS reason, SUM(u.reports) AS reports,
				        array_agg(u.region_code ORDER BY u.region_code) AS regions
				   FROM external_unmatched u WHERE u.source_id = $1
				  GROUP BY u.upstream_taxon_id ORDER BY SUM(u.reports) DESC, MIN(u.canonical_name)`,
				[s.id]
			),
			query<{
				upstream_taxon_id: string;
				canonical_name: string;
				local_name: string | null;
				species_code: string;
				com_name: string | null;
				match_reason: string;
				reports: string;
			}>(
				`SELECT x.upstream_taxon_id, x.canonical_name, x.local_name, x.species_code, t.com_name, x.match_reason,
				        COALESCE(r.n, 0) AS reports
				   FROM external_taxa x
				   LEFT JOIN taxonomy_cache t ON t.species_code = x.species_code
				   LEFT JOIN (SELECT upstream_taxon_id, canonical_name, COUNT(*) AS n FROM external_records
				               WHERE source_id = $1 GROUP BY upstream_taxon_id, canonical_name) r
				     ON r.upstream_taxon_id = x.upstream_taxon_id AND r.canonical_name = x.canonical_name
				  WHERE x.source_id = $1 AND x.species_code IS NOT NULL`,
				[s.id]
			),
			query<{
				upstream_taxon_id: string;
				canonical_name: string;
				local_name: string | null;
				species_code: string;
				com_name: string | null;
				set_at: Date;
			}>(
				`SELECT o.upstream_taxon_id, o.canonical_name,
				        (SELECT MIN(x.local_name) FROM external_taxa x
				          WHERE x.source_id = o.source_id AND x.upstream_taxon_id = o.upstream_taxon_id) AS local_name,
				        o.species_code, t.com_name, o.set_at
				   FROM external_taxon_overrides o LEFT JOIN taxonomy_cache t ON t.species_code = o.species_code
				  WHERE o.source_id = $1 ORDER BY o.canonical_name`,
				[s.id]
			)
		]);
		const candidates = [...new Set(unmatched.rows.flatMap((u) => suggestionCandidates(u.canonical_name)))];
		const suggestable = candidates.length
			? (
					await query<{ species_code: string; sci_name: string; com_name: string }>(
						`SELECT species_code, sci_name, com_name FROM taxonomy_cache
						  WHERE category = 'species' AND lower(sci_name) = ANY($1::text[])`,
						[candidates.map((c) => c.toLowerCase())]
					)
				).rows
			: [];
		out.push({
			id: s.id,
			name: s.name,
			publisher: s.publisher,
			license: s.license,
			active: s.active,
			windowMonths: s.window_months,
			storeObservers: s.store_observers,
			connectors: connectors.rows.map((c) => ({
				id: Number(c.id),
				label: c.label,
				createdAt: c.created_at.toISOString(),
				lastSeenAt: iso(c.last_seen_at),
				revokedAt: iso(c.revoked_at)
			})),
			regions: regions.rows.map((r) => ({
				code: r.code,
				name: r.name,
				loadedAt: iso(r.finished_at),
				window: r.window_start && r.window_end ? { start: r.window_start, end: r.window_end } : null
			})),
			loads: loads.rows.map((l) => ({
				id: l.id,
				regionCode: l.region_code,
				regionName: l.region_name,
				status: l.status,
				attempt: l.attempt,
				maxAttempts: l.max_attempts,
				requestedByName: l.requested_by_name,
				createdAt: l.created_at.toISOString(),
				finishedAt: iso(l.finished_at),
				heartbeatAt: iso(l.heartbeat_at),
				leaseExpiresAt: iso(l.lease_expires_at),
				overdue: l.overdue,
				progress: l.progress,
				error: l.error,
				result: l.result,
				notes: l.notes ?? []
			})),
			oldestQueuedAt: iso(queue.rows[0]?.oldest ?? null),
			overdueLeases: Number(queue.rows[0]?.overdue ?? 0),
			unmatched: unmatched.rows.map((u) => ({
				upstreamTaxonId: u.upstream_taxon_id,
				canonicalName: u.canonical_name,
				localName: u.local_name,
				reason: u.reason,
				reports: Number(u.reports),
				regions: u.regions,
				suggestion: pickSuggestion(u.canonical_name, suggestable)
			})),
			matched: matched.rows
				.map((m) => ({
					upstreamTaxonId: m.upstream_taxon_id,
					canonicalName: m.canonical_name,
					localName: m.local_name,
					speciesCode: m.species_code,
					comName: m.com_name,
					method: m.match_reason,
					reports: Number(m.reports)
				}))
				.sort(byLocalName),
			overrides: overrides.rows.map((o) => ({
				upstreamTaxonId: o.upstream_taxon_id,
				canonicalName: o.canonical_name,
				localName: o.local_name,
				speciesCode: o.species_code,
				comName: o.com_name,
				setAt: o.set_at.toISOString()
			}))
		});
	}
	return out;
}

/** Revoke a connector token. Its next call is refused; it can never publish. */
export async function revokeConnector(connectorId: number): Promise<boolean> {
	const r = await query(`UPDATE external_connectors SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [
		connectorId
	]);
	return (r.rowCount ?? 0) > 0;
}

export class OverrideError extends Error {}

/**
 * "Match species" for an unmatched upstream taxon, or a change to an
 * automatic match (kråke, Corvus corone, is the Hooded Crow in Norway): accepts an exact eBird
 * common name, scientific name or species code (as /photos does), saves the
 * override and re-derives the source's species rows and recent reports from
 * the stored raw taxa — no new fetch [A-P1-2].
 */
export async function setTaxonOverride(opts: {
	sourceId: string;
	upstreamTaxonId: string;
	species: string;
	userId: number;
}): Promise<{ speciesCode: string; canonicalName: string; localName: string | null; comName: string | null }> {
	const species = opts.species.trim();
	if (!species) throw new OverrideError('Enter a species.');
	const matcher = await buildMatcher();
	let code = matcher.match(species, species)?.code ?? null;
	if (!code) {
		const byCode = await query<{ species_code: string }>(
			`SELECT species_code FROM taxonomy_cache WHERE species_code = $1 AND category = 'species'`,
			[species.toLowerCase()]
		);
		code = byCode.rows[0]?.species_code ?? null;
	}
	if (!code) {
		throw new OverrideError(`"${species}" is not an eBird species — use the exact common name, scientific name, or species code.`);
	}
	const speciesCode = code;
	return withTransaction(async (c) => {
		await lockSourceDerived(c, opts.sourceId);
		const name = await c.query<{ canonical_name: string }>(
			`SELECT canonical_name FROM external_unmatched WHERE source_id = $1 AND upstream_taxon_id = $2
			 UNION SELECT canonical_name FROM external_taxon_month WHERE source_id = $1 AND upstream_taxon_id = $2
			 UNION SELECT canonical_name FROM external_taxa WHERE source_id = $1 AND upstream_taxon_id = $2 AND rank <> 'OTHER'
			 LIMIT 1`,
			[opts.sourceId, opts.upstreamTaxonId]
		);
		const canonicalName = name.rows[0]?.canonical_name;
		if (!canonicalName) throw new OverrideError('That upstream taxon is not in any loaded data.');
		await c.query(
			`INSERT INTO external_taxon_overrides (source_id, upstream_taxon_id, species_code, canonical_name, set_by)
			 VALUES ($1, $2, $3, $4, $5)
			 ON CONFLICT (source_id, upstream_taxon_id)
			 DO UPDATE SET species_code = EXCLUDED.species_code, canonical_name = EXCLUDED.canonical_name,
			               set_by = EXCLUDED.set_by, set_at = now()`,
			[opts.sourceId, opts.upstreamTaxonId, speciesCode, canonicalName, opts.userId]
		);
		await deriveSpecies(c, opts.sourceId, null);
		const names = await c.query<{ local_name: string | null; com_name: string | null }>(
			`SELECT (SELECT MIN(local_name) FROM external_taxa WHERE source_id = $1 AND upstream_taxon_id = $2) AS local_name,
			        (SELECT com_name FROM taxonomy_cache WHERE species_code = $3) AS com_name`,
			[opts.sourceId, opts.upstreamTaxonId, speciesCode]
		);
		return { speciesCode, canonicalName, localName: names.rows[0]?.local_name ?? null, comName: names.rows[0]?.com_name ?? null };
	});
}

/** Remove an override and re-derive (the taxon goes back to name matching). */
export async function removeTaxonOverride(sourceId: string, upstreamTaxonId: string): Promise<boolean> {
	return withTransaction(async (c) => {
		await lockSourceDerived(c, sourceId);
		const r = await c.query(`DELETE FROM external_taxon_overrides WHERE source_id = $1 AND upstream_taxon_id = $2`, [
			sourceId,
			upstreamTaxonId
		]);
		if (!r.rowCount) return false;
		await deriveSpecies(c, sourceId, null);
		return true;
	});
}

/** Re-run matching for every loaded region, e.g. after an eBird taxonomy update. */
export async function rematchSource(sourceId: string): Promise<void> {
	await withTransaction(async (c) => {
		await lockSourceDerived(c, sourceId);
		await deriveSpecies(c, sourceId, null);
	});
}

/**
 * The taxonomy refresh re-matches external sources (td-493c58; plan
 * docs/2026-10-31-taxonomy-sources-rematch-plan-CC.md).
 *
 * External sources keep the eBird species code each upstream taxon was matched
 * to. After a sync, each active source is re-matched (deriveSpecies, with the
 * former-name fallback in external-sources/taxa.ts) and the taxa whose species
 * changed are recorded against a per-run BASELINE of the matches: copied with
 * the before-sync backup, or just before the re-match when the run has none
 * (runs from before td-493c58, a source added mid-run). The diff is always
 * baseline → now, so a replay records the same thing whoever re-matched in
 * between (a connector publish, Admin → Sources "Re-match species").
 */
import type pg from 'pg';
import { query } from '$lib/db';
import { withClaimTx } from '$server/job-claim';
import { deriveSpecies, lockSourceDerived } from '$server/external-sources/taxa';

export type BaselineKind = 'before_sync' | 'before_rematch';

export interface SourceRematchSummary {
	sourceId: string;
	name: string;
	baselineKind: BaselineKind;
	baselineAt: string;
	rematchedAt: string | null;
	moved: number;
	lost: number;
	gained: number;
	keptFormer: number;
}

export interface SourceChangeRow {
	source_id: string;
	upstream_taxon_id: string;
	canonical_name: string;
	local_name: string | null;
	old_code: string | null;
	new_code: string | null;
	old_reason: string | null;
	new_reason: string | null;
	old_com_name: string | null;
	new_com_name: string | null;
	places: number;
}

/** One run's baseline for every active source (or those given) that has none yet; returns the sources copied. */
export async function copySourceBaselines(
	c: Pick<pg.PoolClient, 'query'>,
	runId: number,
	kind: BaselineKind,
	sources: readonly string[] | null = null
): Promise<string[]> {
	const made = await c.query<{ source_id: string }>(
		`INSERT INTO taxonomy_source_rematches (run_id, source_id, baseline_kind)
		 SELECT $1, id, $2 FROM external_sources WHERE active AND ($3::text[] IS NULL OR id = ANY($3::text[]))
		 ON CONFLICT (run_id, source_id) DO NOTHING
		 RETURNING source_id`,
		[runId, kind, sources]
	);
	const ids = made.rows.map((r) => r.source_id);
	if (ids.length > 0) {
		await c.query(
			`INSERT INTO taxonomy_source_baseline (run_id, source_id, upstream_taxon_id, canonical_name, species_code, match_reason)
			 SELECT $1, source_id, upstream_taxon_id, canonical_name, species_code, match_reason
			   FROM external_taxa WHERE source_id = ANY($2::text[]) AND rank <> 'OTHER'`,
			[runId, ids]
		);
	}
	return ids;
}

/**
 * Inside the caller's transaction, after the source lock and the re-match:
 * replace the run's change rows for the source and its summary counts.
 */
async function recordDiff(c: pg.PoolClient, runId: number, sourceId: string): Promise<void> {
	await c.query(`DELETE FROM taxonomy_source_changes WHERE run_id = $1 AND source_id = $2`, [runId, sourceId]);
	await c.query(
		`INSERT INTO taxonomy_source_changes (run_id, source_id, upstream_taxon_id, canonical_name, local_name,
		        old_code, new_code, old_reason, new_reason, places)
		 SELECT b.run_id, b.source_id, b.upstream_taxon_id, b.canonical_name, t.local_name,
		        b.species_code, t.species_code, b.match_reason, t.match_reason,
		        (SELECT count(DISTINCT p.place_key)::int FROM (
		           SELECT place_key, region_code FROM external_taxon_month
		            WHERE source_id = b.source_id AND upstream_taxon_id = b.upstream_taxon_id AND canonical_name = b.canonical_name
		           UNION ALL
		           SELECT place_key, region_code FROM external_records
		            WHERE source_id = b.source_id AND upstream_taxon_id = b.upstream_taxon_id AND canonical_name = b.canonical_name
		           UNION ALL
		           SELECT place_key, region_code FROM external_recent_reports
		            WHERE source_id = b.source_id AND upstream_taxon_id = b.upstream_taxon_id AND canonical_name = b.canonical_name
		         ) p WHERE p.place_key <> p.region_code)
		   FROM taxonomy_source_baseline b
		   JOIN external_taxa t ON t.source_id = b.source_id AND t.upstream_taxon_id = b.upstream_taxon_id
		                       AND t.canonical_name = b.canonical_name
		  WHERE b.run_id = $1 AND b.source_id = $2
		    AND (b.species_code IS DISTINCT FROM t.species_code
		         OR (t.match_reason = 'former_name' AND b.match_reason IS DISTINCT FROM 'former_name'))`,
		[runId, sourceId]
	);
	await c.query(
		`UPDATE taxonomy_source_rematches s SET rematched_at = clock_timestamp(),
		        moved = d.moved, lost = d.lost, gained = d.gained, kept_former = d.kept_former
		   FROM (SELECT count(*) FILTER (WHERE old_code IS NOT NULL AND new_code IS NOT NULL AND old_code <> new_code)::int AS moved,
		                count(*) FILTER (WHERE old_code IS NOT NULL AND new_code IS NULL)::int AS lost,
		                count(*) FILTER (WHERE old_code IS NULL AND new_code IS NOT NULL)::int AS gained,
		                count(*) FILTER (WHERE old_code = new_code)::int AS kept_former
		           FROM taxonomy_source_changes WHERE run_id = $1 AND source_id = $2) d
		  WHERE s.run_id = $1 AND s.source_id = $2`,
		[runId, sourceId]
	);
}

/**
 * Re-match every active source for a run and record what changed, one
 * claim-fenced transaction per source (the source lock first). A source that
 * fails leaves the earlier ones recorded; a retry re-matches all of them and
 * records the same diff. `guard` runs first in each transaction (the web
 * action's run checks); `sources` limits the sources (tests own theirs).
 */
export async function rematchSourcesForRun(
	runId: number,
	opts: { guard?: (c: pg.PoolClient) => Promise<void>; sources?: readonly string[] } = {}
): Promise<SourceRematchSummary[]> {
	const guard = opts.guard ?? (async () => {});
	const sources = await query<{ id: string }>(
		`SELECT id FROM external_sources WHERE active AND ($1::text[] IS NULL OR id = ANY($1::text[])) ORDER BY id`,
		[opts.sources ?? null]
	);
	for (const s of sources.rows) {
		await withClaimTx(
			async (c) => {
				await guard(c);
				await lockSourceDerived(c, s.id);
				await copySourceBaselines(c, runId, 'before_rematch', [s.id]);
				await deriveSpecies(c, s.id, null);
				await recordDiff(c, runId, s.id);
			},
			{ where: `taxonomy source re-match (${s.id})` }
		);
	}
	return sourceSummaries(runId);
}

export async function sourceSummaries(runId: number): Promise<SourceRematchSummary[]> {
	const r = await query<{
		source_id: string;
		name: string;
		baseline_kind: BaselineKind;
		baseline_at: string;
		rematched_at: string | null;
		moved: number | null;
		lost: number | null;
		gained: number | null;
		kept_former: number | null;
	}>(
		`SELECT s.source_id, e.name, s.baseline_kind, s.baseline_at::text, s.rematched_at::text,
		        s.moved, s.lost, s.gained, s.kept_former
		   FROM taxonomy_source_rematches s JOIN external_sources e ON e.id = s.source_id
		  WHERE s.run_id = $1 ORDER BY e.name`,
		[runId]
	);
	return r.rows.map((s) => ({
		sourceId: s.source_id,
		name: s.name,
		baselineKind: s.baseline_kind,
		baselineAt: s.baseline_at,
		rematchedAt: s.rematched_at,
		moved: s.moved ?? 0,
		lost: s.lost ?? 0,
		gained: s.gained ?? 0,
		keptFormer: s.kept_former ?? 0
	}));
}

/** Every recorded change of a run, with eBird's names for both codes as the run saw them. */
export async function sourceChanges(runId: number): Promise<SourceChangeRow[]> {
	const r = await query<SourceChangeRow>(
		`SELECT c.source_id, c.upstream_taxon_id, c.canonical_name, c.local_name, c.old_code, c.new_code,
		        c.old_reason, c.new_reason, c.places,
		        coalesce(ob.com_name, o.com_name) AS old_com_name, coalesce(nb.com_name, n.com_name) AS new_com_name
		   FROM taxonomy_source_changes c
		   JOIN taxonomy_runs r ON r.id = c.run_id
		   -- The run's own backups name both sides, so a later refresh never relabels
		   -- this run's history (CODEX1); today's taxonomy only when a backup lacks it.
		   LEFT JOIN taxonomy_backup_rows ob ON ob.backup_id = r.before_id AND ob.species_code = c.old_code
		   LEFT JOIN taxonomy_backup_rows nb ON nb.backup_id = r.after_id AND nb.species_code = c.new_code
		   LEFT JOIN taxonomy_cache o ON o.species_code = c.old_code
		   LEFT JOIN taxonomy_cache n ON n.species_code = c.new_code
		  WHERE c.run_id = $1
		  ORDER BY (c.new_code IS NULL) DESC, (c.old_code IS DISTINCT FROM c.new_code) DESC, c.places DESC, c.canonical_name`,
		[runId]
	);
	return r.rows;
}

/** Whether an active source still has no re-match recorded for the run. */
export async function sourcesPending(runId: number): Promise<boolean> {
	const r = await query(
		`SELECT 1 FROM external_sources e
		  WHERE e.active AND NOT EXISTS (SELECT 1 FROM taxonomy_source_rematches s
		                                  WHERE s.run_id = $1 AND s.source_id = e.id AND s.rematched_at IS NOT NULL)`,
		[runId]
	);
	return (r.rowCount ?? 0) > 0;
}

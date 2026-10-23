/**
 * External loads in the app's job chip (td-eec7db Phase 1, [A-P2-2]).
 *
 * /api/jobs returns the signed-in user's active and recently finished loads
 * beside the eBird jobs, in a separate list: their ids are uuids and they
 * have no cancel route, so they never enter the eBird job array. The
 * presentation states are the eBird chip's own, so jobPresentationText()
 * words them the same way.
 */
import { query } from '$lib/db';

export interface ExternalLoadJob {
	id: string;
	sourceId: string;
	regionCode: string;
	displayName: string;
	status: string;
	startedAt: string | null;
	finishedAt: string | null;
	error: string | null;
	progress: { unitsTotal?: number; unitsDone?: number; currentUnit?: { name: string } };
	presentation: { state: string; explanation?: string };
}

const ACTIVE = new Set(['queued', 'leased', 'staging']);

export function isExternalActive(load: Pick<ExternalLoadJob, 'status'>): boolean {
	return ACTIVE.has(load.status);
}

/**
 * Every outstanding load (at most one per source and region, so bounded by
 * the registry) plus the ten most recent finished in the last 30 minutes.
 * Active loads are never pushed out by finished ones.
 */
export async function externalLoadsForUser(userId: number): Promise<ExternalLoadJob[]> {
	const r = await query<{
		id: string;
		source_id: string;
		region_code: string;
		source_name: string;
		region_name: string;
		status: string;
		started_at: Date | null;
		finished_at: Date | null;
		error: string | null;
		progress: { phase: string; done: number; total: number } | null;
		overdue: boolean;
		attempt: number;
	}>(
		`SELECT l.id, l.source_id, l.region_code, s.name AS source_name, r.name AS region_name, l.status,
		        l.started_at, l.finished_at, l.error, l.progress, l.attempt,
		        (l.status IN ('leased', 'staging') AND l.lease_expires_at <= now()) AS overdue
		   FROM external_loads l
		   JOIN external_sources s ON s.id = l.source_id
		   JOIN regions r ON r.code = l.region_code
		  WHERE l.requested_by = $1
		    AND (l.status IN ('queued', 'leased', 'staging')
		         OR l.id IN (SELECT id FROM external_loads
		                      WHERE requested_by = $1 AND status NOT IN ('queued', 'leased', 'staging')
		                        AND finished_at > now() - interval '30 minutes'
		                      ORDER BY finished_at DESC LIMIT 10))
		  ORDER BY l.created_at DESC`,
		[userId]
	);
	return r.rows.map((l) => {
		const p = l.progress;
		let presentation: ExternalLoadJob['presentation'];
		if (l.status === 'queued') {
			presentation =
				l.attempt > 0
					? { state: 'queued', explanation: 'will be retried shortly' }
					: { state: 'queued', explanation: 'waiting for the connector' };
		} else if (l.status === 'leased' || l.status === 'staging') {
			presentation = l.overdue
				? { state: 'waiting', explanation: 'the connector has stopped reporting; the load will be retried' }
				: { state: 'running' };
		} else if (l.status === 'done' || l.status === 'superseded') {
			presentation = { state: 'complete' };
		} else {
			presentation = { state: 'failed', explanation: l.error ?? undefined };
		}
		return {
			id: l.id,
			sourceId: l.source_id,
			regionCode: l.region_code,
			displayName: `${l.source_name} reports for ${l.region_name}`,
			status: l.status,
			startedAt: l.started_at?.toISOString() ?? null,
			finishedAt: l.finished_at?.toISOString() ?? null,
			error: l.error,
			progress: p ? { unitsTotal: p.total, unitsDone: p.done, currentUnit: { name: p.phase } } : {},
			presentation
		};
	});
}

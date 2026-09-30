/**
 * Worker handlers for the tag-engine operations (td-894144 Release B3). Every
 * owner action in the admin Tags tab enqueues one of these; the heavy or
 * lock-holding work runs here, never in a request.
 *
 *  tag_consistency — recurring nightly singleton (not cancellable);
 *  tag_stage       — stage a revision (shared lock) + a stage report;
 *  tag_benchmark   — dry-run the real switch in a rolled-back transaction;
 *  tag_activate    — switch ownership (cancel honoured only before the lock);
 *  tag_retire      — retire to legacy (always allowed);
 *  tag_rollback    — one step back (refused for a revision target while a
 *                    repair generation is pending).
 *
 * Every non-recurring op re-checks, at execution time, that its requester is
 * still an admin (Option A: the route and this recheck are the auth boundary;
 * definer user ids are audit data).
 */
import { query } from '$lib/db';
import { ALL_TAGS } from '$lib/species-tags';
import { dedupKeys, retryDelayMs, sanitizeErrorText, type JobRow } from '$server/job-policy';
import {
	cancelRunningJob,
	completeJob,
	enqueueJob,
	failJob,
	hasActiveJob,
	recordEvent,
	scheduleRetry,
	terminalizeAndReschedule,
	updateProgress
} from '$server/jobs';
import { activateRevision, retireTagToLegacy, rollbackTag, stageRevision } from '$server/tag-engine/activation';
import { msUntilQuietHour, runTagConsistency } from '$server/tag-engine/consistency';
import { scannerRev } from '$server/tag-engine/segment';

/** The switch budget the benchmark must meet (plan rev 13: ≤10 s exclusive). */
export const TAG_SWITCH_BUDGET_MS = 10_000;

async function lowestAdminId(): Promise<number> {
	const r = await query<{ id: number }>(`SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1`);
	if (!r.rows[0]) throw new Error('no admin user exists to own the tag consistency job');
	return r.rows[0].id;
}

// ── consistency (recurring singleton) ─────────────────────────────────────

function consistencyParams(adminId: number, runAfterMs: number) {
	return {
		type: 'tag_consistency' as const,
		payload: {},
		dedupKey: dedupKeys.tagConsistency(),
		requestedBy: adminId,
		label: 'nightly',
		runAfterMs
	};
}

/** Chain reconciliation — worker startup + idle tick, beside the other scans. */
export async function ensureTagConsistency(): Promise<void> {
	// After a deploy that changed the engine (new scanner_rev), run the pass
	// now: it opens the repair generation that re-derives every input, so the
	// stale inputs never wait for the nightly slot (td-894144 B5).
	const state = (
		await query<{ scanner_rev: string }>('SELECT scanner_rev FROM tag_lexicon_state WHERE id = 1')
	).rows[0];
	if (state && state.scanner_rev !== scannerRev()) {
		await runTagConsistencyNow();
		return;
	}
	if (await hasActiveJob(dedupKeys.tagConsistency())) return;
	await enqueueJob(consistencyParams(await lowestAdminId(), msUntilQuietHour()));
}

/**
 * Admin "Run now": pull the parked run forward. A RUNNING pass is left alone;
 * a lost chain is re-created to run immediately.
 */
export async function runTagConsistencyNow(): Promise<'nudged' | 'running' | 'enqueued'> {
	const r = await query<{ status: string }>(
		`UPDATE jobs SET next_retry_at = NOW()
		  WHERE dedup_key = $1 AND status = 'pending'
		  RETURNING status`,
		[dedupKeys.tagConsistency()]
	);
	if (r.rows[0]) return 'nudged';
	if (await hasActiveJob(dedupKeys.tagConsistency())) return 'running';
	await enqueueJob(consistencyParams(await lowestAdminId(), 0));
	return 'enqueued';
}

export async function runTagConsistencyJob(job: JobRow): Promise<void> {
	const attempts = job.attempts;
	await recordEvent(job.id, 'claimed', { attempt: attempts });
	try {
		const adminId = await lowestAdminId();
		const result = await runTagConsistency({ requesterId: adminId });
		await terminalizeAndReschedule(
			job.id,
			attempts,
			{ kind: 'complete', result },
			consistencyParams(adminId, msUntilQuietHour())
		);
	} catch (err) {
		const message = sanitizeErrorText(err instanceof Error ? err.message : String(err)).slice(0, 300);
		if (attempts < job.max_attempts) {
			await scheduleRetry(job.id, attempts, retryDelayMs(attempts, 'transient'), message);
			return;
		}
		// Out of attempts: fail THIS run but keep the chain (tomorrow's pass).
		await terminalizeAndReschedule(
			job.id,
			attempts,
			{ kind: 'fail', error: message },
			consistencyParams(await lowestAdminId(), msUntilQuietHour())
		);
	}
}

// ── owner operations ──────────────────────────────────────────────────────

interface TagOpPayload {
	tag: string;
	revisionId?: string;
	gateReportId?: string;
	benchmarkReportId?: string;
}

const ID = /^[1-9][0-9]{0,18}$/;

/** Validate a payload for `type`; null = malformed (terminal). */
export function parseTagOpPayload(type: string, raw: unknown): TagOpPayload | null {
	const p = (raw ?? {}) as Record<string, unknown>;
	if (typeof p.tag !== 'string' || !ALL_TAGS.has(p.tag)) return null;
	const id = (k: string) => (typeof p[k] === 'string' && ID.test(p[k] as string) ? (p[k] as string) : null);
	switch (type) {
		case 'tag_retire':
		case 'tag_rollback':
			return { tag: p.tag };
		case 'tag_stage':
		case 'tag_benchmark': {
			const revisionId = id('revisionId');
			return revisionId ? { tag: p.tag, revisionId } : null;
		}
		case 'tag_activate': {
			const revisionId = id('revisionId');
			const gateReportId = id('gateReportId');
			const benchmarkReportId = id('benchmarkReportId');
			return revisionId && gateReportId && benchmarkReportId
				? { tag: p.tag, revisionId, gateReportId, benchmarkReportId }
				: null;
		}
		default:
			return null;
	}
}

async function isAdmin(userId: number): Promise<boolean> {
	const r = await query<{ role: string }>('SELECT role FROM users WHERE id = $1', [userId]);
	return r.rows[0]?.role === 'admin';
}

/** What activating this revision would change, with samples (stage report body). */
export async function stageReportBody(tag: string, revisionId: string): Promise<Record<string, unknown>> {
	const counts = (
		await query<Record<string, string>>(
			`WITH st AS (
			   SELECT s.species_code, s.status, s.reason
			     FROM species_tag_state s
			     JOIN species_tag_input i ON i.species_code = s.species_code AND i.input_hash = s.input_hash
			    WHERE s.tag = $1 AND s.revision_id = $2),
			 scope AS (
			   SELECT se.species_code, coalesce($1 = ANY (se.tags), false) AS carries, st.status
			     FROM species_enrichment se
			     LEFT JOIN st ON st.species_code = se.species_code
			    WHERE st.species_code IS NOT NULL OR $1 = ANY (se.tags))
			 SELECT count(*) FILTER (WHERE status = 'assigned')::text AS assigned,
			        count(*) FILTER (WHERE status = 'not_assigned')::text AS not_assigned,
			        count(*) FILTER (WHERE status = 'unevaluated')::text AS unevaluated,
			        count(*) FILTER (WHERE carries)::text AS carrying_now,
			        count(*) FILTER (WHERE status = 'assigned' AND NOT carries)::text AS would_add,
			        count(*) FILTER (WHERE carries AND status IS DISTINCT FROM 'assigned')::text AS would_remove
			   FROM scope`,
			[tag, revisionId]
		)
	).rows[0];
	const reasons = (
		await query<{ reason: string; n: string }>(
			`SELECT s.reason, count(*)::text AS n
			   FROM species_tag_state s
			   JOIN species_tag_input i ON i.species_code = s.species_code AND i.input_hash = s.input_hash
			  WHERE s.tag = $1 AND s.revision_id = $2 AND s.status <> 'assigned'
			  GROUP BY s.reason ORDER BY count(*) DESC, s.reason LIMIT 12`,
			[tag, revisionId]
		)
	).rows.map((r) => ({ reason: r.reason, n: Number(r.n) }));
	const adds = (
		await query<{ code: string; name: string | null; evidence: unknown }>(
			`SELECT s.species_code AS code, tc.com_name AS name, s.evidence -> 0 AS evidence
			   FROM species_tag_state s
			   JOIN species_tag_input i ON i.species_code = s.species_code AND i.input_hash = s.input_hash
			   JOIN species_enrichment se ON se.species_code = s.species_code
			   LEFT JOIN taxonomy_cache tc ON tc.species_code = s.species_code
			  WHERE s.tag = $1 AND s.revision_id = $2 AND s.status = 'assigned'
			    AND NOT coalesce($1 = ANY (se.tags), false)
			  ORDER BY md5(s.species_code || $2) LIMIT 15`,
			[tag, revisionId]
		)
	).rows;
	const removes = (
		await query<{ code: string; name: string | null; reason: string | null }>(
			`SELECT se.species_code AS code, tc.com_name AS name, coalesce(st.reason, 'no_state') AS reason
			   FROM species_enrichment se
			   LEFT JOIN taxonomy_cache tc ON tc.species_code = se.species_code
			   LEFT JOIN LATERAL (
			     SELECT s.status, s.reason FROM species_tag_state s
			       JOIN species_tag_input i ON i.species_code = s.species_code AND i.input_hash = s.input_hash
			      WHERE s.species_code = se.species_code AND s.tag = $1 AND s.revision_id = $2) st ON true
			  WHERE $1 = ANY (se.tags) AND st.status IS DISTINCT FROM 'assigned'
			  ORDER BY md5(se.species_code || $2) LIMIT 15`,
			[tag, revisionId]
		)
	).rows;
	return {
		counts: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Number(v)])),
		reasons,
		samples: { adds, removes }
	};
}

async function recordReport(kind: string, tag: string, revisionId: string, body: unknown): Promise<string> {
	return (
		await query<{ id: string }>('SELECT public.record_tag_report($1, $2, $3, $4::jsonb)::text AS id', [
			kind,
			tag,
			revisionId,
			JSON.stringify(body)
		])
	).rows[0].id;
}

/** One handler for every owner operation: validate, admin recheck, run, terminalize. */
export async function runTagOpJob(job: JobRow): Promise<void> {
	const attempts = job.attempts;
	const p = parseTagOpPayload(job.type, job.payload);
	if (!p) {
		await failJob(job.id, attempts, `${job.type}: malformed payload`);
		return;
	}
	await recordEvent(job.id, 'claimed', { attempt: attempts, tag: p.tag });
	if (!(await isAdmin(job.requested_by))) {
		await failJob(job.id, attempts, `${job.type}: requester is no longer an admin`);
		return;
	}
	// Cancel is honoured only BEFORE the engine lock (plan B3); once an
	// operation holds it, it runs to commit or rollback.
	const { cancelRequested } = await updateProgress(job.id, {
		phase: 'starting',
		unitsTotal: 1,
		unitsDone: 0,
		unitsFailed: 0,
		unitsSkipped: 0,
		round: attempts
	});
	if (cancelRequested) {
		await cancelRunningJob(job.id, attempts, { when: 'before_lock' });
		return;
	}
	try {
		let result: Record<string, unknown>;
		switch (job.type) {
			case 'tag_stage': {
				const staged = await stageRevision(p.tag, p.revisionId!);
				const body = { ...staged, ...(await stageReportBody(p.tag, p.revisionId!)) };
				result = { reportId: await recordReport('stage', p.tag, p.revisionId!, body), ...staged };
				break;
			}
			case 'tag_benchmark': {
				let timing: Record<string, number> = {};
				await activateRevision({
					tag: p.tag,
					revisionId: p.revisionId!,
					userId: job.requested_by,
					benchmark: true,
					onTiming: (t) => (timing = t)
				});
				const passed = timing.totalMs != null && timing.totalMs <= TAG_SWITCH_BUDGET_MS;
				const body = { passed, budgetMs: TAG_SWITCH_BUDGET_MS, ...timing };
				result = { reportId: await recordReport('benchmark', p.tag, p.revisionId!, body), passed, ...timing };
				break;
			}
			case 'tag_activate': {
				const activationId = await activateRevision({
					tag: p.tag,
					revisionId: p.revisionId!,
					gateReportId: p.gateReportId,
					benchmarkReportId: p.benchmarkReportId,
					userId: job.requested_by
				});
				result = { activationId };
				break;
			}
			case 'tag_retire':
				result = { activationId: await retireTagToLegacy(p.tag, job.requested_by) };
				break;
			case 'tag_rollback':
				result = { activationId: await rollbackTag(p.tag, job.requested_by) };
				break;
			default:
				await failJob(job.id, attempts, `no tag handler for ${job.type}`);
				return;
		}
		await completeJob(job.id, attempts, result);
	} catch (err) {
		// Owner operations are not retried blindly: a refusal (pending repair,
		// failed coverage, missing report) is an answer, not a transient.
		const message = sanitizeErrorText(err instanceof Error ? err.message : String(err)).slice(0, 300);
		await failJob(job.id, attempts, message);
	}
}

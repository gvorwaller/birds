import { error } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { query } from "$lib/db";
import { galleryHealth } from "$server/gallery";
import { listJobs, workerHealth } from "$server/jobs";
import {
  displayName,
  durationMs,
  jobTarget,
  statusColor,
  type JobRow,
} from "$server/job-policy";

export interface AdminJob {
  id: number;
  type: string;
  status: string;
  displayName: string;
  statusColor: string;
  attempts: number;
  maxAttempts: number;
  nextRetryAt: string | null;
  cancelRequested: boolean;
  progress: JobRow["progress"];
  result: unknown;
  error: string | null;
  requestedByName: string | null;
  target: string | null;
  enqueuedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

function decorate(job: JobRow, now: Date): AdminJob {
  return {
    id: Number(job.id),
    type: job.type,
    status: job.status,
    displayName: displayName(job),
    statusColor: statusColor(job.status),
    attempts: job.attempts,
    maxAttempts: job.max_attempts,
    nextRetryAt: job.next_retry_at
      ? new Date(job.next_retry_at).toISOString()
      : null,
    cancelRequested: job.cancel_requested,
    progress: job.progress,
    result: job.result,
    error: job.error,
    requestedByName: job.requested_by_name ?? null,
    target: jobTarget(job.type, job.payload),
    enqueuedAt: new Date(job.enqueued_at).toISOString(),
    finishedAt: job.finished_at ? new Date(job.finished_at).toISOString() : null,
    durationMs: durationMs(job, now),
  };
}

// Admin observability (td-eb9e1d MVP, plan §9). 404 — not 403 — for
// non-admins: the page's existence is nobody else's business.
export const load: PageServerLoad = async ({ locals }) => {
  if (locals.user?.role !== "admin") throw error(404, "Not found");
  const now = new Date();

  const [
    worker,
    historyRes,
    startupsRes,
    jobs,
    attemptsRes,
    cacheRes,
    taxonomyRes,
    gallerySource,
  ] = await Promise.all([
    workerHealth(),
    query<{
      id: number;
      at: string;
      pid: number | null;
      version: string | null;
      state: string;
      current_job_id: number | null;
      note: string | null;
    }>(
      `SELECT id, at, pid, version, state, current_job_id, note
         FROM worker_status_history ORDER BY id DESC LIMIT 25`,
    ),
    // Crash-loop detector: startups in the last hour (plan §9 — >3 is a banner).
    query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM worker_status_history
        WHERE note = 'startup' AND at > NOW() - interval '1 hour'`,
    ),
    listJobs(50),
    query<{
      loc_code: string;
      loc_kind: string | null;
      loc_name: string | null;
      region_code: string | null;
      status: string;
      error: string | null;
      last_attempt_at: string;
    }>(
      `SELECT loc_code, loc_kind, loc_name, region_code, status, error, last_attempt_at
         FROM frequency_fetch_attempts ORDER BY last_attempt_at DESC LIMIT 50`,
    ),
    query<{ ns: string; n: number; oldest: string; newest: string }>(
      `SELECT split_part(cache_key, ':', 1) AS ns, COUNT(*)::int AS n,
              MIN(fetched_at) AS oldest, MAX(fetched_at) AS newest
         FROM ebird_cache GROUP BY 1 ORDER BY n DESC`,
    ),
    query<{ n: number; newest: string | null }>(
      `SELECT COUNT(*)::int AS n, MAX(fetched_at) AS newest FROM taxonomy_cache`,
    ),
    galleryHealth(),
  ]);

  return {
    now: now.toISOString(),
    worker: {
      alive: worker.alive,
      state: worker.state,
      pid: worker.pid,
      version: worker.version,
      startedAt: worker.startedAt?.toISOString() ?? null,
      heartbeatAt: worker.heartbeatAt?.toISOString() ?? null,
      currentJobId: worker.currentJobId,
    },
    workerHistory: historyRes.rows,
    startupsLastHour: startupsRes.rows[0]?.n ?? 0,
    jobs: jobs.map((j) => decorate(j, now)),
    attempts: attemptsRes.rows,
    cacheStats: cacheRes.rows,
    taxonomy: taxonomyRes.rows[0] ?? { n: 0, newest: null },
    gallerySource,
  };
};

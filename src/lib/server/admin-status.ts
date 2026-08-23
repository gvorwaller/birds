import { listJobs, workerHealth } from "$server/jobs";
import {
  displayName,
  durationMs,
  isScheduledSingleton,
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
  scheduled: boolean;
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

export interface AdminWorker {
  alive: boolean;
  state: string | null;
  pid: number | null;
  version: string | null;
  startedAt: string | null;
  heartbeatAt: string | null;
  currentJobId: number | null;
}

export interface AdminLiveStatus {
  now: string;
  worker: AdminWorker;
  jobs: AdminJob[];
}

export function decorateAdminJob(job: JobRow, now: Date): AdminJob {
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
    scheduled: isScheduledSingleton(job, now),
    cancelRequested: job.cancel_requested,
    progress: job.progress,
    result: job.result,
    error: job.error,
    requestedByName: job.requested_by_name ?? null,
    target: jobTarget(job.type, job.payload),
    enqueuedAt: new Date(job.enqueued_at).toISOString(),
    finishedAt: job.finished_at
      ? new Date(job.finished_at).toISOString()
      : null,
    durationMs: durationMs(job, now),
  };
}

/** Lightweight Admin data used by the active-job poll and the full page load. */
export async function adminLiveStatus(): Promise<AdminLiveStatus> {
  const now = new Date();
  const [worker, jobs] = await Promise.all([workerHealth(), listJobs(50)]);

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
    jobs: jobs.map((job) => decorateAdminJob(job, now)),
  };
}

/**
 * Server health (td-7739c2): memory samples for the admin page.
 *
 * Each app process (web, worker) records a sample when it starts and every
 * SAMPLE_INTERVAL_MS after. A new `started_at` is a new run, so the samples
 * also answer "did it restart, when, and how high did memory get first"
 * without reading PM2's logs over SSH. Read-only for everyone else; the
 * worker's prune job keeps 7 days.
 */
import { getHeapStatistics } from "node:v8";
import { queryTimed } from "$lib/db";

export type ProcessName = "web" | "worker";
export const SAMPLE_INTERVAL_MS = 5 * 60 * 1000;
export const SAMPLE_RETENTION_DAYS = 7;
/** One peak-preserving point per interval keeps each 640px chart bounded. */
export const CHART_BUCKET_MS = 15 * 60 * 1000;
const SAMPLE_WRITE_TIMEOUT_MS = 2_000;
const HEALTH_READ_TIMEOUT_MS = 3_000;
/** PM2's max_memory_restart per process (ecosystem.config.cjs). */
export const RESTART_LIMIT_MB: Record<ProcessName, number> = {
  web: 1024,
  worker: 300,
};

const mb = (bytes: number) => Math.round(bytes / (1024 * 1024));
const processStartedAt = new Date(
  Date.now() - Math.round(process.uptime() * 1000),
);

export interface MemoryNow {
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  heapLimitMb: number;
}

export function memoryNow(): MemoryNow {
  const m = process.memoryUsage();
  return {
    rssMb: mb(m.rss),
    heapUsedMb: mb(m.heapUsed),
    heapTotalMb: mb(m.heapTotal),
    externalMb: mb(m.external),
    heapLimitMb: mb(getHeapStatistics().heap_size_limit),
  };
}

export async function recordMemorySample(
  name: ProcessName,
  endReason?: "graceful shutdown",
): Promise<void> {
  const m = memoryNow();
  await queryTimed(
    `INSERT INTO process_memory_samples
       (process, pid, started_at, rss_mb, heap_used_mb, heap_total_mb, external_mb,
        heap_limit_mb, ended_at, end_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
             CASE WHEN $9::text IS NULL THEN NULL ELSE clock_timestamp() END, $9)`,
    [
      name,
      process.pid,
      processStartedAt,
      m.rssMb,
      m.heapUsedMb,
      m.heapTotalMb,
      m.externalMb,
      m.heapLimitMb,
      endReason ?? null,
    ],
    SAMPLE_WRITE_TIMEOUT_MS,
  );
}

export interface NonOverlappingSampler {
  run(): void;
}

/** A stalled pool/query may span several ticks. Skip those ticks rather than
 * accumulating an unbounded queue of observability writes behind the outage. */
export function createNonOverlappingSampler(
  record: () => Promise<void>,
  onError: (error: unknown) => void,
): NonOverlappingSampler {
  let inFlight = false;
  return {
    run() {
      if (inFlight) return;
      inFlight = true;
      void record()
        .catch(onError)
        .finally(() => {
          inFlight = false;
        });
    },
  };
}

const samplerGlobal = globalThis as typeof globalThis & {
  __birdsProcessMemorySampler?: {
    name: ProcessName;
    timer: ReturnType<typeof setInterval>;
  };
};

/** Start sampling for this process (once). Failures are logged, never thrown:
 * health reporting must not take the app down. */
export function startMemorySampler(name: ProcessName): void {
  // globalThis survives dev/HMR module re-evaluation; module-local state does
  // not, and would create duplicate timers and duplicate rows.
  if (samplerGlobal.__birdsProcessMemorySampler) return;
  const runner = createNonOverlappingSampler(
    () => recordMemorySample(name),
    (err) =>
      console.error(
        `[process-health] ${name} sample failed:`,
        err instanceof Error ? err.message : err,
      ),
  );
  runner.run();
  const timer = setInterval(() => runner.run(), SAMPLE_INTERVAL_MS);
  timer.unref();
  samplerGlobal.__birdsProcessMemorySampler = { name, timer };
}

export interface ProcessRun {
  process: ProcessName;
  pid: number;
  startedAt: string;
  lastSampleAt: string;
  peakRssMb: number;
  lastRssMb: number;
  samples: number;
  endedAt: string | null;
  endReason: "graceful shutdown" | null;
}

export interface MemoryPoint {
  process: ProcessName;
  at: string;
  rssMb: number;
  heapUsedMb: number;
}

export interface ServerHealth {
  now: string;
  web: MemoryNow & { pid: number; startedAt: string; uptimeSeconds: number };
  worker:
    | (MemoryPoint & {
        pid: number;
        heapLimitMb: number;
        startedAt: string;
        endedAt: string | null;
        endReason: "graceful shutdown" | null;
      })
    | null;
  limits: Record<ProcessName, number>;
  runs: ProcessRun[];
  history: MemoryPoint[];
  sampleIntervalMinutes: number;
  retentionDays: number;
}

interface MemorySampleRow {
  process: ProcessName;
  pid: number;
  started_at: Date | string;
  sampled_at: Date | string;
  rss_mb: number;
  heap_used_mb: number;
  heap_limit_mb: number;
  ended_at: Date | string | null;
  end_reason: "graceful shutdown" | null;
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/** Everything the admin Server health tab shows. One bounded table read. */
export async function serverHealth(): Promise<ServerHealth> {
  const samplesRes = await queryTimed<MemorySampleRow>(
    `SELECT process, pid, started_at, sampled_at, rss_mb, heap_used_mb,
            heap_limit_mb, ended_at, end_reason
       FROM process_memory_samples
      WHERE sampled_at > NOW() - make_interval(days => $1)
      ORDER BY sampled_at`,
    [SAMPLE_RETENTION_DAYS],
    HEALTH_READ_TIMEOUT_MS,
  );
  const rows = samplesRes.rows.map((row) => ({
    ...row,
    startedAt: iso(row.started_at),
    sampledAt: iso(row.sampled_at),
    endedAt: row.ended_at == null ? null : iso(row.ended_at),
  }));

  const runsByKey = new Map<string, ProcessRun>();
  const chartByBucket = new Map<string, MemoryPoint>();
  let workerRow: (typeof rows)[number] | undefined;
  for (const row of rows) {
    const runKey = `${row.process}:${row.pid}:${row.startedAt}`;
    const run = runsByKey.get(runKey);
    if (run) {
      run.lastSampleAt = row.sampledAt;
      run.lastRssMb = row.rss_mb;
      run.peakRssMb = Math.max(run.peakRssMb, row.rss_mb);
      run.samples += 1;
      if (row.end_reason) {
        run.endedAt = row.endedAt;
        run.endReason = row.end_reason;
      }
    } else {
      runsByKey.set(runKey, {
        process: row.process,
        pid: row.pid,
        startedAt: row.startedAt,
        lastSampleAt: row.sampledAt,
        peakRssMb: row.rss_mb,
        lastRssMb: row.rss_mb,
        samples: 1,
        endedAt: row.endedAt,
        endReason: row.end_reason,
      });
    }

    // Keep the highest-RSS sample in each chart bucket so downsampling cannot
    // erase the spike an operator is looking for.
    const bucket = Math.floor(
      new Date(row.sampledAt).getTime() / CHART_BUCKET_MS,
    );
    const bucketKey = `${row.process}:${bucket}`;
    const current = chartByBucket.get(bucketKey);
    if (!current || row.rss_mb >= current.rssMb) {
      chartByBucket.set(bucketKey, {
        process: row.process,
        at: row.sampledAt,
        rssMb: row.rss_mb,
        heapUsedMb: row.heap_used_mb,
      });
    }
    if (row.process === "worker") workerRow = row;
  }

  const w = workerRow;
  return {
    now: new Date().toISOString(),
    web: {
      ...memoryNow(),
      pid: process.pid,
      startedAt: processStartedAt.toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
    },
    worker: w
      ? {
          process: "worker",
          pid: w.pid,
          at: w.sampledAt,
          rssMb: w.rss_mb,
          heapUsedMb: w.heap_used_mb,
          heapLimitMb: w.heap_limit_mb,
          startedAt: w.startedAt,
          endedAt: w.endedAt,
          endReason: w.end_reason,
        }
      : null,
    limits: RESTART_LIMIT_MB,
    runs: [...runsByKey.values()].sort((a, b) =>
      b.startedAt.localeCompare(a.startedAt),
    ),
    history: [...chartByBucket.values()].sort((a, b) =>
      a.at.localeCompare(b.at),
    ),
    sampleIntervalMinutes: SAMPLE_INTERVAL_MS / 60000,
    retentionDays: SAMPLE_RETENTION_DAYS,
  };
}

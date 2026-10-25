/**
 * Server freezes (td-b07462, under td-c4a58d): the web process notices when
 * it stopped responding and records what was running.
 *
 * Node runs every request's JavaScript on one thread. When something holds
 * that thread (a big JSON parse, a loop over 186k hotspots, a long garbage
 * collection), every other request waits, and Slow pages then blames each of
 * them for time they spent stuck behind it (10-24 22:31 EDT: seven hub-search
 * rows, 0.2 s of database each, 12–14 s total). A timer that should fire
 * every TICK_MS measures, on the monotonic clock, how late it fires;
 * FREEZE_MIN_MS late or more is a freeze. Each one is stored with:
 * - the requests already running when it began (they may have caused it, or
 *   paused through it), counted in full, the oldest MAX_LISTED listed;
 * - the requests that started while it lasted;
 * - named heavy operations that overlapped it (trackBusy);
 * - garbage-collection pause time inside it;
 * - memory and the deploy.
 *
 * Work that ends the moment the freeze ends (the blocking loop finishing,
 * then its request completing) is gone before the late timer runs, so ended
 * requests and operations are kept for RECENT_KEEP_MS, and a freeze is
 * written one tick after it is noticed, once late GC timings have arrived.
 *
 * Detection costs one timer callback every TICK_MS and a sweep every
 * SWEEP_EVERY_MS. Writes are fire-and-forget, capped per hour, and never
 * block a request.
 */
import { PerformanceObserver, performance } from "node:perf_hooks";
import { queryTimed } from "$lib/db";

export const TICK_MS = 100;
export const FREEZE_MIN_MS = 1_000;
export const SERVER_FREEZES_RETENTION_DAYS = 30;
export const MAX_LISTED = 10;
/** Ended requests and operations are kept this long, so a freeze noticed late still sees them. */
export const RECENT_KEEP_MS = 120_000;
const RECENT_MAX = 5_000;
/** A request older than this is taken as abandoned (its body was never read, e.g. replaced by a 304) and dropped. */
export const IN_FLIGHT_MAX_AGE_MS = 10 * 60_000;
const IN_FLIGHT_MAX = 5_000;
export const SWEEP_EVERY_MS = 60_000;
export const MAX_FREEZES_PER_HOUR = 60;
const GC_BUCKET_MS = 10;
const WRITE_TIMEOUT_MS = 3_000;
const REPORT_TIMEOUT_MS = 3_000;

const ROUTE_ID = /^\/[A-Za-z0-9_[\]()/.=-]*$/;

export interface ListedRequest {
  route: string;
  method: string;
  /** How long it had been running when the freeze began. */
  ranBeforeMs: number;
}

export interface FreezeRecord {
  startedAt: number;
  durationMs: number;
  /** Requests already running when it began, oldest first, at most MAX_LISTED. */
  runningList: ListedRequest[];
  runningBefore: number;
  arrivedDuring: number;
  busy: string[];
  gcMs: number;
  rssMb: number;
  heapMb: number;
  version: string;
}

interface Span {
  kind: "request" | "busy";
  label: string;
  method: string;
  /** Monotonic ms. */
  start: number;
  end: number | null;
}

/** The monotonic clock spans use (tests swap it). */
let mono: () => number = () => performance.now();
let nextId = 0;
const active = new Map<number, Span>();
let recent: Span[] = [];
/** GC pause ms by GC_BUCKET_MS slot of the monotonic clock. */
const gcBuckets = new Map<number, number>();

function begin(kind: Span["kind"], label: string, method: string): () => void {
  const id = ++nextId;
  const span: Span = { kind, label, method, start: mono(), end: null };
  active.set(id, span);
  if (active.size > IN_FLIGHT_MAX) {
    const oldest = active.keys().next().value;
    if (oldest !== undefined) active.delete(oldest);
  }
  return () => {
    if (!active.delete(id)) return;
    span.end = mono();
    recent.push(span);
    if (recent.length > RECENT_MAX) recent = recent.slice(-RECENT_MAX);
  };
}

/** A request has started (hooks.server.ts). Returns the function that ends it; calling it twice is harmless. */
export function requestStarted(routeId: string | null, method: string): () => void {
  return begin("request", routeId && ROUTE_ID.test(routeId) ? routeId : "(none)", method);
}

/** Runs `fn` with `label` listed as running, so a freeze during it names it. */
export async function trackBusy<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const end = begin("busy", label, "");
  try {
    return await fn();
  } finally {
    end();
  }
}

/** Adds a GC pause (monotonic start, length) to the slot totals. */
export function addGcPause(start: number, ms: number): void {
  const end = start + ms;
  for (let b = Math.floor(start / GC_BUCKET_MS); b * GC_BUCKET_MS < end; b++) {
    const s = Math.max(start, b * GC_BUCKET_MS);
    const e = Math.min(end, (b + 1) * GC_BUCKET_MS);
    if (e > s) gcBuckets.set(b, (gcBuckets.get(b) ?? 0) + (e - s));
  }
}

/** GC pause ms inside [from, to] (monotonic), to slot resolution. */
export function gcBetween(from: number, to: number): number {
  let total = 0;
  for (let b = Math.floor(from / GC_BUCKET_MS); b * GC_BUCKET_MS < to; b++) {
    const ms = gcBuckets.get(b);
    if (!ms) continue;
    const s = Math.max(from, b * GC_BUCKET_MS);
    const e = Math.min(to, (b + 1) * GC_BUCKET_MS);
    total += ms * Math.max(0, e - s) / GC_BUCKET_MS;
  }
  return total;
}

/** What ran during [from, to] (monotonic): requests already running at `from`, those that started inside, operations overlapping it. */
export function window(from: number, to: number): Pick<FreezeRecord, "runningList" | "runningBefore" | "arrivedDuring" | "busy"> {
  const running: Span[] = [];
  let arrived = 0;
  const busy = new Set<string>();
  for (const s of [...active.values(), ...recent]) {
    const end = s.end ?? Infinity;
    if (s.kind === "busy") {
      if (s.start < to && end > from) busy.add(s.label);
    } else if (s.start <= from && end > from) {
      running.push(s);
    } else if (s.start > from && s.start < to) {
      arrived++;
    }
  }
  running.sort((a, b) => a.start - b.start);
  return {
    runningList: running.slice(0, MAX_LISTED).map((s) => ({ route: s.label, method: s.method, ranBeforeMs: Math.round(from - s.start) })),
    runningBefore: running.length,
    arrivedDuring: arrived,
    busy: [...busy],
  };
}

/** Drops abandoned requests, ended spans past RECENT_KEEP_MS and old GC slots. */
export function sweep(now = mono()): void {
  for (const [id, s] of active) if (now - s.start > IN_FLIGHT_MAX_AGE_MS) active.delete(id);
  recent = recent.filter((s) => s.end != null && now - s.end <= RECENT_KEEP_MS);
  const oldest = Math.floor((now - RECENT_KEEP_MS) / GC_BUCKET_MS);
  for (const b of gcBuckets.keys()) if (b < oldest) gcBuckets.delete(b);
}

/** For tests. */
export function freezeWatchTestState(clock?: () => number): { activeCount: () => number } {
  mono = clock ?? (() => performance.now());
  active.clear();
  recent = [];
  gcBuckets.clear();
  return { activeCount: () => active.size };
}

export interface FreezeWatchDeps {
  /** Wall clock (epoch ms), for the stored start time. */
  now: () => number;
  /** Monotonic clock (ms), for lateness: a wall-clock correction is not a freeze. */
  mono: () => number;
  memory: () => { rss: number; heapUsed: number };
  record: (f: FreezeRecord) => void;
  version: string;
}

/** The timer's logic, kept apart from the timer so tests can drive it. */
export class FreezeWatch {
  private last: number;
  private lastSweep: number;
  private hour = -1;
  private inHour = 0;
  /** Noticed on the previous tick, written on this one. */
  private pending: { from: number; to: number; startedAt: number } | null = null;

  constructor(private readonly d: FreezeWatchDeps) {
    this.last = d.mono();
    this.lastSweep = this.last;
  }

  tick(): void {
    const now = this.d.mono();
    if (this.pending) this.write(this.pending);
    this.pending = null;
    const late = Math.round(now - this.last - TICK_MS);
    const from = this.last + TICK_MS;
    this.last = now;
    if (late >= FREEZE_MIN_MS) {
      const hour = Math.floor(this.d.now() / 3_600_000);
      if (hour !== this.hour) {
        this.hour = hour;
        this.inHour = 0;
      }
      if (++this.inHour <= MAX_FREEZES_PER_HOUR) this.pending = { from, to: now, startedAt: this.d.now() - late };
    }
    if (now - this.lastSweep >= SWEEP_EVERY_MS) {
      // Keep what a freeze still waiting to be written needs.
      sweep(this.pending ? this.pending.from : now);
      this.lastSweep = now;
    }
  }

  private write(p: { from: number; to: number; startedAt: number }): void {
    const mem = this.d.memory();
    this.d.record({
      startedAt: Math.round(p.startedAt),
      durationMs: Math.round(p.to - p.from),
      ...window(p.from, p.to),
      gcMs: Math.round(gcBetween(p.from, p.to)),
      rssMb: Math.round(mem.rss / 1_048_576),
      heapMb: Math.round(mem.heapUsed / 1_048_576),
      version: this.d.version,
    });
  }
}

export async function recordFreeze(f: FreezeRecord): Promise<void> {
  await queryTimed(
    `INSERT INTO server_freezes
       (started_at, duration_ms, process, running_list, running_before, arrived_during, busy, gc_ms, rss_mb, heap_mb, version)
     VALUES (to_timestamp($1 / 1000.0), $2, 'web', $3::jsonb, $4, $5, $6, $7, $8, $9, $10)`,
    [f.startedAt, f.durationMs, JSON.stringify(f.runningList), f.runningBefore, f.arrivedDuring, f.busy, f.gcMs, f.rssMb, f.heapMb, f.version],
    WRITE_TIMEOUT_MS,
  );
}

let started = false;
/** Starts the web process's freeze watch once (hooks.server.ts; not in builds or tests). */
export function startFreezeWatch(version: string): void {
  if (started) return;
  started = true;
  try {
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) addGcPause(e.startTime, e.duration);
    });
    obs.observe({ entryTypes: ["gc"] });
  } catch { // stale-safe: web-process startup, never under a job claim; only PerformanceObserver setup is inside
    // No GC timings: freezes are still recorded, with gcMs 0.
  }
  const watch = new FreezeWatch({
    now: () => Date.now(),
    mono: () => performance.now(),
    memory: () => process.memoryUsage(),
    record: (f) => {
      console.warn(
        `[freeze] web process stopped responding for ${f.durationMs} ms; ${f.runningBefore} requests already running, ${f.arrivedDuring} started during it` +
          (f.busy.length ? `; running ${f.busy.join(", ")}` : "") +
          (f.gcMs ? `; GC ${f.gcMs} ms` : ""),
      );
      void recordFreeze(f).catch((err) => console.error("[freeze] write failed:", err instanceof Error ? err.message : err));
    },
    version,
  });
  setInterval(() => watch.tick(), TICK_MS).unref();
}

export interface FreezeRow {
  startedAt: string;
  durationMs: number;
  runningList: ListedRequest[];
  runningBefore: number;
  arrivedDuring: number;
  busy: string[];
  gcMs: number;
  rssMb: number;
  heapMb: number;
  version: string;
}

export interface ServerFreezesReport {
  thresholdMs: number;
  /** Last 7 days. */
  count: number;
  totalMs: number;
  worstMs: number;
  recent: FreezeRow[];
  retentionDays: number;
}

export async function serverFreezesReport(): Promise<ServerFreezesReport> {
  const [summary, rows] = await Promise.all([
    queryTimed<{ count: number; total: number | null; worst: number | null }>(
      `SELECT COUNT(*)::int AS count, SUM(duration_ms)::int AS total, MAX(duration_ms) AS worst
         FROM server_freezes WHERE started_at > NOW() - interval '7 days'`,
      [],
      REPORT_TIMEOUT_MS,
    ),
    queryTimed<{
      started_at: Date;
      duration_ms: number;
      running_list: ListedRequest[];
      running_before: number;
      arrived_during: number;
      busy: string[];
      gc_ms: number;
      rss_mb: number;
      heap_mb: number;
      version: string;
    }>(
      `SELECT started_at, duration_ms, running_list, running_before, arrived_during, busy, gc_ms, rss_mb, heap_mb, version
         FROM server_freezes ORDER BY started_at DESC, id DESC LIMIT 30`,
      [],
      REPORT_TIMEOUT_MS,
    ),
  ]);
  const s = summary.rows[0];
  return {
    thresholdMs: FREEZE_MIN_MS,
    count: s.count,
    totalMs: s.total ?? 0,
    worstMs: s.worst ?? 0,
    recent: rows.rows.map((r) => ({
      startedAt: r.started_at.toISOString(),
      durationMs: r.duration_ms,
      runningList: r.running_list,
      runningBefore: r.running_before,
      arrivedDuring: r.arrived_during,
      busy: r.busy,
      gcMs: r.gc_ms,
      rssMb: r.rss_mb,
      heapMb: r.heap_mb,
      version: r.version,
    })),
    retentionDays: SERVER_FREEZES_RETENTION_DAYS,
  };
}

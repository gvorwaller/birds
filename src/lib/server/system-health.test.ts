/**
 * Server health system cards (td-a47c0d). The queue test owns every row it
 * writes: a disposable admin account and jobs created by it, deleted exactly
 * by id. Counts are compared as before/after deltas, so the corpus's own jobs
 * never matter.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const statfsFail = vi.hoisted(() => ({ on: false, hang: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    statfs: (...args: Parameters<typeof real.statfs>) =>
      statfsFail.hang
        ? new Promise<never>(() => {})
        : statfsFail.on
          ? Promise.reject(new Error("EACCES: fixture"))
          : real.statfs(...args),
  };
});

import { query } from "$lib/db";
import { enrichmentCoverage } from "$server/species-enrichment";
import {
  card,
  cardFailure,
  coverageSummary,
  jobQueueSummary,
  postgresSummary,
  queueRows,
  systemHealth,
  tableStats,
  type QueueRow,
  type QueueSqlRow,
} from "$server/system-health";

const dbUp = await query("SELECT 1")
  .then(() => true)
  .catch(() => false);

function sqlRow(over: Partial<QueueSqlRow>): QueueSqlRow {
  return {
    type: "load_region",
    ai_only: false,
    pending: 0,
    scheduled: 0,
    running: 0,
    failed_24h: 0,
    failed_7d: 0,
    cancelled_7d: 0,
    cancelled_undated: 0,
    succeeded_7d: 0,
    last_succeeded_at: null,
    next_run_at: null,
    median_ms: null,
    worst_ms: null,
    ...over,
  };
}

describe("queueRows", () => {
  it("names AI-only species chunks apart from species data", () => {
    const rows = queueRows([
      sqlRow({ type: "enrich_species", ai_only: true }),
      sqlRow({ type: "enrich_species", ai_only: false }),
    ]);
    expect(rows.map((r) => r.name).sort()).toEqual(["Species data", "Species notes (AI)"].sort());
  });

  it("gives a next run only to recurring types", () => {
    const at = "2026-10-17T15:00:00.000Z";
    const [scan, load] = queueRows([
      sqlRow({ type: "scan_enrichment", pending: 1, next_run_at: at }),
      sqlRow({ type: "load_region", pending: 1, next_run_at: at }),
    ]).sort((a, b) => a.type.localeCompare(b.type)).reverse();
    expect(scan).toMatchObject({ type: "scan_enrichment", recurring: true, nextRunAt: at });
    expect(load).toMatchObject({ type: "load_region", recurring: false, nextRunAt: null });
  });

  it("lists work in progress first, then failures, then by name", () => {
    const rows = queueRows([
      sqlRow({ type: "sync_taxonomy" }),
      sqlRow({ type: "load_hotspots", failed_7d: 3 }),
      sqlRow({ type: "refresh_loc", running: 1 }),
      sqlRow({ type: "load_region" }),
    ]);
    expect(rows.map((r) => r.type)).toEqual(["refresh_loc", "load_hotspots", "load_region", "sync_taxonomy"]);
  });

  it("rounds durations and keeps unknown ones unknown", () => {
    const [r] = queueRows([sqlRow({ median_ms: 1234.6, worst_ms: null })]);
    expect(r.medianMs).toBe(1235);
    expect(r.worstMs).toBeNull();
  });
});

describe("cardFailure", () => {
  it("says a timed-out card timed out", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(cardFailure("queue", new Error("Query read timeout"))).toEqual({
      ok: false,
      reason: "Timed out after 3 s.",
    });
    expect(cardFailure("queue", new Error("queryTimed: pool acquisition exceeded 3000ms")).reason).toBe(
      "Timed out after 3 s.",
    );
    spy.mockRestore();
  });

  it("redacts secrets the shared sanitizer knows about", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = cardFailure("worker", new Error("login failed password=abc123secret"));
    expect(r.reason).not.toContain("abc123secret");
    expect(spy).toHaveBeenCalled();
    expect(JSON.stringify(spy.mock.calls)).not.toContain("abc123secret");
    spy.mockRestore();
  });

  it("keeps other reasons short", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = cardFailure("tables", new Error(`permission denied ${"x".repeat(400)}`));
    expect(r.reason.startsWith("Could not be read: permission denied")).toBe(true);
    expect(r.reason.length).toBeLessThanOrEqual("Could not be read: ".length + 160);
    spy.mockRestore();
  });
});

describe("card deadline", () => {
  it("times out a read that never settles", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const started = Date.now();
    const r = await card("worker", () => new Promise<never>(() => {}), 50);
    expect(r).toEqual({ ok: false, reason: "Timed out after 3 s." });
    expect(Date.now() - started).toBeLessThan(1_000);
    spy.mockRestore();
  });
});

describe.skipIf(!dbUp)("system cards against birds_test", () => {
  let userId: number;
  const jobIds: number[] = [];
  const username = `syshealth-fixture-${crypto.randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    const u = await query<{ id: number }>(
      `INSERT INTO users (username, display_name, password_hash, role)
       VALUES ($1, 'System health fixture', 'x', 'admin') RETURNING id`,
      [username],
    );
    userId = u.rows[0].id;
  });

  afterAll(async () => {
    if (!dbUp) return;
    if (jobIds.length) await query(`DELETE FROM jobs WHERE id = ANY($1::bigint[])`, [jobIds]);
    if (userId) await query(`DELETE FROM users WHERE id = $1`, [userId]);
    const left = await query<{ n: number }>(
      `SELECT (SELECT COUNT(*) FROM jobs WHERE id = ANY($1::bigint[]))::int
            + (SELECT COUNT(*) FROM users WHERE username = $2)::int AS n`,
      [jobIds, username],
    );
    expect(left.rows[0].n).toBe(0);
  });

  async function job(
    type: string,
    status: string,
    opts: {
      finishedAgo?: string;
      ranSeconds?: number;
      payload?: object;
      /** e.g. '+1 hour' or '-5 minutes', relative to now. */
      nextRetry?: string;
      progress?: object;
      undated?: boolean;
    } = {},
  ): Promise<void> {
    const r = await query<{ id: string }>(
      `INSERT INTO jobs (type, payload, status, requested_by, label, started_at, finished_at,
                         next_retry_at, progress)
       VALUES ($1, $2::jsonb, $3, $4, 'system-health fixture',
               CASE WHEN $5::interval IS NULL THEN
                      CASE WHEN $3 = 'running' THEN NOW() END
                    ELSE NOW() - $5::interval - make_interval(secs => $6) END,
               CASE WHEN $5::interval IS NULL OR $9 THEN NULL ELSE NOW() - $5::interval END,
               CASE WHEN $7::interval IS NULL THEN NULL ELSE NOW() + $7::interval END,
               $8::jsonb)
       RETURNING id::text`,
      [
        type,
        JSON.stringify(opts.payload ?? {}),
        status,
        userId,
        opts.finishedAgo ?? null,
        opts.ranSeconds ?? 0,
        opts.nextRetry ?? null,
        JSON.stringify(opts.progress ?? {}),
        opts.undated ?? false,
      ],
    );
    jobIds.push(Number(r.rows[0].id));
  }

  const find = (rows: QueueRow[], type: string, aiOnly = false) =>
    rows.find((r) => r.type === type && r.aiOnly === aiOnly);
  const zero = {
    pending: 0,
    scheduled: 0,
    running: 0,
    failed24h: 0,
    failed7d: 0,
    cancelled7d: 0,
    cancelledUndated: 0,
    succeeded7d: 0,
  };

  it("counts jobs exactly by type and status", async () => {
    const before = await jobQueueSummary();
    const b = find(before.rows, "retry_loc") ?? { ...zero, medianMs: null };
    const bAi = find(before.rows, "enrich_species", true) ?? zero;
    const bData = find(before.rows, "enrich_species", false) ?? zero;

    await job("retry_loc", "pending");
    await job("retry_loc", "running");
    await job("retry_loc", "failed", { finishedAgo: "1 hour" });
    await job("retry_loc", "failed", { finishedAgo: "3 days" });
    await job("retry_loc", "failed", { finishedAgo: "10 days" });
    await job("retry_loc", "cancelled", { finishedAgo: "2 days" });
    await job("retry_loc", "cancelled", { finishedAgo: "200 days", undated: true });
    await job("retry_loc", "succeeded", { finishedAgo: "2 hours", ranSeconds: 10 });
    await job("retry_loc", "succeeded", { finishedAgo: "1 hour", ranSeconds: 30 });
    await job("enrich_species", "pending", { payload: { aiOnly: true } });
    // Absent aiOnly and explicit false are the same Species data group.
    await job("enrich_species", "pending", { payload: {} });
    await job("enrich_species", "pending", { payload: { aiOnly: false } });

    const after = await jobQueueSummary();
    expect(after.retentionDays).toBe(90);
    const a = find(after.rows, "retry_loc")!;
    expect(a.pending - b.pending).toBe(1);
    expect(a.running - b.running).toBe(1);
    expect(a.failed24h - b.failed24h).toBe(1);
    expect(a.failed7d - b.failed7d).toBe(2);
    expect(a.cancelled7d - b.cancelled7d).toBe(1);
    expect(a.cancelledUndated - b.cancelledUndated).toBe(1);
    expect(a.succeeded7d - b.succeeded7d).toBe(2);
    expect(Date.now() - Date.parse(a.lastSucceededAt!)).toBeLessThan(2 * 3600_000);
    if (b.succeeded7d === 0) {
      expect(a.medianMs).toBe(20_000);
      expect(a.worstMs).toBe(30_000);
    }
    const ai = find(after.rows, "enrich_species", true)!;
    expect(ai.name).toBe("Species notes (AI)");
    expect(ai.pending - bAi.pending).toBe(1);
    expect(after.rows.filter((r) => r.type === "enrich_species" && !r.aiOnly)).toHaveLength(1);
    expect(find(after.rows, "enrich_species", false)!.pending - bData.pending).toBe(2);
    for (const r of after.rows) expect(typeof r.aiOnly).toBe("boolean");
  });

  it("counts a parked recurring check as scheduled and a due, unscheduled or retrying one as waiting", async () => {
    const before = await jobQueueSummary();
    const b = find(before.rows, "tag_consistency") ?? { ...zero, nextRunAt: null };

    await job("tag_consistency", "pending", { nextRetry: "2 hours" }); // parked
    await job("tag_consistency", "pending", { nextRetry: "-5 minutes" }); // overdue
    await job("tag_consistency", "pending"); // NULL next_retry_at
    await job("tag_consistency", "pending", { nextRetry: "1 hour", progress: { phase: "waiting_retry" } });

    const a = find((await jobQueueSummary()).rows, "tag_consistency")!;
    expect(a.scheduled - b.scheduled).toBe(1);
    expect(a.pending - b.pending).toBe(3);
    // The next run is the parked row's, never the retry's or the overdue one's.
    if (b.scheduled === 0) {
      const inMs = Date.parse(a.nextRunAt!) - Date.now();
      expect(inMs > 100 * 60_000 && inMs <= 120 * 60_000).toBe(true);
    }
  });

  it("reads Postgres size, settings and stats-reset honestly", async () => {
    const p = await postgresSummary();
    expect(p.databaseBytes).toBeGreaterThan(0);
    expect(p.settings.map((s) => s.name)).toEqual([
      "shared_buffers",
      "work_mem",
      "effective_cache_size",
      "max_parallel_workers_per_gather",
    ]);
    for (const s of p.settings) expect(s.value).not.toBe("");
    for (const v of [p.heapHitPct, p.indexHitPct]) {
      if (v != null) expect(v >= 0 && v <= 100).toBe(true);
    }
    if (p.statsResetAt != null) expect(Number.isNaN(Date.parse(p.statsResetAt))).toBe(false);
  });

  it("lists every table, largest first", async () => {
    const t = await tableStats();
    expect(t.map((r) => r.name)).toContain("jobs");
    for (let i = 1; i < t.length; i++) expect(t[i - 1].totalBytes).toBeGreaterThanOrEqual(t[i].totalBytes);
    for (const r of t) if (r.rowsEstimate != null) expect(r.rowsEstimate).toBeGreaterThanOrEqual(0);
  });

  it("counts every loaded region as exactly one of country, state or county", async () => {
    const [c, regions] = await Promise.all([
      coverageSummary(),
      query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM frequency_fetch WHERE loc_kind = 'region'`),
    ]);
    expect(c.countries + c.states + c.counties).toBe(regions.rows[0].n);
    // The same reading the enrichment preflight shows, not a second derivation.
    expect(c.enrichment).toEqual(await enrichmentCoverage());
  });

  it("shows one failed card as unavailable while the rest still read", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    statfsFail.on = true;
    try {
      const h = await systemHealth();
      expect(h.disk).toEqual({ ok: false, reason: "Could not be read: EACCES: fixture" });
      for (const c of [h.worker, h.queue, h.postgres, h.tables, h.coverage]) expect(c.ok).toBe(true);
    } finally {
      statfsFail.on = false;
      spy.mockRestore();
    }
    const ok = await systemHealth();
    expect(ok.disk.ok && ok.disk.data.totalBytes > 0).toBe(true);
  });

  it("answers with every other card when one read never settles", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    statfsFail.hang = true;
    try {
      const h = await systemHealth();
      expect(h.disk).toEqual({ ok: false, reason: "Timed out after 3 s." });
      for (const c of [h.worker, h.queue, h.postgres, h.tables, h.coverage]) expect(c.ok).toBe(true);
    } finally {
      statfsFail.hang = false;
      spy.mockRestore();
    }
  }, 10_000);
});

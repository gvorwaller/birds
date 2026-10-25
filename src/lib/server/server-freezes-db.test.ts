/**
 * Server freezes (td-b07462) against birds_test. Every row this file writes
 * carries a fixture version (server_freezes) or a fixture route (page_timing)
 * unique to the run, deleted exactly by it.
 */
import { afterAll, describe, expect, it } from "vitest";
import { query } from "$lib/db";
import { pruneHistory } from "$server/jobs";
import { pageTimingReport, recordSlowRequest } from "$server/page-timing";
import { newTimingBag } from "$server/request-timing";
import { recordFreeze, serverFreezesReport } from "$server/freeze-watch";

const dbUp = await query("SELECT 1")
  .then(() => true)
  .catch(() => false);

const tag = Math.random().toString(36).replace(/[^a-z]/g, "").slice(0, 8);
const VERSION = `zzfrz${tag}`;
const ROUTE = `/zzfreeze_${tag}/search`;

describe.skipIf(!dbUp)("server_freezes on birds_test", () => {
  afterAll(async () => {
    await query(`DELETE FROM server_freezes WHERE version = $1`, [VERSION]);
    await query(`DELETE FROM page_timing WHERE route = $1`, [ROUTE]);
    const left = await query<{ n: number }>(
      `SELECT (SELECT COUNT(*) FROM server_freezes WHERE version = $1) + (SELECT COUNT(*) FROM page_timing WHERE route = $2) AS n`,
      [VERSION, ROUTE],
    );
    expect(Number(left.rows[0].n)).toBe(0);
  });

  it("stores a freeze and reports it with a 7-day summary", async () => {
    const startedAt = Date.now() - 60 * 60_000;
    await recordFreeze({
      startedAt,
      durationMs: 12_400,
      runningList: [{ route: "/api/hub-search", method: "GET", ranBeforeMs: 2_100 }],
      runningBefore: 7,
      arrivedDuring: 0,
      busy: ["hotspot search index rebuild"],
      gcMs: 180,
      rssMb: 401,
      heapMb: 163,
      version: VERSION,
    });
    const report = await serverFreezesReport();
    const mine = report.recent.find((r) => r.version === VERSION);
    expect(mine).toEqual({
      startedAt: new Date(startedAt).toISOString(),
      durationMs: 12_400,
      runningList: [{ route: "/api/hub-search", method: "GET", ranBeforeMs: 2_100 }],
      runningBefore: 7,
      arrivedDuring: 0,
      busy: ["hotspot search index rebuild"],
      gcMs: 180,
      rssMb: 401,
      heapMb: 163,
      version: VERSION,
    });
    expect(report.count).toBeGreaterThanOrEqual(1);
    expect(report.worstMs).toBeGreaterThanOrEqual(12_400);
    expect(report).toMatchObject({ thresholdMs: 1_000, retentionDays: 30 });
  });

  it("marks a slow request that overlapped a freeze, and counts it per page; one that did not is unmarked", async () => {
    // The freeze above ran from 60 min ago for 12.4 s. One request spanned it; one finished before it.
    await query(
      `INSERT INTO page_timing (at, route, method, status, shell_ms, total_ms, bytes, tags,
         db_n, db_ms, ebird_n, ebird_ms, google_n, google_ms, ai_n, ai_ms, rss_mb, heap_mb, version)
       VALUES (NOW() - interval '60 minutes' + interval '13 seconds', $1, 'GET', 200, 14000, 14500, 1000, NULL,
               1, 210, 0, 0, 0, 0, 0, 0, 400, 160, $2),
              (NOW() - interval '61 minutes', $1, 'GET', 200, 900, 1200, 1000, NULL,
               1, 210, 0, 0, 0, 0, 0, 0, 400, 160, $2)`,
      [ROUTE, VERSION],
    );
    const report = await pageTimingReport(750, VERSION);
    const rows = report.recent.filter((r) => r.route === ROUTE);
    expect(rows.map((r) => r.freezeMs)).toEqual([12_400, null]);
    expect(report.routes.find((r) => r.route === ROUTE)).toMatchObject({ count: 2, frozenCount: 1 });
  });

  it("places a slow request by when it finished, not when its row was written", async () => {
    // A request that finished before the freeze began (its write could have waited for a connection).
    const bag = newTimingBag();
    const freezeStart = Date.now() - 60 * 60_000;
    await recordSlowRequest({
      routeId: ROUTE,
      method: "GET",
      status: 200,
      shellMs: 800,
      totalMs: 900,
      bytes: 1000,
      tags: null,
      bag,
      rssBytes: 1,
      heapBytes: 1,
      version: VERSION,
      finishedAt: freezeStart - 100,
    });
    const r = await query<{ at: Date }>(`SELECT at FROM page_timing WHERE route = $1 AND total_ms = 900`, [ROUTE]);
    expect(r.rows[0].at.getTime()).toBe(freezeStart - 100);
    const report = await pageTimingReport(750, VERSION);
    expect(report.recent.find((x) => x.route === ROUTE && x.totalMs === 900)?.freezeMs).toBeNull();
  });

  it("prunes freezes older than 30 days", async () => {
    const r = await query<{ id: number }>(
      `INSERT INTO server_freezes (started_at, duration_ms, process, running_before, arrived_during, gc_ms, rss_mb, heap_mb, version)
       VALUES (NOW() - interval '31 days', 1500, 'web', 0, 0, 0, 300, 100, $1) RETURNING id`,
      [VERSION],
    );
    const id = Number(r.rows[0].id);
    await pruneHistory({ serverFreezeIds: [id] });
    const left = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM server_freezes WHERE id = $1`, [id]);
    expect(left.rows[0].n).toBe(0);
  });
});

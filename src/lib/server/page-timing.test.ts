/**
 * Performance panel (td-67b481). Every row this file writes uses a route id
 * unique to the run (and a fixture version), deleted exactly by that route.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { query } from "$lib/db";
import { pruneHistory } from "$server/jobs";
import { MAX_WRITES_IN_FLIGHT, pageTimingReport, recordSlowRequest, type SlowRequest } from "$server/page-timing";
import { newTimingBag } from "$server/request-timing";

const dbUp = await query("SELECT 1")
  .then(() => true)
  .catch(() => false);

const tag = Math.random().toString(36).replace(/[^a-z]/g, "").slice(0, 8);
const ROUTE = `/zzfixture_${tag}/[code]`;
const ROUTE_B = `/zzfixture_${tag}/other`;
const VERSION_A = `zzfixa${tag}`;
const VERSION_B = `zzfixb${tag}`;

function slow(over: Partial<SlowRequest> = {}): SlowRequest {
  const bag = newTimingBag();
  bag.buckets.db = { n: 3, ms: 120.4 };
  bag.buckets.ebird = { n: 1, ms: 900.6 };
  return {
    routeId: ROUTE,
    method: "GET",
    status: 200,
    shellMs: 400,
    totalMs: 1200,
    bytes: 52_000,
    tags: 2400,
    bag,
    rssBytes: 500 * 1024 * 1024,
    heapBytes: 150 * 1024 * 1024,
    version: VERSION_A,
    ...over,
  };
}

/** Insert a row at a chosen time (the report windows are by `at`). */
async function rowAt(daysAgo: number, totalMs: number, route = ROUTE, version = VERSION_A): Promise<void> {
  await query(
    `INSERT INTO page_timing (at, route, method, status, shell_ms, total_ms, bytes, tags,
       db_n, db_ms, ebird_n, ebird_ms, google_n, google_ms, ai_n, ai_ms, rss_mb, heap_mb, version)
     VALUES (NOW() - make_interval(days => $1), $2, 'GET', 200, $3 / 2, $3, 1000, NULL,
       0, 0, 0, 0, 0, 0, 0, 0, 100, 50, $4)`,
    [daysAgo, route, totalMs, version],
  );
}

describe.skipIf(!dbUp)("page_timing on birds_test", () => {
  afterAll(async () => {
    await query(`DELETE FROM page_timing WHERE route = ANY($1::text[])`, [[ROUTE, ROUTE_B]]);
    const left = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM page_timing WHERE route = ANY($1::text[])`, [
      [ROUTE, ROUTE_B],
    ]);
    expect(left.rows[0].n).toBe(0);
  });

  it("stores the route id, the buckets, memory and the deploy, never the URL", async () => {
    await recordSlowRequest(slow());
    const r = await query(
      `SELECT route, method, status, shell_ms, total_ms, bytes, tags, db_n, db_ms, ebird_n, ebird_ms,
              google_n, ai_n, rss_mb, heap_mb, version
         FROM page_timing WHERE route = $1`,
      [ROUTE],
    );
    expect(r.rows).toEqual([
      {
        route: ROUTE, method: "GET", status: 200, shell_ms: 400, total_ms: 1200, bytes: 52_000, tags: 2400,
        db_n: 3, db_ms: 120, ebird_n: 1, ebird_ms: 901, google_n: 0, ai_n: 0, rss_mb: 500, heap_mb: 150,
        version: VERSION_A,
      },
    ]);
    await query(`DELETE FROM page_timing WHERE route = $1`, [ROUTE]);
  });

  it("refuses a raw URL with a query string", async () => {
    await expect(
      query(
        `INSERT INTO page_timing (route, method, status, shell_ms, total_ms, bytes, db_n, db_ms, ebird_n, ebird_ms,
           google_n, google_ms, ai_n, ai_ms, rss_mb, heap_mb, version)
         VALUES ('/species/amerob?back=7', 'GET', 200, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 'x')`,
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it("skips rows past the in-flight cap instead of piling onto the database", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const writes = Array.from({ length: MAX_WRITES_IN_FLIGHT + 2 }, () => recordSlowRequest(slow({ routeId: ROUTE_B })));
    await Promise.all(writes);
    const n = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM page_timing WHERE route = $1`, [ROUTE_B]);
    expect(n.rows[0].n).toBe(MAX_WRITES_IN_FLIGHT);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
    await query(`DELETE FROM page_timing WHERE route = $1`, [ROUTE_B]);
  });

  it("rolls each page up over 7 days beside the week before, and narrows to one deploy", async () => {
    await rowAt(1, 1000);
    await rowAt(2, 3000);
    await rowAt(3, 8000, ROUTE, VERSION_B);
    await rowAt(10, 500);
    const all = await pageTimingReport(750, null);
    expect(all.thresholdMs).toBe(750);
    expect(all.routes.find((x) => x.route === ROUTE)).toEqual({
      route: ROUTE,
      count: 3,
      medianTotalMs: 3000,
      worstTotalMs: 8000,
      medianShellMs: 1500,
      worstBytes: 1000,
      previousCount: 1,
      previousMedianTotalMs: 500,
      frozenCount: 0,
    });
    const a = await pageTimingReport(750, VERSION_A);
    expect(a.routes.find((x) => x.route === ROUTE)).toMatchObject({ count: 2, medianTotalMs: 2000, worstTotalMs: 3000 });
    // Newest first, only that deploy's.
    expect(a.recent.map((x) => x.totalMs)).toEqual([1000, 3000, 500]);
    expect(a.recent.every((x) => x.version === VERSION_A)).toBe(true);
    expect(all.versions.map((v) => v.version)).toEqual(expect.arrayContaining([VERSION_A, VERSION_B]));
  });

  it("prunes rows older than 30 days, and only the scoped ones", async () => {
    await rowAt(31, 777, ROUTE_B);
    await rowAt(29, 778, ROUTE_B);
    const ids = await query<{ id: string }>(`SELECT id::text FROM page_timing WHERE route = $1`, [ROUTE_B]);
    await pruneHistory({ pageTimingIds: ids.rows.map((r) => Number(r.id)) });
    const left = await query<{ total_ms: number }>(`SELECT total_ms FROM page_timing WHERE route = $1`, [ROUTE_B]);
    expect(left.rows.map((r) => r.total_ms)).toEqual([778]);
  });
});

describe("hook wiring", () => {
  it("records only past the perf threshold, with the route id, outside builds and tests", () => {
    const hooks = readFileSync(path.resolve(__dirname, "../../hooks.server.ts"), "utf8");
    expect(hooks).toContain("const RECORD_SLOW_REQUESTS = !building && !process.env.VITEST;");
    expect(hooks).toContain("if (RECORD_SLOW_REQUESTS && totalMs > PERF_LOG_SLOW_MS) {");
    expect(hooks).toContain("routeId: event.route?.id ?? null,");
    expect(hooks).not.toMatch(/routeId:\s*(pathname|event\.url)/);
  });
});

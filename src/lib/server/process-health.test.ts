/**
 * Server health (td-7739c2). Owned rows only: a fixture pid well outside real
 * pids, deleted exactly by id.
 */
import { afterAll, describe, expect, it } from "vitest";
import { query } from "$lib/db";
import { pruneHistory } from "$server/jobs";
import {
  CHART_BUCKET_MS,
  createNonOverlappingSampler,
  memoryNow,
  recordMemorySample,
  serverHealth,
} from "$server/process-health";
import { perfLogLine, newTimingBag } from "$server/request-timing";

const dbUp = await query("SELECT 1")
  .then(() => true)
  .catch(() => false);
const FIXTURE_PID = 3_900_000 + (process.pid % 90_000);
const created: number[] = [];

async function sample(
  proc: "web" | "worker",
  startedAt: string,
  sampledAt: string,
  rss: number,
  endReason?: "graceful shutdown",
): Promise<number> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO process_memory_samples
       (process, pid, started_at, sampled_at, rss_mb, heap_used_mb, heap_total_mb,
        external_mb, heap_limit_mb, ended_at, end_reason)
     VALUES ($1, $2, $3, $4, $5, 100, 200, 5, 384,
             CASE WHEN $6::text IS NULL THEN NULL ELSE $3::timestamptz + interval '1 hour' END,
             $6) RETURNING id::text`,
    [proc, FIXTURE_PID, startedAt, sampledAt, rss, endReason ?? null],
  );
  const id = Number(rows[0].id);
  created.push(id);
  return id;
}

describe("memoryNow", () => {
  it("reports whole megabytes, including the V8 heap limit", () => {
    const m = memoryNow();
    for (const v of Object.values(m))
      expect(Number.isInteger(v) && v >= 0).toBe(true);
    expect(m.heapLimitMb).toBeGreaterThan(0);
    expect(m.rssMb).toBeGreaterThanOrEqual(m.heapUsedMb);
  });
});

describe("perf log line memory", () => {
  it("appends rss= and heap= when memory is given, and stays unchanged otherwise", () => {
    const bag = newTimingBag(0);
    const line = perfLogLine("/x", 200, 10, 20, bag, undefined, {
      rss: 600 * 1024 * 1024,
      heapUsed: 120 * 1024 * 1024,
    });
    expect(line).toMatch(/ rss=600MB heap=120MB$/);
    expect(perfLogLine("/x", 200, 10, 20, bag)).not.toContain("rss=");
  });
});

describe("memory sample scheduling", () => {
  it("never overlaps writes when a sample is still waiting", async () => {
    let calls = 0;
    let release!: () => void;
    let pending = new Promise<void>((resolve) => (release = resolve));
    const sampler = createNonOverlappingSampler(
      async () => {
        calls += 1;
        await pending;
      },
      () => {},
    );

    sampler.run();
    sampler.run();
    expect(calls).toBe(1);
    release();
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 0));

    pending = Promise.resolve();
    sampler.run();
    expect(calls).toBe(2);
  });
});

describe.runIf(dbUp)("memory samples and the health summary", () => {
  afterAll(async () => {
    await query(
      "DELETE FROM process_memory_samples WHERE id = ANY($1::bigint[])",
      [created],
    );
    await query("DELETE FROM process_memory_samples WHERE pid = $1", [
      FIXTURE_PID,
    ]);
  });

  it("groups samples into runs with their peak and last reading", async () => {
    const t = Date.now();
    const iso = (minsAgo: number) =>
      new Date(t - minsAgo * 60_000).toISOString();
    const runStart = iso(60);
    await sample("web", runStart, iso(55), 300);
    await sample("web", runStart, iso(30), 910);
    await sample("web", runStart, iso(5), 640, "graceful shutdown");
    const h = await serverHealth();
    const run = h.runs.find(
      (r) => r.pid === FIXTURE_PID && r.process === "web",
    )!;
    expect(run).toMatchObject({
      peakRssMb: 910,
      lastRssMb: 640,
      samples: 3,
      endReason: "graceful shutdown",
    });
    expect(run.startedAt).toMatch(/T.*Z$/);
    expect(run.lastSampleAt).toMatch(/T.*Z$/);
    expect(
      h.history.filter((p) => p.process === "web").length,
    ).toBeGreaterThanOrEqual(3);
    expect(h.limits).toEqual({ web: 1024, worker: 300 });
    expect(h.web.pid).toBe(process.pid);
  });

  it("bounds chart points while retaining each time bucket's RSS peak", async () => {
    const base = Math.floor(Date.now() / CHART_BUCKET_MS) * CHART_BUCKET_MS;
    const runStart = new Date(base - 60_000).toISOString();
    await sample("web", runStart, new Date(base + 60_000).toISOString(), 500);
    await sample("web", runStart, new Date(base + 120_000).toISOString(), 875);
    await sample("web", runStart, new Date(base + 180_000).toISOString(), 600);
    const h = await serverHealth();
    const points = h.history.filter(
      (p) =>
        p.process === "web" &&
        Date.parse(p.at) >= base &&
        Date.parse(p.at) < base + CHART_BUCKET_MS,
    );
    expect(points).toHaveLength(1);
    expect(points[0].rssMb).toBe(875);
  });

  it("reports the worker's latest sample", async () => {
    const now = new Date().toISOString();
    await sample(
      "worker",
      new Date(Date.now() - 3_600_000).toISOString(),
      now,
      97,
    );
    const h = await serverHealth();
    expect(h.worker?.rssMb).toBeDefined();
  });

  it("records a real sample for this process", async () => {
    const before = await query<{ n: string }>(
      "SELECT count(*)::text AS n FROM process_memory_samples WHERE pid = $1",
      [process.pid],
    );
    await recordMemorySample("web");
    const after = await query<{ id: string }>(
      "SELECT id::text FROM process_memory_samples WHERE pid = $1 ORDER BY id DESC LIMIT 1",
      [process.pid],
    );
    created.push(Number(after.rows[0].id));
    const count = await query<{ n: string }>(
      "SELECT count(*)::text AS n FROM process_memory_samples WHERE pid = $1",
      [process.pid],
    );
    expect(Number(count.rows[0].n)).toBe(Number(before.rows[0].n) + 1);
  });

  it("prunes samples older than 7 days, and only the scoped rows", async () => {
    const old = await sample(
      "web",
      new Date(Date.now() - 9 * 86_400_000).toISOString(),
      new Date(Date.now() - 8 * 86_400_000).toISOString(),
      400,
    );
    const fresh = await sample(
      "web",
      new Date().toISOString(),
      new Date().toISOString(),
      400,
    );
    await pruneHistory({ memorySampleIds: [old, fresh] });
    const left = await query<{ id: string }>(
      "SELECT id::text FROM process_memory_samples WHERE id = ANY($1::bigint[])",
      [[old, fresh]],
    );
    expect(left.rows.map((r) => Number(r.id))).toEqual([fresh]);
  });
});

describe("wiring", () => {
  it("samples the web app outside builds and tests, and the worker at start", async () => {
    const { readFile } = await import("node:fs/promises");
    const hooks = await readFile(
      new URL("../../hooks.server.ts", import.meta.url),
      "utf8",
    );
    const worker = await readFile(
      new URL("../../worker/index.ts", import.meta.url),
      "utf8",
    );
    expect(hooks).toContain(
      "if (!building && !process.env.VITEST) startMemorySampler('web');",
    );
    expect(worker).toContain("startMemorySampler('worker');");
  });
});

describe("admin Server health tab", () => {
  it("is a third admin tab fed by the admin-only loader, and tolerates missing data", async () => {
    const { readFile } = await import("node:fs/promises");
    const page = await readFile(
      new URL("../../routes/admin/+page.svelte", import.meta.url),
      "utf8",
    );
    const loader = await readFile(
      new URL("../../routes/admin/+page.server.ts", import.meta.url),
      "utf8",
    );
    expect(page).toContain('aria-selected={activeTab === "health"}');
    expect(page).toContain('aria-controls="admin-panel-health"');
    expect(page).toContain(
      'id="admin-panel-health" role="tabpanel" aria-labelledby="admin-tab-health"',
    );
    expect(page).toContain("onkeydown={onAdminTabKeydown}");
    expect(page).toContain("Server health data is unavailable right now.");
    expect(page).toContain("Previous web run");
    expect(page).toContain("{runEnd(r)}");
    expect(page).toMatch(/<line class="limit"/);
    // Label, value and caption each on their own line (GROK layout finding).
    expect(page).toContain(".health .stat-tile > span { display: block; }");
    expect(loader).toContain(
      'if (locals.user?.role !== "admin") throw error(404, "Not found");',
    );
    expect(loader).toContain(
      "const health = await serverHealth().catch(() => null);",
    );
  });
});

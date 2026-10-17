/**
 * eBird traffic metric (td-009031). Rows written to birds_test belong to a
 * fixture origin unique to this run (an origin is the job type of the claim a
 * request runs under), deleted exactly by that origin.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { query } from "$lib/db";
import { barchartUrl } from "$server/barchart";
import { ebirdFetchOrNull } from "$server/ebird";
import { CookieJar, __fetchWithJarForTests as fetchWithJar, __readCountedTextForTests as readCountedText } from "$server/ebird-account";
import {
  CACHE_KEY_ENDPOINTS,
  ENDPOINT_LABELS,
  classifyApiPath,
  classifyCacheKey,
  classifyWebUrl,
  currentOrigin,
  ebirdTrafficReport,
  flushEbirdTraffic,
  originLabel,
  outcomeForStatus,
  pendingTrafficForTests,
  recordEbirdTraffic,
  setTrafficProcess,
  utcToday,
} from "$server/ebird-traffic";
import { runWithClaim } from "$server/job-claim";
import { pruneHistory } from "$server/jobs";

const SERVER = path.resolve(__dirname);
/** The migration's CHECK: lowercase words joined by slashes. */
const ENDPOINT_SHAPE = /^[a-z]+(\/[a-z]+)*$/;

describe("endpoint classification", () => {
  it.each([
    ["/data/obs/US-NY/recent?back=7", "obs/region/recent"],
    ["/data/obs/L123456/recent?back=7&detail=simple", "obs/hotspot/recent"],
    ["/data/obs/US-NY/recent/notable?back=7&detail=simple", "obs/region/notable"],
    ["/data/obs/US-NC/recent/bkcchi?back=14", "obs/region/species"],
    ["/data/obs/geo/recent?lat=30.1&lng=-81.6&dist=40&back=7", "obs/geo/recent"],
    ["/data/obs/geo/recent/notable?lat=1&lng=2&dist=3&back=4&detail=simple", "obs/geo/notable"],
    ["/data/obs/geo/recent/amerob?lat=1&lng=2", "obs/geo/species"],
    ["/data/nearest/geo/recent/amerob?lat=1&lng=2&back=30", "nearest/species"],
    ["/ref/hotspot/US-NY?fmt=json", "hotspot/region"],
    ["/ref/hotspot/geo?lat=1&lng=2&dist=3&fmt=json", "hotspot/geo"],
    ["/ref/hotspot/info/L99", "hotspot/info"],
    ["/ref/region/list/subnational1/US?fmt=json", "region/list"],
    ["/ref/region/list/country/world?fmt=json", "region/list"],
    ["/ref/taxonomy/ebird?fmt=json", "taxonomy"],
    ["/product/spplist/US-NY", "other"],
    ["/data/obs/US-NY/historic/2026/10/1", "other"],
  ])("%s → %s", (p, expected) => {
    expect(classifyApiPath(p)).toBe(expected);
  });

  it.each([
    [barchartUrl("US-NY-061", 2016, 2025), "web/barchart"],
    ["https://ebird.org/lifelist?r=world&time=life&fmt=csv", "web/lifelist"],
    ["https://ebird.org/checklist/S123456789", "web/checklist"],
    ["https://secure.birds.cornell.edu/cassso/login?service=x", "web/login"],
    ["https://ebird.org/login/cas?portal=ebird", "web/login"],
    ["https://ebird.org/home", "web/other"],
    ["https://example.com/barchartData", "web/other"],
    ["not a url", "web/other"],
  ])("%s → %s", (url, expected) => {
    expect(classifyWebUrl(url)).toBe(expected);
  });

  it("names every endpoint in the shape the table allows, with words for Admin", () => {
    for (const name of Object.keys(ENDPOINT_LABELS)) expect(name).toMatch(ENDPOINT_SHAPE);
    for (const name of Object.values(CACHE_KEY_ENDPOINTS)) expect(ENDPOINT_LABELS[name]).toBeTruthy();
  });

  it("classifies every eBird API path template in the code (no request falls into 'other')", () => {
    const files = ["ebird.ts", "hotspot-page.ts", "lifer-locations.ts", "hotspot-coordinate-repair.ts"];
    const templates: string[] = [];
    for (const f of files) {
      const src = readFileSync(path.join(SERVER, f), "utf8");
      for (const m of src.matchAll(/const path =\s*[`']([^`']+)[`']/g)) templates.push(m[1]);
    }
    expect(templates.length).toBeGreaterThanOrEqual(15);
    for (const t of templates) {
      const sample = t.replace(/\$\{[^}]+\}/g, "X1");
      expect(classifyApiPath(sample), t).not.toBe("other");
    }
  });

  it("maps every ebird_cache key prefix in ebird.ts to an endpoint", () => {
    const src = readFileSync(path.join(SERVER, "ebird.ts"), "utf8");
    const prefixes = new Set<string>();
    for (const m of src.matchAll(/(?:pacedCachedFetch|cachedFetch)\(\s*[`']([A-Za-z0-9]+):/g)) prefixes.add(m[1]);
    expect(prefixes.size).toBeGreaterThanOrEqual(11);
    for (const p of prefixes) expect(CACHE_KEY_ENDPOINTS[p], p).toBeTruthy();
    expect(classifyCacheKey("geo:30.10:-81.60:40:7")).toBe("obs/geo/recent");
    expect(classifyCacheKey("unknown:x")).toBe("other");
  });

  it("maps HTTP statuses to outcomes", () => {
    expect([200, 302, 404, 429, 403, 500].map(outcomeForStatus)).toEqual([
      "ok",
      "ok",
      "not_found",
      "rate_limited",
      "http_error",
      "http_error",
    ]);
  });
});

describe("origin", () => {
  it("is the web app by default, the worker once set, and a job's type inside it", async () => {
    expect(currentOrigin()).toBe("web");
    setTrafficProcess("worker");
    try {
      expect(currentOrigin()).toBe("worker");
      await runWithClaim({ id: -1, claim_seq: "1", type: "load_region" }, async () => {
        await Promise.resolve();
        expect(currentOrigin()).toBe("load_region");
      });
      expect(currentOrigin()).toBe("worker");
    } finally {
      setTrafficProcess("web");
    }
  });

  it("labels origins in Admin's words", () => {
    expect(originLabel("web")).toBe("Web app (pages people open)");
    expect(originLabel("load_region")).not.toBe("load_region");
  });
});

/** Run `fn` as a job of `origin`, so its counts are tagged with it. */
const asOrigin = <T>(origin: string, fn: () => Promise<T>) =>
  runWithClaim({ id: -1, claim_seq: "1", type: origin }, fn);
const fixtureOrigin = (tag: string) =>
  `zzfixture_${tag}_${Math.random().toString(36).replace(/[^a-z]/g, "").slice(0, 8)}`;
const pending = (origin: string) => pendingTrafficForTests().filter((t) => t.origin === origin);
/** Both fixture origins: the request test's counts are flushed by the DB
 * tests below, so cleanup covers them too. */
const FETCH_ORIGIN = fixtureOrigin("fetch");
const SLOW_ORIGIN = fixtureOrigin("slow");

describe("instrumented eBird requests", () => {
  const origin = FETCH_ORIGIN;

  it("counts a success with its size, a 404, a rate limit and a transport failure", async () => {
    await asOrigin(origin, async () => {
      const body = JSON.stringify({ locId: "L1", name: "x" });
      await ebirdFetchOrNull("/ref/hotspot/info/L1", "key", { fetcher: async () => new Response(body) });
      await ebirdFetchOrNull("/ref/hotspot/info/L2", "key", {
        fetcher: async () => new Response("", { status: 404 }),
      });
      await expect(
        ebirdFetchOrNull("/ref/hotspot/info/L3", "key", {
          fetcher: async () => new Response("", { status: 429 }),
        }),
      ).rejects.toThrow();
      await expect(
        ebirdFetchOrNull("/ref/hotspot/info/L4", "key", {
          fetcher: async () => {
            throw new TypeError("fetch failed");
          },
        }),
      ).rejects.toThrow();
    });
    const rows = pending(origin);
    const by = (o: string) => rows.find((r) => r.outcome === o);
    expect(rows.every((r) => r.endpoint === "hotspot/info")).toBe(true);
    expect(by("ok")).toMatchObject({ calls: 1, bytes: Buffer.byteLength(JSON.stringify({ locId: "L1", name: "x" })) });
    expect(by("not_found")?.calls).toBe(1);
    expect(by("rate_limited")?.calls).toBe(1);
    expect(by("network_error")?.calls).toBe(1);
  });
});

describe("instrumented eBird web requests", () => {
  afterEach(() => vi.unstubAllGlobals());
  const BARCHART = "https://ebird.org/barchartData?r=US-NY&bmo=1&emo=12&byr=2016&eyr=2025&fmt=tsv";

  /** A 200 whose body arrives after `delayMs`, or breaks off then. */
  function slowBody(delayMs: number, fail: boolean): Response {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => {
          if (fail) controller.error(new DOMException("aborted", "AbortError"));
          else {
            controller.enqueue(new TextEncoder().encode("tsv-body"));
            controller.close();
          }
        }, delayMs);
      },
    });
    return new Response(stream, { status: 200 });
  }

  it("counts a body that breaks off as a network error, not a success", async () => {
    const origin = FETCH_ORIGIN;
    vi.stubGlobal("fetch", vi.fn(async () => slowBody(20, true)));
    await asOrigin(origin, async () => {
      const res = await fetchWithJar(BARCHART, new CookieJar());
      await expect(readCountedText(res)).rejects.toThrow();
    });
    const rows = pending(origin).filter((r) => r.endpoint === "web/barchart");
    expect(rows.map((r) => [r.outcome, r.calls])).toEqual([["network_error", 1]]);
  });

  it("times a page through its last byte and counts its size once", async () => {
    const origin = SLOW_ORIGIN;
    vi.stubGlobal("fetch", vi.fn(async () => slowBody(300, false)));
    await asOrigin(origin, async () => {
      const res = await fetchWithJar(BARCHART, new CookieJar());
      expect(await readCountedText(res)).toBe("tsv-body");
    });
    const rows = pending(origin);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ endpoint: "web/barchart", outcome: "ok", calls: 1, bytes: 8 });
    expect(rows[0].ms).toBeGreaterThanOrEqual(250);
  });

  it("counts a redirect hop when it arrives", async () => {
    const origin = FETCH_ORIGIN;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://ebird.org/home" } })),
    );
    await asOrigin(origin, async () => {
      await fetchWithJar("https://ebird.org/login/cas?portal=ebird", new CookieJar());
    });
    expect(pending(origin).find((r) => r.endpoint === "web/login")).toMatchObject({ outcome: "ok", calls: 1 });
  });
});

const dbUp = await query("SELECT 1")
  .then(() => true)
  .catch(() => false);

describe.skipIf(!dbUp)("daily totals on birds_test", () => {
  const origin = fixtureOrigin("db");

  afterAll(async () => {
    const mine = [origin, FETCH_ORIGIN, SLOW_ORIGIN];
    await query(`DELETE FROM ebird_traffic_daily WHERE origin = ANY($1::text[])`, [mine]);
    const left = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM ebird_traffic_daily WHERE origin = ANY($1::text[])`,
      [mine],
    );
    expect(left.rows[0].n).toBe(0);
  });

  const row = async (endpoint: string, outcome: string) =>
    (
      await query<{ calls: number; total_ms: string; bytes: string }>(
        `SELECT calls, total_ms::text, bytes::text FROM ebird_traffic_daily
          WHERE origin = $1 AND endpoint = $2 AND outcome = $3 AND day = $4::date`,
        [origin, endpoint, outcome, utcToday()],
      )
    ).rows[0];

  it("adds each flush to the day's row instead of replacing it, even when two flushes overlap", async () => {
    await asOrigin(origin, async () => {
      recordEbirdTraffic("web/barchart", "ok", 100, 1000);
      recordEbirdTraffic("web/barchart", "ok", 50, 500);
    });
    await flushEbirdTraffic();
    await asOrigin(origin, async () => recordEbirdTraffic("web/barchart", "ok", 10, 5));
    const first = flushEbirdTraffic();
    await asOrigin(origin, async () => recordEbirdTraffic("web/barchart", "ok", 1, 1));
    const second = flushEbirdTraffic();
    await Promise.all([first, second]);
    expect(await row("web/barchart", "ok")).toEqual({ calls: 4, total_ms: "161", bytes: "1506" });
    expect(pending(origin)).toHaveLength(0);
  });

  it("refuses anything that is not an allow-listed name", async () => {
    await expect(
      query(
        `INSERT INTO ebird_traffic_daily (day, endpoint, origin, outcome, calls, total_ms, bytes)
         VALUES (CURRENT_DATE, '/data/obs/US-NY/recent?key=abc', $1, 'ok', 1, 0, 0)`,
        [origin],
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it("reports the fixture's requests by endpoint and origin, and 30 days of trend", async () => {
    await asOrigin(origin, async () => {
      recordEbirdTraffic("hotspot/geo", "cache_hit");
      recordEbirdTraffic("hotspot/geo", "cache_hit");
      recordEbirdTraffic("hotspot/geo", "rate_limited", 30);
    });
    await flushEbirdTraffic();
    const r = await ebirdTrafficReport();
    expect(r.days).toHaveLength(30);
    expect(r.days[29].day).toBe(utcToday());
    const mine = r.origins.find((o) => o.origin === origin);
    // Network requests only: 4 bar charts + 1 rate-limited; cache answers are not requests.
    expect(mine).toMatchObject({ network30d: 5, network7d: 5 });
    const geo = r.endpoints.find((e) => e.endpoint === "hotspot/geo")!;
    expect(geo.label).toBe(ENDPOINT_LABELS["hotspot/geo"]);
    expect(geo.cacheHits30d).toBeGreaterThanOrEqual(2);
    expect(geo.rateLimited30d).toBeGreaterThanOrEqual(1);
  });

  it("anchors every window to the UTC day rows are filed under, not the database's date", async () => {
    // A day the database session's CURRENT_DATE has not reached: the report
    // given that UTC day must still put the row in the last bar and the 7 days.
    const tomorrow = new Date(Date.now() + 86_400_000);
    await asOrigin(origin, async () => recordEbirdTraffic("taxonomy", "ok", 5, 5, tomorrow));
    await flushEbirdTraffic();
    const r = await ebirdTrafficReport(utcToday(tomorrow));
    expect(r.days[29].day).toBe(utcToday(tomorrow));
    expect(r.days[29].network).toBeGreaterThanOrEqual(1);
    expect(r.origins.find((o) => o.origin === origin)?.network7d).toBeGreaterThanOrEqual(1);
    await query(`DELETE FROM ebird_traffic_daily WHERE origin = $1 AND day = $2::date`, [origin, utcToday(tomorrow)]);
  });

  it("prunes rows older than 400 days, and only the scoped origin's", async () => {
    const old = new Date(Date.now() - 401 * 86_400_000);
    const recent = new Date(Date.now() - 399 * 86_400_000);
    await asOrigin(origin, async () => {
      recordEbirdTraffic("taxonomy", "ok", 1, 1, old);
      recordEbirdTraffic("taxonomy", "ok", 1, 1, recent);
    });
    await flushEbirdTraffic();
    await pruneHistory({ trafficOrigin: origin });
    const days = await query<{ day: string }>(
      `SELECT day::text FROM ebird_traffic_daily WHERE origin = $1 AND endpoint = 'taxonomy' ORDER BY day`,
      [origin],
    );
    expect(days.rows.map((d) => d.day)).toEqual([recent.toISOString().slice(0, 10)]);
  });
});

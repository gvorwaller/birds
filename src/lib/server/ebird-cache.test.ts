/**
 * Per-process coalescing of concurrent cache misses (td-d561a8 §2).
 *
 * The DB cache only helps once a response has been STORED. Between the SELECT
 * miss and the INSERT there is a window where every concurrent caller used to
 * issue its own upstream request — a window the Home split widens, because a
 * ~400 ms shell lets a user launch several overlapping per-species fan-outs in
 * the time one blocking load used to take.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));
const crypto = vi.hoisted(() => ({
  decryptSecret: vi.fn(),
  encryptSecret: vi.fn(),
}));

vi.mock("$lib/db", () => db);
vi.mock("$server/crypto", () => crypto);

// Must land before the import below: the module reads it once at load. Real
// timers only — AbortSignal.timeout ignores vitest's fake clock — so the
// deadline test would otherwise wait out the full production ceiling.
process.env.EBIRD_TIMEOUT_MS = "200";

const {
  recentNearbyObs,
  recentNearbySpeciesObs,
  nearestObsOfSpecies,
  recentSpeciesInRegion,
  notableNearbyObs,
} = await import("./ebird");

/** Always a cache miss, so every call reaches the coalescing path. */
function emptyCache() {
  db.query.mockResolvedValue({ rows: [] });
}

let fetchCalls: string[];

beforeEach(() => {
  vi.clearAllMocks();
  emptyCache();
  fetchCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      fetchCalls.push(String(url));
      // Long enough that the second caller arrives while this is in flight.
      await new Promise((r) => setTimeout(r, 20));
      return {
        ok: true,
        status: 200,
        json: async () => [],
      } as unknown as Response;
    }),
  );
});

describe("request deadline", () => {
  it("gives every call a deadline so an upstream stall cannot hang a page", async () => {
    // Measured 2026-09-01: eBird's nearest endpoint holds the connection ~60 s
    // and then 500s for a common species far from its range. With no deadline
    // the species page inherited the whole stall as a spinner.
    let seen: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        seen = init.signal as AbortSignal;
        return { ok: true, status: 200, json: async () => [] } as unknown as Response;
      }),
    );

    await recentNearbyObs("key", 30.26, -81.64, 40, 7);
    expect(seen).toBeInstanceOf(AbortSignal);
  });

  it("reports a stalled upstream as a timeout, not as 'unreachable'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            // Never settles on its own — only the deadline ends it, which is
            // exactly the eBird nearest behaviour.
            (init.signal as AbortSignal).addEventListener("abort", () =>
              reject(new DOMException("This operation was aborted", "AbortError")),
            );
          }),
      ),
    );

    await expect(
      nearestObsOfSpecies("key", "bkcchi", 30.26, -81.64, 14),
    ).rejects.toThrow(/did not respond within \d+s/);
  });

  it("distinguishes caller cancellation from a blown deadline", async () => {
    const ctrl = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            (init.signal as AbortSignal).addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
            ctrl.abort();
          }),
      ),
    );

    // A navigation the user superseded is not a provider fault, and must not
    // read as one in a message shown to them.
    await expect(
      notableNearbyObs("key", 1, 2, 40, 7, { signal: ctrl.signal }),
    ).rejects.toThrow(/caller cancelled/);
  });
});

describe("recentSpeciesInRegion (ladder rung)", () => {
  let urls: string[];
  beforeEach(() => {
    urls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(String(url));
        return { ok: true, status: 200, json: async () => [] } as unknown as Response;
      }),
    );
  });

  it("pins the parameters that decide WHICH reports count", async () => {
    await recentSpeciesInRegion("key", "US-NC", "bkcchi", 14);
    const [url] = urls;
    // This endpoint defaults includeProvisional FALSE while the direct nearest
    // endpoint passes true — without pinning it, the same species could yield
    // different "nearest" answers depending on which path replied.
    expect(url).toContain("includeProvisional=true");
    // eBird does not order rows by distance, so a truncated payload can hide
    // the closest report; ask for the documented ceiling.
    expect(url).toContain("maxResults=10000");
    expect(url).toContain("/data/obs/US-NC/recent/bkcchi");
  });

  it("clamps the window before BOTH the url and the cache key", async () => {
    db.query.mockClear();
    await recentSpeciesInRegion("key", "US-NC", "bkcchi", 99);
    expect(urls[0]).toContain("back=30");
    const keys = db.query.mock.calls.map((c) => c[1]?.[0]).filter(Boolean);
    // A single key per (region, species, clamped window) — otherwise back=99
    // and back=30 would cache identical payloads twice.
    expect(keys).toContain("spReg:US-NC:bkcchi:30");
  });

  it("rejects a malformed species code without calling eBird", async () => {
    await expect(
      recentSpeciesInRegion("key", "US-NC", "not a code!", 14),
    ).rejects.toThrow(/Unrecognized species code/);
    expect(urls).toHaveLength(0);
  });
});

describe("cachedFetch coalescing", () => {
  it("shares one upstream request between concurrent callers of the same key", async () => {
    const [a, b, c] = await Promise.all([
      recentNearbyObs("key", 30.33, -81.66, 40, 7),
      recentNearbyObs("key", 30.33, -81.66, 40, 7),
      recentNearbyObs("key", 30.33, -81.66, 40, 7),
    ]);

    expect(fetchCalls).toHaveLength(1);
    // Every caller still gets a real result, not a null placeholder.
    for (const r of [a, b, c]) expect(r.data).toEqual([]);
  });

  it("does not coalesce different keys", async () => {
    await Promise.all([
      recentNearbySpeciesObs("key", "gbbgul", 30.33, -81.66, 40, 7),
      recentNearbySpeciesObs("key", "laugul", 30.33, -81.66, 40, 7),
    ]);
    expect(fetchCalls).toHaveLength(2);
  });

  it("releases the key so a later call can fetch again", async () => {
    await recentNearbyObs("key", 30.33, -81.66, 40, 7);
    await recentNearbyObs("key", 30.33, -81.66, 40, 7);
    // Sequential, not concurrent: the second is a fresh miss (the DB cache is
    // stubbed empty), so it must issue its own request rather than replay a
    // completed promise forever.
    expect(fetchCalls).toHaveLength(2);
  });

  it("shares a failure without leaving the key wedged", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fetchCalls.push("boom");
        throw new Error("network down");
      }),
    );

    const results = await Promise.allSettled([
      recentNearbyObs("key", 30.33, -81.66, 40, 7),
      recentNearbyObs("key", 30.33, -81.66, 40, 7),
    ]);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(fetchCalls).toHaveLength(1);

    // The in-flight entry must be cleared even on the failure path, or the key
    // would serve that rejection to every future caller.
    const later = await Promise.allSettled([
      recentNearbyObs("key", 30.33, -81.66, 40, 7),
    ]);
    expect(later[0].status).toBe("rejected");
    expect(fetchCalls).toHaveLength(2);
  });
});

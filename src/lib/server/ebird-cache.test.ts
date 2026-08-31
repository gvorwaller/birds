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

const { recentNearbyObs, recentNearbySpeciesObs } = await import("./ebird");

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

import { beforeEach, describe, expect, it, vi } from "vitest";

const { getKey, resolve, compare } = vi.hoisted(() => ({
  getKey: vi.fn(),
  resolve: vi.fn(),
  compare: vi.fn(),
}));
const { EbirdError } = vi.hoisted(() => ({
  EbirdError: class EbirdError extends Error {
    constructor(
      message: string,
      public status?: number,
      public retryAfterMs?: number,
    ) {
      super(message);
    }
  },
}));
vi.mock("$server/ebird", () => ({ getEbirdApiKey: getKey, EbirdError }));
vi.mock("$server/hotspot-comparison", () => ({
  ComparisonError: class ComparisonError extends Error {
    status = 400;
    stopScheduling = false;
  },
  MAX_INLINE_WAIT_MS: 15_000,
  resolveComparison: resolve,
  compareHotspotBatch: compare,
  emptyRows: (refs: unknown[]) => refs,
}));

import { GET } from "./+server";
import {
  __resetEbirdRateForTests,
  noteEbirdResponse,
  PaceDeferred,
} from "$server/ebird-rate";

const locals = { user: { id: 7, role: "owner" }, scopeId: 42 };
const base =
  "http://localhost/api/hotspot-comparison?lat=30.41&lng=-81.42&radiusKm=40&daysBack=30&seenStatus=needs&rareOnly=0&anchorLabel=Huguenot";

beforeEach(() => {
  vi.clearAllMocks();
  __resetEbirdRateForTests();
  getKey.mockResolvedValue("secret");
  resolve.mockResolvedValue({
    value: "identity",
    references: [],
    referenceFetchedAt: "2026-09-19T00:00:00.000Z",
    referenceStale: false,
    seen: new Set(),
  });
  compare.mockResolvedValue({
    identity: {
      value: "identity",
      references: [],
      referenceFetchedAt: "2026-09-19T00:00:00.000Z",
      referenceStale: false,
    },
    rows: [],
    stopScheduling: false,
  });
});

describe("hotspot comparison route", () => {
  it("rejects unauthenticated requests before looking up credentials", async () => {
    const res = await GET({
      locals: { user: null, scopeId: null },
      url: new URL(base),
      request: new Request(base),
    } as never);
    expect(res.status).toBe(401);
    expect(getKey).not.toHaveBeenCalled();
  });

  it("rejects malformed, duplicate, and oversized batches before service calls", async () => {
    for (const ids of ["x", "L1,L1", "L1,L2,L3,L4,L5"]) {
      const res = await GET({
        locals,
        url: new URL(`${base}&ids=${ids}`),
        request: new Request(`${base}&ids=${ids}`),
      } as never);
      expect(res.status).toBe(400);
    }
    expect(resolve).not.toHaveBeenCalled();
    expect(compare).not.toHaveBeenCalled();
  });

  it("initializes without observation fanout and binds batches to identity", async () => {
    const init = await GET({
      locals,
      url: new URL(base),
      request: new Request(base),
    } as never);
    expect(init.status).toBe(200);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(
      "secret",
      expect.anything(),
      { accountId: 7, scopeOwnerId: 42 },
      expect.objectContaining({
        pace: expect.any(Function),
        paceSignal: expect.any(AbortSignal),
      }),
    );
    expect(compare).not.toHaveBeenCalled();
    const batch = await GET({
      locals,
      url: new URL(`${base}&ids=L1&identity=identity`),
      request: new Request(`${base}&ids=L1&identity=identity`),
    } as never);
    expect(batch.status).toBe(200);
    expect(compare).toHaveBeenCalledWith(
      "secret",
      expect.anything(),
      { accountId: 7, scopeOwnerId: 42 },
      ["L1"],
      "identity",
      expect.any(AbortSignal),
    );
  });

  it("returns the reference feed's real 429 wait so the client can auto-resume", async () => {
    noteEbirdResponse(
      "secret",
      new Headers({ "retry-after": "9" }),
      429,
    );
    resolve.mockResolvedValueOnce({
      value: "identity",
      references: [{ locId: "L1" }],
      referenceFetchedAt: "2026-09-19T00:00:00.000Z",
      referenceStale: true,
      referenceRefreshErrorStatus: 429,
      seen: new Set(),
    });
    const res = await GET({
      locals,
      url: new URL(base),
      request: new Request(base),
    } as never);
    const body = await res.json();
    expect(body).toMatchObject({
      stopScheduling: true,
      stopReason: "rate",
      resumeAfterMs: expect.any(Number),
    });
    expect(body.resumeAfterMs).toBeGreaterThan(8_000);
  });

  it("returns a prompt rate stop when an uncached reference refresh would outwait the request", async () => {
    resolve.mockRejectedValueOnce(new PaceDeferred("rate", 90_000));
    const res = await GET({
      locals,
      url: new URL(base),
      request: new Request(base),
    } as never);
    await expect(res.json()).resolves.toMatchObject({
      status: "ready",
      references: [],
      rows: [],
      stopScheduling: true,
      stopReason: "rate",
      resumeAfterMs: 90_000,
    });
  });

  it.each([401, 403])(
    "a cold eBird %s on the hotspot list says the key failed, with a Settings pointer (td-5003e2)",
    async (status) => {
      resolve.mockRejectedValueOnce(new EbirdError("eBird API key is missing or invalid", status));
      const res = await GET({ locals, url: new URL(base), request: new Request(base) } as never);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ status: "unavailable", stopReason: "auth" });
      expect(body.message).toMatch(/authorization failed.*Settings/);
    },
  );

  it("a cold eBird 429 on the hotspot list is a resumable rate stop, not 'unavailable'", async () => {
    noteEbirdResponse("secret", new Headers({ "retry-after": "4" }), 429);
    resolve.mockRejectedValueOnce(new EbirdError("eBird API rate limit hit.", 429, 4000));
    const res = await GET({ locals, url: new URL(base), request: new Request(base) } as never);
    const body = await res.json();
    expect(body).toMatchObject({ status: "ready", stopScheduling: true, stopReason: "rate" });
    expect(body.resumeAfterMs).toBeGreaterThan(3000);
    expect(body.resumeAfterMs).toBeLessThanOrEqual(4000);
  });

  it("allows viewers to read and gives missing-key users a settings action", async () => {
    const viewer = { user: { id: 8, role: "viewer" }, scopeId: 42 };
    const viewerRes = await GET({
      locals: viewer,
      url: new URL(base),
      request: new Request(base),
    } as never);
    expect(viewerRes.status).toBe(200);
    getKey.mockResolvedValueOnce(null);
    const noKey = await GET({
      locals,
      url: new URL(base),
      request: new Request(base),
    } as never);
    expect(noKey.status).toBe(200);
    await expect(noKey.json()).resolves.toMatchObject({
      status: "unavailable",
      message: expect.stringContaining("Settings"),
    });
  });
});

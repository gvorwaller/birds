import { beforeEach, describe, expect, it, vi } from "vitest";

const { getKey, resolve, compare } = vi.hoisted(() => ({
  getKey: vi.fn(),
  resolve: vi.fn(),
  compare: vi.fn(),
}));
vi.mock("$server/ebird", () => ({ getEbirdApiKey: getKey }));
vi.mock("$server/hotspot-comparison", () => ({
  ComparisonError: class ComparisonError extends Error {
    status = 400;
    stopScheduling = false;
  },
  resolveComparison: resolve,
  compareHotspotBatch: compare,
  emptyRows: (refs: unknown[]) => refs,
}));

import { GET } from "./+server";

const locals = { user: { id: 7, role: "owner" }, scopeId: 42 };
const base =
  "http://localhost/api/hotspot-comparison?lat=30.41&lng=-81.42&radiusKm=40&daysBack=30&seenStatus=needs&rareOnly=0&anchorLabel=Huguenot";

beforeEach(() => {
  vi.clearAllMocks();
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

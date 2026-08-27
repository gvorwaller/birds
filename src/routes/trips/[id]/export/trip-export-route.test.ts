/**
 * Export route contract (td-8b959f): format dispatch, disposition, private
 * headers, 404-before-work, and url.origin precedence for the app links.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTrip: vi.fn(),
  getStops: vi.fn(),
  needsCountForStops: vi.fn(),
  getEbirdApiKey: vi.fn(),
}));

vi.mock("$server/trips", () => ({
  getTrip: mocks.getTrip,
  getStops: mocks.getStops,
  needsCountForStops: mocks.needsCountForStops,
}));
vi.mock("$server/ebird", () => ({ getEbirdApiKey: mocks.getEbirdApiKey }));
vi.mock("$env/dynamic/private", () => ({ env: {} }));

import { GET } from "./+server";

const TRIP = {
  id: 7,
  user_id: 1,
  name: "Sanibel loop",
  start_date: null,
  end_date: null,
  notes: null,
  created_at: "2026-08-26",
};

const event = (id: string, query = "") =>
  ({
    locals: { scopeId: 1 },
    params: { id },
    url: new URL(`http://localhost:5178/trips/${id}/export${query}`),
  }) as never;

beforeEach(() => {
  mocks.getTrip.mockReset().mockResolvedValue(TRIP);
  mocks.getStops.mockReset().mockResolvedValue([]);
  mocks.getEbirdApiKey.mockReset().mockResolvedValue("key");
  mocks.needsCountForStops
    .mockReset()
    .mockResolvedValue({ counts: new Map(), species: new Map(), stale: false, error: false });
});

describe("GET /trips/[id]/export", () => {
  it("default format is INLINE html with private headers — no Content-Disposition", async () => {
    const res = await GET(event("7"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toContain("<h1>Sanibel loop</h1>");
  });

  it("?format=md keeps the download contract (disposition pin)", async () => {
    const res = await GET(event("7", "?format=md"));
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="trip-sanibel-loop.md"',
    );
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.text()).toContain("# Sanibel loop");
  });

  it("unknown format → 400; bad id / missing trip → 404 before any needs work", async () => {
    await expect(GET(event("7", "?format=pdf"))).rejects.toMatchObject({ status: 400 });
    await expect(GET(event("abc"))).rejects.toMatchObject({ status: 404 });
    await expect(GET(event("-1"))).rejects.toMatchObject({ status: 404 });
    mocks.getTrip.mockResolvedValue(null);
    await expect(GET(event("9"))).rejects.toMatchObject({ status: 404 });
    expect(mocks.needsCountForStops).not.toHaveBeenCalled();
  });

  it("app links use the REQUEST's origin (url.origin precedence over env/fallback)", async () => {
    const res = await GET(event("7"));
    const body = await res.text();
    expect(body).toContain('href="http://localhost:5178/trips/7"');
    expect(body).not.toContain("birds.gaylon.photos/trips/7");
  });
});

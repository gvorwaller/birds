/**
 * Public share route (td-8b959f follow-up). Pins: the token is the ONLY
 * credential (no locals), reads run as the trip OWNER, 404 before any data
 * work, and the token-safety headers.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tripForToken: vi.fn(),
  getStops: vi.fn(),
  needsCountForStops: vi.fn(),
  getEbirdApiKey: vi.fn(),
}));

vi.mock("$server/trip-shares", () => ({ tripForToken: mocks.tripForToken }));
vi.mock("$server/trips", () => ({
  getStops: mocks.getStops,
  needsCountForStops: mocks.needsCountForStops,
}));
vi.mock("$server/ebird", () => ({ getEbirdApiKey: mocks.getEbirdApiKey }));
vi.mock("$env/dynamic/private", () => ({ env: {} }));

import { GET } from "./+server";

const TRIP = {
  id: 7,
  user_id: 42, // the OWNER — deliberately not 1, so the owner-key pin bites
  name: "Sanibel loop",
  start_date: null,
  end_date: null,
  notes: null,
  created_at: "2026-08-27",
};

const TOKEN = "a".repeat(43);
const event = (token: string) =>
  ({
    params: { token },
    url: new URL(`https://birds.gaylon.photos/share/trip/${token}`),
    locals: {}, // a logged-out visitor: the route must never read locals
  }) as never;

beforeEach(() => {
  mocks.tripForToken.mockReset().mockResolvedValue(TRIP);
  mocks.getStops.mockReset().mockResolvedValue([
    {
      id: 1,
      trip_id: 7,
      sort_order: 0,
      hotspot_id: "L123",
      custom_name: "Ding Darling",
      lat: 26.4,
      lon: -82.1,
      google_place_id: null,
      notes: null,
      target_count_at_save: null,
      field_tip: "Low tide early.",
      field_tip_generated_at: null,
    },
  ]);
  mocks.getEbirdApiKey.mockReset().mockResolvedValue("owner-key");
  mocks.needsCountForStops.mockReset().mockResolvedValue({
    counts: new Map([[1, 1]]),
    species: new Map([[1, [{ code: "magwar", comName: "Magnolia Warbler" }]]]),
    stale: false,
    error: false,
  });
});

describe("GET /share/trip/[token]", () => {
  it("valid token → 200 shared field sheet with token-safety headers", async () => {
    const res = await GET(event(TOKEN));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const body = await res.text();
    expect(body).toContain("Sanibel loop");
    expect(body).toContain("Low tide early.");
    expect(body).toContain("Magnolia Warbler");
  });

  it("PINNED: no app deep links in the body — the visitor has no login", async () => {
    const body = await (await GET(event(TOKEN))).text();
    expect(body).not.toContain("/species/");
    expect(body).not.toContain("/hotspots/");
    expect(body).not.toContain("Open in app");
    expect(body).toContain("https://ebird.org/hotspot/L123"); // external stays
  });

  it("PINNED: every read runs as the trip OWNER (user_id from the token row)", async () => {
    await GET(event(TOKEN));
    expect(mocks.getEbirdApiKey).toHaveBeenCalledWith(42);
    expect(mocks.needsCountForStops).toHaveBeenCalledWith(42, "owner-key", expect.anything());
  });

  it("unknown/revoked token → 404 BEFORE any stops/needs work", async () => {
    mocks.tripForToken.mockResolvedValue(null);
    await expect(GET(event(TOKEN))).rejects.toMatchObject({ status: 404 });
    expect(mocks.getStops).not.toHaveBeenCalled();
    expect(mocks.needsCountForStops).not.toHaveBeenCalled();
  });

  it("malformed tokens are rejected without a DB round-trip", async () => {
    for (const bad of ["", "x".repeat(65), "has spaces", "semi;colon"]) {
      await expect(GET(event(bad))).rejects.toMatchObject({ status: 404 });
    }
    expect(mocks.tripForToken).not.toHaveBeenCalled();
  });
});

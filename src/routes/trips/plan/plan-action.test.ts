import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  getEbirdApiKey: vi.fn(),
  runQuery: vi.fn(),
  assembleTripPreview: vi.fn(),
  savePlannedTrip: vi.fn(),
}));

vi.mock("$lib/db", () => ({ query: mocks.query }));
vi.mock("$server/ebird", () => ({ getEbirdApiKey: mocks.getEbirdApiKey, EbirdError: class EbirdError extends Error {} }));
vi.mock("$server/geocode", () => ({ geocodePlace: vi.fn() }));
vi.mock("$server/trips", () => ({ savePlannedTrip: mocks.savePlannedTrip }));
vi.mock("$server/query-engine", () => ({
  BOUNDS: { radiusKm: { min: 1, max: 50 }, daysBack: { min: 1, max: 30 }, numStops: { min: 1, max: 10 }, minNeedsPerStop: { min: 1, max: 20 } },
  runQuery: mocks.runQuery,
  assembleTripPreview: mocks.assembleTripPreview,
  validateTripParams: (raw: Record<string, unknown>) => ({ ok: true, value: { ...raw, radiusKm: 25, daysBack: 30, numStops: 2, minNeedsPerStop: 2 } }),
}));

import { actions, load } from "./+page.server";
import { issueTripCountToken, verifyTripCountToken } from "$server/trip-count-token";

const candidate = {
  locId: null,
  locName: "Reported yard",
  lat: 30.41,
  lng: -81.419,
  googlePlaceId: null,
  distanceKm: 1,
  matchCount: 4,
  triggerSpecies: [],
  lastObsDt: "2026-09-18 08:00",
  eligible: true,
  isVerifiedHotspot: false,
};

const queryResult = {
  filters: {
    anchorLat: 30.415,
    anchorLng: -81.415,
    anchorLabel: "Huguenot",
    radiusKm: 25,
    daysBack: 30,
    seenStatus: "needs" as const,
    rareOnly: false,
  },
  candidates: [candidate],
  speciesCount: 4,
  stale: false,
  observationStale: false,
  hotspotVerification: "available" as const,
  hotspotMeta: {},
  fetchedAt: "2026-09-18T12:00:00.000Z",
};

const preview = {
  params: { ...queryResult.filters, numStops: 2, minNeedsPerStop: 2, includeHistoricalStop: false },
  stops: [{ hotspotId: null, name: candidate.locName, lat: candidate.lat, lng: candidate.lng, googlePlaceId: null, matchCount: candidate.matchCount, triggerSpecies: [], kind: "observation" as const, note: "Target" }],
  historicalStatus: "not_requested" as const,
  totalMatchSpecies: 4,
  warnings: [],
  stale: false,
  suggestedName: "Huguenot — 1 stop",
};

function locals(role: "owner" | "viewer" = "owner") {
  return { user: { id: 7, role }, scopeId: 42 };
}

function saveEvent(stops: unknown[], role: "owner" | "viewer" = "owner") {
  const body = new FormData();
  body.set("name", "Test trip");
  body.set("stops", JSON.stringify(stops));
  return {
    locals: locals(role),
    request: new Request("http://localhost/trips/plan?/save", { method: "POST", body }),
  } as unknown as Parameters<NonNullable<typeof actions.save>>[0];
}

function stop(over: Record<string, unknown> = {}) {
  return {
    hotspot_id: null,
    name: candidate.locName,
    lat: candidate.lat,
    lon: candidate.lng,
    google_place_id: null,
    notes: null,
    target_count_at_save: 4,
    count_context_token: "missing",
    ...over,
  };
}

async function loaderToken(): Promise<string> {
  const loaded = (await load({ locals: locals(), url: new URL("http://localhost/trips/plan?place=Huguenot&lat=30.415&lng=-81.415") } as never)) as unknown as { candidateTokens: Record<string, string> };
  return loaded.candidateTokens["30.41,-81.419"];
}

describe("trip planner count token boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockResolvedValue({ rows: [{ home_lat: null, home_lon: null, home_label: null }] });
    mocks.getEbirdApiKey.mockResolvedValue("key");
    mocks.runQuery.mockResolvedValue(queryResult);
    mocks.assembleTripPreview.mockResolvedValue(preview);
    mocks.savePlannedTrip.mockResolvedValue(99);
  });

  it("accepts the real loader-issued token and records the exact rounded fetch anchor", async () => {
    const data = (await load({
      locals: locals(),
      url: new URL("http://localhost/trips/plan?place=Huguenot&lat=30.415&lng=-81.415"),
    } as never)) as unknown as { candidateTokens: Record<string, string> };
    const token = data.candidateTokens["30.41,-81.419"];
    expect(token).toBeTruthy();
    const verified = verifyTripCountToken(token, 7, 42, Date.parse("2026-09-18T12:00:01.000Z"));
    expect(verified.context.anchorLat).toBe(Number((30.415).toFixed(2)));
    expect(verified.context.anchorLng).toBe(Number((-81.415).toFixed(2)));

    await expect(actions.save(saveEvent([stop({ count_context_token: token })]))).rejects.toMatchObject({ status: 303 });
    expect(mocks.savePlannedTrip).toHaveBeenCalledWith(7, expect.anything(), [expect.objectContaining({ planned_count_context: verified.context })]);
  });

  it.each([
    ["null entry", [null]],
    ["missing token", [stop({ count_context_token: null })]],
  ])("rejects %s before persistence", async (_label, input) => {
    const result = await actions.save(saveEvent(input));
    expect(result).toMatchObject({ status: 400 });
    expect(mocks.savePlannedTrip).not.toHaveBeenCalled();
  });

  it("rejects a real token when the submitted count or coordinates change", async () => {
    const token = await loaderToken();
    for (const input of [
      [stop({ count_context_token: token, target_count_at_save: 3 })],
      [stop({ count_context_token: token, lat: 30.42 })],
    ]) {
      expect(await actions.save(saveEvent(input))).toMatchObject({ status: 400 });
    }
    expect(mocks.savePlannedTrip).not.toHaveBeenCalled();
  });

  it("rejects duplicate candidate identities and viewer writes before persistence", async () => {
    const loaded = (await load({ locals: locals(), url: new URL("http://localhost/trips/plan?place=Huguenot&lat=30.415&lng=-81.415") } as never)) as unknown as { candidateTokens: Record<string, string> };
    const token = loaded.candidateTokens["30.41,-81.419"];
    expect(await actions.save(saveEvent([stop({ count_context_token: token }), stop({ count_context_token: token })]))).toMatchObject({ status: 400 });
    expect(await actions.save(saveEvent([stop({ count_context_token: token })], "viewer"))).toMatchObject({ status: 403 });
    expect(mocks.savePlannedTrip).not.toHaveBeenCalled();
  });

  it("saves a historical stop with null hotspot, count and context", async () => {
    await expect(actions.save(saveEvent([{ hotspot_id: null, name: "Museum", lat: 30, lon: -81, notes: null, target_count_at_save: null, count_context_token: null }]))).rejects.toMatchObject({ status: 303 });
    expect(mocks.savePlannedTrip).toHaveBeenCalledWith(7, expect.anything(), [expect.objectContaining({ hotspot_id: null, target_count_at_save: null, planned_count_context: null })]);
  });

  it("accepts a real signed v2 per-hotspot snapshot and persists its JSONB context", async () => {
    const now = new Date().toISOString();
    const context = { version: 2 as const, source: "hotspot-recent" as const, reportPolicy: "including-unconfirmed" as const, seenStatus: "needs" as const, daysBack: 30, anchorLat: 30.41, anchorLng: -81.42, radiusKm: 25, anchorLabel: "Huguenot", locationId: "L127286", locationLat: 30.41, locationLng: -81.42, count: 2, fetchedAt: now, plannedAt: now, stale: false };
    const token = issueTripCountToken(7, 42, context);
    await expect(actions.save(saveEvent([stop({ hotspot_id: "L127286", name: "Huguenot Memorial City Park", lat: 30.41, lon: -81.42, target_count_at_save: 2, count_context_token: token })]))).rejects.toMatchObject({ status: 303 });
    expect(mocks.savePlannedTrip).toHaveBeenCalledWith(7, expect.anything(), [expect.objectContaining({ planned_count_context: verifyTripCountToken(token, 7, 42).context })]);
  });
});

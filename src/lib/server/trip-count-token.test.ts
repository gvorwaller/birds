import { describe, expect, it, vi } from "vitest";

vi.mock("$env/dynamic/private", () => ({ env: { AUTH_SECRET: "test-auth-secret" } }));

import { issueTripCountToken, verifyTripCountToken, TripCountTokenError } from "./trip-count-token";

const context = {
  version: 1 as const,
  source: "area-recent-preview" as const,
  seenStatus: "needs" as const,
  daysBack: 30,
  anchorLat: 44.4,
  anchorLng: -68.6,
  radiusKm: 40,
  anchorLabel: "Huguenot",
  locationId: "L1",
  locationLat: 44.41,
  locationLng: -68.61,
  count: 4,
  fetchedAt: "2026-09-18T12:00:00.000Z",
  plannedAt: "2026-09-18T12:01:00.000Z",
  stale: false,
};

describe("trip count token", () => {
  it("binds account, scope, context and expiry", () => {
    const token = issueTripCountToken(7, 42, context);
    const now = Date.parse(context.plannedAt) + 1;
    expect(verifyTripCountToken(token, 7, 42, now)).toMatchObject({ accountId: 7, scopeOwnerId: 42, context });
    expect(() => verifyTripCountToken(token, 8, 42, now)).toThrow(TripCountTokenError);
    expect(() => verifyTripCountToken(token, 7, 43, now)).toThrow(TripCountTokenError);
    expect(() => verifyTripCountToken(token, 7, 42, Date.parse(context.plannedAt) + 24 * 60 * 60 * 1000)).toThrow(TripCountTokenError);
  });

  it("rejects tampering, malformed context and fractional/negative counts", () => {
    const token = issueTripCountToken(7, 42, context);
    const [body, sig] = token.split(".");
    const tampered = `${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), context: { ...context, count: -1 } })).toString("base64url")}.${sig}`;
    expect(() => verifyTripCountToken(tampered, 7, 42)).toThrow(TripCountTokenError);
    expect(() => issueTripCountToken(7, 42, { ...context, count: 1.5 })).toThrow(TripCountTokenError);
    expect(() => issueTripCountToken(7, 42, { ...context, count: -1 })).toThrow(TripCountTokenError);
    expect(() => verifyTripCountToken(`${body}.bad`, 7, 42)).toThrow(TripCountTokenError);
  });
});

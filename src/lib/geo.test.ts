import { describe, expect, it } from "vitest";
import {
  distanceToBoxKm,
  formatDistance,
  formatKm,
  formatMiles,
  haversineKm,
  isInsideRegion,
  mapsDirectionsUrl,
  mapsPlaceUrl,
  regionDistanceKm,
} from "./geo";

describe("distance formatting", () => {
  it("formats kilometers using the existing display rules", () => {
    expect(formatKm(2.4)).toBe("2.4 km");
    expect(formatKm(12.4)).toBe("12 km");
  });

  it("formats miles from kilometer distances", () => {
    expect(formatMiles(2.4)).toBe("1.5 mi");
    expect(formatMiles(42)).toBe("26 mi");
  });

  it("defaults display distances to miles and can switch to kilometers", () => {
    expect(formatDistance(16)).toBe("9.9 mi");
    expect(formatDistance(16, "km")).toBe("16 km");
  });
});

describe("Google Maps link builders", () => {
  it("prefers Google place IDs for map and directions links", () => {
    const place = {
      name: "Fort Point State Park",
      lat: 44.467,
      lng: -68.811,
      google_place_id: "ChIJabc123",
    };

    expect(mapsPlaceUrl(place)).toContain("query_place_id=ChIJabc123");
    expect(mapsPlaceUrl(place)).toContain("query=Fort%20Point%20State%20Park");
    expect(mapsDirectionsUrl(place)).toContain(
      "destination_place_id=ChIJabc123",
    );
    expect(mapsDirectionsUrl(place)).toContain(
      "destination=Fort%20Point%20State%20Park",
    );
  });

  it("falls back to exact coordinates when no place ID is known", () => {
    expect(
      mapsPlaceUrl({ name: "Somewhere", lat: 44.467, lng: -68.811 }),
    ).toContain("query=44.467%2C-68.811");
    expect(mapsDirectionsUrl({ lat: 44.467, lng: -68.811 })).toContain(
      "destination=44.467%2C-68.811",
    );
  });
});

describe("region distance by bounding box (td-a4a3bf)", () => {
  // Real eBird bounds, fetched 2026-08-31.
  const FL = {
    minLat: 24.520417,
    maxLat: 31.00211,
    minLon: -87.637231,
    maxLon: -79.72264,
  };
  // Georgia's extent (its southern edge is just north of Jacksonville).
  const GA = {
    minLat: 30.355757,
    maxLat: 35.000771,
    minLon: -85.605165,
    maxLon: -80.840842,
  };
  const JAX = { lat: 30.263, lon: -81.637 }; // Gaylon's home

  it("THE BUG: the state you are standing in wins, where centroids said otherwise", () => {
    // Measured on prod: centroid distances put GEORGIA (191 mi) ahead of
    // FLORIDA (212 mi) for a home inside Florida, because Florida's centroid
    // is far down the peninsula. By extent, Florida is zero.
    const flByBox = distanceToBoxKm(JAX.lat, JAX.lon, FL);
    const gaByBox = distanceToBoxKm(JAX.lat, JAX.lon, GA);
    expect(flByBox).toBe(0);
    expect(gaByBox).toBeGreaterThan(0);
    expect(flByBox).toBeLessThan(gaByBox);

    // And the centroid measure really did rank them the other way round:
    const flByCentroid = haversineKm(JAX.lat, JAX.lon, 27.7612635, -83.6799355);
    const gaByCentroid = haversineKm(JAX.lat, JAX.lon, 32.68, -83.22);
    expect(gaByCentroid).toBeLessThan(flByCentroid);
  });

  it("a point just outside an edge is a short hop, not a centroid-sized number", () => {
    // Jacksonville to Georgia's southern edge: ~10 km, not ~300.
    const d = distanceToBoxKm(JAX.lat, JAX.lon, GA);
    expect(d).toBeGreaterThan(5);
    expect(d).toBeLessThan(20);
  });

  it("clamps on both axes for a corner-diagonal point", () => {
    const box = { minLat: 10, maxLat: 20, minLon: 10, maxLon: 20 };
    // Due south-west of the SW corner → distance to that corner exactly.
    expect(distanceToBoxKm(5, 5, box)).toBeCloseTo(
      haversineKm(5, 5, 10, 10),
      6,
    );
    // Due west, latitude inside the span → the spherical perpendicular foot
    // is slightly north of the query latitude, not a coordinate-wise clamp.
    expect(distanceToBoxKm(15, 5, box)).toBeLessThan(
      haversineKm(15, 5, 15, 10),
    );
  });

  it("handles an antimeridian-crossing box (minLon > maxLon) without swapping it", () => {
    // Fiji-shaped span: 177E .. 178W wraps through 180.
    const fiji = { minLat: -20, maxLat: -16, minLon: 177, maxLon: -178 };
    expect(distanceToBoxKm(-18, 179, fiji)).toBe(0); // inside the wrap
    expect(distanceToBoxKm(-18, -179, fiji)).toBe(0); // also inside
    // Outside to the west: nearest edge is 177, ~2° away, not the long way.
    const west = distanceToBoxKm(-18, 175, fiji);
    expect(west).toBeGreaterThan(0);
    expect(west).toBeLessThan(haversineKm(-18, 175, -18, 165));
    expect(isInsideRegion(-18, 179, fiji)).toBe(true);
    expect(isInsideRegion(-18, 175, fiji)).toBe(false);
  });

  it("does not treat an ambiguous almost-global Alaska box as local", () => {
    const alaska = {
      minLat: 51.20972,
      maxLat: 71.390685,
      minLon: -179.150558,
      maxLon: 179.773408,
    };
    const london = { lat: 51.5072, lon: -0.1276 };
    const providerCentroid = { lat: 61.3002025, lon: 0.311425, box: alaska };
    expect(isInsideRegion(london.lat, london.lon, alaska)).toBe(false);
    expect(regionDistanceKm(london.lat, london.lon, providerCentroid)).toBe(
      Infinity,
    );
  });

  it("keeps a genuinely global polar extent usable", () => {
    const antarctica = {
      minLat: -89.9999999999999,
      maxLat: -60.515777,
      minLon: -180,
      maxLon: 179.999986,
    };
    expect(isInsideRegion(-75, 120, antarctica)).toBe(true);
    expect(isInsideRegion(-75, 180, antarctica)).toBe(true);
    expect(distanceToBoxKm(-75, 120, antarctica)).toBe(0);
  });

  it("uses the spherical foot on a meridian instead of coordinate-wise clamping", () => {
    const box = { minLat: 0, maxLat: 80, minLon: 60, maxLon: 70 };
    const query = { lat: 60, lon: 0 };
    const sameLatitude = haversineKm(
      query.lat,
      query.lon,
      query.lat,
      box.minLon,
    );
    expect(distanceToBoxKm(query.lat, query.lon, box)).toBeLessThan(
      sameLatitude,
    );
  });

  it("regionDistanceKm falls back to the centroid when bounds are unknown — never invents a box", () => {
    const noBox = { lat: 27.76, lon: -83.68, box: null };
    expect(regionDistanceKm(JAX.lat, JAX.lon, noBox)).toBeCloseTo(
      haversineKm(JAX.lat, JAX.lon, 27.76, -83.68),
      6,
    );
    // With a box, the same region measures to its extent instead.
    expect(regionDistanceKm(JAX.lat, JAX.lon, { ...noBox, box: FL })).toBe(0);
  });

  it("isInsideRegion is false for a missing box (unknown is not inside)", () => {
    expect(isInsideRegion(JAX.lat, JAX.lon, null)).toBe(false);
    expect(isInsideRegion(JAX.lat, JAX.lon, undefined)).toBe(false);
  });
});

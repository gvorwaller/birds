import { describe, expect, it } from "vitest";
import { haversineMeters, placeNameScore } from "./location-placeids";

describe("eBird location Google place matching helpers", () => {
  it("scores overlapping eBird and Google place names", () => {
    expect(
      placeNameScore("Huguenot Memorial City Park", "Huguenot Park"),
    ).toBeGreaterThan(0.4);
    expect(
      placeNameScore("Huguenot Memorial City Park", "Downtown Cafe"),
    ).toBeLessThan(0.3);
  });

  it("computes small distances for nearby points", () => {
    expect(haversineMeters(30.411, -81.42, 30.4111, -81.4201)).toBeLessThan(20);
  });
});

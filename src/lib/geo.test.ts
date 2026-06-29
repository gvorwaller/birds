import { describe, expect, it } from "vitest";
import { mapsDirectionsUrl, mapsPlaceUrl } from "./geo";

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

import { afterEach, describe, expect, it, vi } from "vitest";
import { geocodePlace, reverseGeocodeLocation } from "./geocode";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("geocode place IDs", () => {
  it("returns a Google place ID from Places Text Search", async () => {
    vi.stubEnv("GOOGLE_GEOCODING_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              status: "OK",
              results: [
                {
                  name: "Fort Point State Park",
                  place_id: "ChIJtext",
                  geometry: { location: { lat: 44.467, lng: -68.811 } },
                },
              ],
            }),
          ),
      ),
    );

    await expect(geocodePlace("Fort Point State Park")).resolves.toMatchObject({
      name: "Fort Point State Park",
      place_id: "ChIJtext",
      lat: 44.467,
      lng: -68.811,
    });
  });

  it("returns a Google place ID from reverse geocoding", async () => {
    vi.stubEnv("GOOGLE_GEOCODING_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              status: "OK",
              results: [
                {
                  formatted_address: "Blue Hill, ME",
                  place_id: "ChIJreverse",
                  geometry: { location: { lat: 44.413, lng: -68.587 } },
                },
              ],
            }),
          ),
      ),
    );

    await expect(
      reverseGeocodeLocation(44.413, -68.587),
    ).resolves.toMatchObject({
      name: "Blue Hill, ME",
      place_id: "ChIJreverse",
    });
  });
});

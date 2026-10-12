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

  // Result shapes captured from Google's reverse geocoder, 2026-10-12.
  const reverseWith = (results: unknown[]) => {
    vi.stubEnv("GOOGLE_GEOCODING_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ status: "OK", results }))),
    );
  };
  const at = { geometry: { location: { lat: 65.9, lng: 11.5 } } };

  it("never labels a point by its plus code: open water takes the municipality (td-a54f8c)", async () => {
    reverseWith([
      { ...at, types: ["plus_code"], formatted_address: "9FQHVGX2+X2" },
      { ...at, types: ["postal_code"], formatted_address: "8984 Vega, Norway" },
      { ...at, types: ["postal_town"], formatted_address: "8984 Vega, Norway" },
      { ...at, types: ["administrative_area_level_2", "political"], formatted_address: "Vega Municipality, Norway", place_id: "ChIJvega" },
    ]);
    await expect(reverseGeocodeLocation(65.9, 11.5)).resolves.toMatchObject({
      name: "Vega Municipality, Norway",
      place_id: "ChIJvega",
    });
  });

  it("a compound plus code is skipped for the next real place", async () => {
    reverseWith([
      { ...at, types: ["plus_code"], formatted_address: "3C22+22 Breidstrand, Norway" },
      { ...at, types: ["route"], formatted_address: "Sandstrakveien, 8820 Dønna, Norway", place_id: "ChIJroad" },
    ]);
    await expect(reverseGeocodeLocation(66.05, 12.4)).resolves.toMatchObject({
      name: "Sandstrakveien, 8820 Dønna, Norway",
      place_id: "ChIJroad",
    });
  });

  it("open ocean (only a plus code) gives no place, so the caller shows coordinates", async () => {
    reverseWith([{ ...at, types: ["plus_code"], formatted_address: "89G22222+22" }]);
    await expect(reverseGeocodeLocation(40, -40)).resolves.toBeNull();
  });
});

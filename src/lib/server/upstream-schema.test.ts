import { describe, expect, it } from "vitest";
import {
  UpstreamSchemaError,
  validateEbirdHotspotCoordinates,
  validateEbirdHotspots,
  validateEbirdObservations,
  validateNwsForecast,
  validateNwsPoints,
} from "./upstream-schema";

const obs = {
  speciesCode: "amecro", comName: "American Crow", sciName: "Corvus brachyrhynchos",
  locId: "L1", locName: "Test", obsDt: "2026-09-20 09:00",
  lat: 30.1, lng: -81.6, locationPrivate: false,
};

describe("upstream runtime schema contracts", () => {
  it("accepts additive eBird fields but rejects renamed observation keys", () => {
    expect(validateEbirdObservations([{ ...obs, newProviderField: "fine" }], "/recent")).toHaveLength(1);
    expect(() => validateEbirdObservations([{ ...obs, speciesCode: undefined, species_code: "amecro" }], "/recent"))
      .toThrowError(/\[0\]\.speciesCode/);
  });

  it("rejects malformed hotspot coordinates with a safe endpoint in the error", () => {
    expect(() => validateEbirdHotspots([{ locId: "L1", locName: "Test", lat: "30", lng: -81 }], "/ref/hotspot/US-FL"))
      .toThrowError(/eBird schema drift.*lat/);
  });

  it("validates the coordinate-only hotspot consumer without requiring unrelated keys", () => {
    expect(validateEbirdHotspotCoordinates(
      { name: "Public hotspot", latitude: 30, longitude: -81 },
      "/ref/hotspot/info/L1",
    )).toMatchObject({ latitude: 30, longitude: -81 });
    expect(() => validateEbirdHotspotCoordinates(
      { name: "Public hotspot", lat: 30, lng: -81 },
      "/ref/hotspot/info/L1",
    )).toThrowError(/latitude/);
  });

  it("requires the NWS forecast URL and typed forecast periods", () => {
    expect(() => validateNwsPoints({ properties: { forecastUrl: "renamed" } })).toThrow(UpstreamSchemaError);
    expect(validateNwsPoints({ properties: { forecast: "https://api.weather.gov/gridpoints/JAX/1,1/forecast" } })).toEqual({
      forecastUrl: "https://api.weather.gov/gridpoints/JAX/1,1/forecast", label: null,
    });
    expect(() => validateNwsForecast({ properties: { periods: [{ name: "Today", isDaytime: true, temperature: "80" }] } }))
      .toThrowError(/temperature must be a finite number/);
  });
});

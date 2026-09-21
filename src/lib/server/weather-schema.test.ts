import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("$lib/db", () => ({ query: db.query }));
const { weatherFor } = await import("./weather");

const cached = {
  label: "Jacksonville, FL",
  periods: [{
    name: "Today", isDaytime: true, tempF: 82, precipPct: 20,
    windSpeed: "10 mph", windDirection: "E", shortForecast: "Partly Cloudy",
  }],
};
const points = { properties: {
  forecast: "https://api.weather.gov/gridpoints/JAX/1,1/forecast",
  relativeLocation: { properties: { city: "Jacksonville", state: "FL" } },
} };
const forecast = { properties: { periods: [{
  name: "Today", isDaytime: true, temperature: 82,
  probabilityOfPrecipitation: { value: 20 }, windSpeed: "10 mph",
  windDirection: "E", shortForecast: "Partly Cloudy",
}] } };

beforeEach(() => { db.query.mockReset(); vi.restoreAllMocks(); });

describe("NWS fetch and cache schema boundaries", () => {
  it("does not serve malformed fresh cache data and replaces it from NWS", async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ payload: { ...cached, periods: [{ ...cached.periods[0], tempF: "82" }] }, fetched_at: new Date().toISOString() }] })
      .mockResolvedValueOnce({ rows: [] });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(points), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(forecast), { status: 200 })));
    const result = await weatherFor(30.1, -81.6);
    expect(result).toMatchObject({ locationLabel: "Jacksonville, FL", stale: false, periods: cached.periods });
  });

  it("falls back to a valid stale row when a live NWS key is renamed", async () => {
    db.query.mockResolvedValueOnce({ rows: [{ payload: cached, fetched_at: "2020-01-01T00:00:00.000Z" }] });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ properties: { forecastUrl: "renamed" } }), { status: 200 })));
    const result = await weatherFor(30.2, -81.7);
    expect(result).toMatchObject({ locationLabel: "Jacksonville, FL", stale: true, periods: cached.periods });
  });
});

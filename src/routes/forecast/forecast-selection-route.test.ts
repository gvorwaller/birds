import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ query: vi.fn(), key: vi.fn(), geo: vi.fn(), streamed: vi.fn(), needs: vi.fn(), forecast: vi.fn() }));
vi.mock("$lib/db", () => ({ query: m.query }));
vi.mock("$server/ebird", () => ({ getEbirdApiKey: m.key, hotspotsNear: vi.fn(), EbirdError: class extends Error {} }));
vi.mock("$server/geocode", () => ({ geocodePlace: m.geo }));
vi.mock("$server/jobs", () => ({ enqueueJob: vi.fn() }));
vi.mock("$server/job-policy", () => ({ dedupKeys: {} }));
vi.mock("$server/county-meta", () => ({ countyMapQuery: vi.fn(), countySeat: vi.fn() }));
vi.mock("$lib/streamed", () => ({ streamed: m.streamed }));
vi.mock("$server/forecast", () => ({ calendarMonth: () => 9, forecastNeedsNear: m.forecast, majorityRegionCode: vi.fn(), rankCountiesForNeeds: vi.fn(), validateLocSelection: vi.fn() }));
vi.mock("$server/needs", () => ({ seenSet: m.needs }));

import { load } from "./+page.server";

const locals = { scopeId: 1, user: { id: 1, role: "user" } };
async function run(search: string) {
	const url = new URL(`https://birds.test/forecast${search}`);
	return load({ locals, url, request: new Request(url) } as never) as any;
}

beforeEach(() => {
	vi.clearAllMocks();
	m.query.mockImplementation(async (sql: string) => ({ rows: sql.includes("FROM users") ? [{ home_lat: 30, home_lon: -81, home_label: "Saved home", near_me_radius_km: 40 }] : [{ login_set: false }] }));
	m.key.mockResolvedValue("key"); m.geo.mockResolvedValue(null); m.needs.mockResolvedValue(new Set());
	m.streamed.mockImplementation((promise: Promise<unknown>) => promise); m.forecast.mockResolvedValue({ regionCode: null });
});

describe("Forecast location selection boundary", () => {
	it("does not fall back to saved Home or start analysis in chooser mode", async () => {
		const data = await run("?chooseLocation=1&month=9&returnTo=%2Fhotspots%2FL1");
		expect(data.chooseLocation).toBe(true);
		expect(data.location).toBeNull();
		expect(data.analysis).toBeNull();
		expect(data.returnLink).toMatchObject({ href: "/hotspots/L1" });
		expect(m.forecast).not.toHaveBeenCalled();
	});
	it("accepts an explicit valid pin while preserving chooser provenance", async () => {
		const data = await run("?chooseLocation=1&lat=0&lng=0&loc=Zero%20Park&month=9");
		expect(data.location).toMatchObject({ lat: 0, lng: 0, label: "Zero Park" });
		expect(data.originKind).toBe("pin");
		expect(data.analysis).not.toBeNull();
	});
	it("keeps a failed typed place from falling back to Home", async () => {
		m.geo.mockResolvedValue(null);
		const data = await run("?place=Missing%20Park&month=9");
		expect(data.location).toBeNull();
		expect(data.error).toContain("Couldn't find");
	});
	it("keeps ordinary bare Forecast arrivals on saved Home", async () => {
		const data = await run("?month=9");
		expect(data.location).toMatchObject({ lat: 30, lng: -81, label: "Saved home" });
		expect(data.originKind).toBe("home");
	});
	it("rejects empty and out-of-range pins instead of selecting them", async () => {
		const empty = await run("?chooseLocation=1&lat=&lng=&loc=Empty");
		const bad = await run("?chooseLocation=1&lat=91&lng=0&loc=Bad");
		expect(empty.location).toBeNull();
		expect(bad.location).toBeNull();
	});
});

/**
 * td-46fff6: the "What can I see?" loader adds other sources' reports near
 * the point. The card is read with the shell (it renders without
 * JavaScript); its failure never hides the eBird analysis. A source covering
 * eBird's region with nothing loaded rides on the analysis stream, and its
 * failure never fails the analysis.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	query: vi.fn(),
	key: vi.fn(),
	forecast: vi.fn(),
	near: vi.fn(),
	sources: vi.fn(),
}));
vi.mock("$lib/db", () => ({ query: m.query }));
vi.mock("$server/ebird", () => ({ getEbirdApiKey: m.key, hotspotsNear: vi.fn(), EbirdError: class extends Error {} }));
vi.mock("$server/geocode", () => ({ geocodePlace: vi.fn() }));
vi.mock("$server/jobs", () => ({ enqueueJob: vi.fn() }));
vi.mock("$server/job-policy", () => ({ dedupKeys: {} }));
vi.mock("$server/county-meta", () => ({ countyMapQuery: vi.fn(), countySeat: vi.fn() }));
vi.mock("$server/forecast", () => ({
	calendarMonth: () => 9,
	forecastNeedsNear: m.forecast,
	majorityRegionCode: vi.fn(),
	rankCountiesForNeeds: async () => [],
	validateLocSelection: vi.fn(),
}));
vi.mock("$server/needs", () => ({ seenSet: async () => new Set() }));
vi.mock("$server/external-sources/near", () => ({ externalNear: m.near }));
vi.mock("$server/external-sources/reports", () => ({ externalSourcesForRegion: m.sources }));

import { load } from "./+page.server";

const locals = { scopeId: 7, user: { id: 7, role: "user" } };
async function run(search: string) {
	const url = new URL(`https://birds.test/forecast${search}`);
	return load({ locals, url, request: new Request(url) } as never) as any;
}
const PIN = "?lat=66.0217&lng=12.6316&loc=Sandnessj%C3%B8en&month=10&dist=50";
const state = (published: boolean) => ({
	source: { id: "artsobs" },
	published: published ? { loadId: "x" } : null,
	active: null,
	failed: null,
});

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "error").mockImplementation(() => {});
	m.query.mockImplementation(async (sql: string) => ({
		rows: sql.includes("FROM users") ? [{ home_lat: null, home_lon: null, home_label: null, near_me_radius_km: 40 }] : [],
	}));
	m.key.mockResolvedValue("key");
	m.forecast.mockResolvedValue({ regionCode: "NO-19", regionName: "Troms" });
	m.near.mockResolvedValue([{ source: { id: "artsobs" }, reports: 3 }]);
	m.sources.mockResolvedValue([state(false)]);
});

describe("Forecast → reports near the point", () => {
	it("reads them for the point, radius, month and viewer scope, with the shell", async () => {
		const d = await run(PIN);
		expect(m.near).toHaveBeenCalledWith({ lat: 66.0217, lon: 12.6316, radiusKm: 50, month: 10, userId: 7 });
		expect(d.externalNear).toEqual([{ source: { id: "artsobs" }, reports: 3 }]);
	});

	it("leaves the card out, and keeps the eBird analysis, when the read fails", async () => {
		m.near.mockRejectedValue(new Error("boom"));
		const d = await run(PIN);
		expect(d.externalNear).toEqual([]);
		const a = await d.analysis;
		expect(a.ok).toBe(true);
		expect(a.data.view.regionCode).toBe("NO-19");
	});

	it("reads nothing without a location", async () => {
		const d = await run("");
		expect(m.near).not.toHaveBeenCalled();
		expect(d.externalNear).toEqual([]);
	});

	it("streams the sources that cover eBird's region but have nothing loaded there", async () => {
		m.sources.mockResolvedValue([state(false), { ...state(true), source: { id: "other" } }]);
		const a = await (await run(PIN)).analysis;
		expect(m.sources).toHaveBeenCalledWith("NO-19");
		expect(a.data.externalUnloaded).toEqual([{ ...state(false), regionCode: "NO-19", regionName: "Troms" }]);
	});

	it("keeps the analysis when that lookup fails, and skips it without a region", async () => {
		m.sources.mockRejectedValue(new Error("boom"));
		let a = await (await run(PIN)).analysis;
		expect(a.ok).toBe(true);
		expect(a.data.externalUnloaded).toEqual([]);
		m.sources.mockClear();
		m.forecast.mockResolvedValue({ regionCode: null, regionName: null });
		a = await (await run(PIN)).analysis;
		expect(m.sources).not.toHaveBeenCalled();
		expect(a.data.externalUnloaded).toEqual([]);
	});
});

describe("Forecast page → the pointer and the card", () => {
	const page = readFileSync(new URL("./+page.svelte", import.meta.url), "utf8");
	it("points from the eBird card to the source's card, apart from the eBird numbers", () => {
		expect(page).toContain('<a href="#ext-near-{x.id}"');
		expect(page).toContain("needed species reported within ${formatDistance(data.dist, \"mi\")}");
		expect(page).toMatch(/\.extpointer a \{[^}]*min-height: 48px;/);
		// The pointer is its own line, never inside the eBird "likely" summary.
		const summary = page.slice(page.indexOf('<p class="summary">'), page.indexOf("</p>", page.indexOf('<p class="summary">')));
		expect(summary).not.toContain("ext");
	});

	it("renders the card with the shell's data and the streamed unloaded sources", () => {
		expect(page).toContain("cards={data.externalNear}");
		expect(page).toContain("unloaded={externalUnloaded}");
		expect(page).toContain("canLoad={!data.isViewer}");
	});
});

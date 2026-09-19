import { describe, expect, it } from "vitest";
import { hotspotForecastHref } from "./place-forecast";

describe("hotspotForecastHref", () => {
	it("keeps zero coordinates and the actual name/month", () => {
		const u = new URL(hotspotForecastHref({ locId: "L1", locName: "Zero Park", lat: 0, lng: 0, month: 9, returnTo: "/trips/9" }), "https://birds.test");
		expect(u.pathname).toBe("/forecast");
		expect(u.searchParams.get("lat")).toBe("0.00000");
		expect(u.searchParams.get("lng")).toBe("0.00000");
		expect(u.searchParams.get("loc")).toBe("Zero Park");
		expect(u.searchParams.get("month")).toBe("9");
		expect(u.searchParams.get("returnTo")).toBe("/trips/9");
	});
	it("requires a bounded finite coordinate pair and offers explicit choice", () => {
		const u = new URL(hotspotForecastHref({ locId: "L2", locName: "Unknown", lat: null, lng: 2, month: 4, returnTo: "/hotspots/L2?tab=monthly" }), "https://birds.test");
		expect(u.searchParams.get("chooseLocation")).toBe("1");
		expect(u.searchParams.get("month")).toBe("4");
		expect(u.searchParams.get("returnTo")).toBe("/hotspots/L2?tab=monthly");
	});
});

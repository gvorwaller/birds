import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Help route — migration ribbon copy (td-950907)", () => {
	it("documents species-page section navigation and preserved return paths", () => {
		const content = readFileSync("src/routes/help/+page.svelte", "utf8");
		const normalized = content.replace(/\s+/g, " ");
		expect(normalized).toContain("Jump to an answer");
		expect(normalized).toContain("On this page");
		expect(normalized).toContain("reopens automatically");
		expect(normalized).toContain("return path intact");
	});

	// The current chart supports selecting a square on all screen sizes;
	// phones also provide month controls. Keep both paths documented.
	it("describes region-drill picking correctly on both phone and larger screens", () => {
		const content = readFileSync("src/routes/help/+page.svelte", "utf8");
		// Source text wraps across lines; collapse whitespace the way a
		// browser would render it before matching the full sentence.
		const normalized = content.replace(/\s+/g, " ");
		expect(normalized).toContain(
			"Tap a square to see its reporting rate and the regions behind that latitude band. On a phone, you can also use the month slider or ◀ ▶ buttons.",
		);
		expect(content).not.toContain("Tapping a cell opens the regions behind it");
	});

	it("describes the seasonal summary card and Latitudes toggle (td-476c32)", () => {
		const content = readFileSync("src/routes/help/+page.svelte", "utf8");
		const normalized = content.replace(/\s+/g, " ");
		expect(normalized).toContain("summary card");
		expect(normalized).toContain("Species range");
		expect(normalized).toContain("Full globe");
		expect(normalized).toContain("geographic landmarks");
	});

	it("documents Field Guide county, hotspot and map/radius location choices (td-82fbc1)", () => {
		const content = readFileSync("src/routes/help/+page.svelte", "utf8");
		const normalized = content.replace(/\s+/g, " ");
		expect(normalized).toContain("County / equivalent");
		expect(normalized).toContain("Verified hotspot");
		expect(normalized).toContain("changing a higher level clears the lower ones");
		expect(normalized).toContain("narrower than its county");
		expect(normalized).toContain("places without loaded data are not covered");
		expect(normalized).toContain("Clear location only");
		expect(normalized).toContain("Choose on map");
		expect(normalized).toContain("Apply location");
		expect(normalized).toContain("radius from 1 to 200 miles");
		expect(normalized).toContain("No radius is chosen for you");
		expect(normalized).toContain("could not be checked");
		expect(normalized).toContain("coverage is unavailable, not zero birds");
		expect(normalized).toContain("needs JavaScript");
		expect(normalized).toContain("does not change your saved Home location");
		expect(normalized).toContain("does not fetch anything from eBird");
	});
});

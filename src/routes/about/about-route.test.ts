import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("About route and navigation", () => {
	it("has src/routes/about/+page.svelte", () => {
		expect(existsSync("src/routes/about/+page.svelte")).toBe(true);
	});

	it("contains overview, data sources, and version history in +page.svelte", () => {
		const content = readFileSync("src/routes/about/+page.svelte", "utf8");
		expect(content).toContain("About birds");
		expect(content).toContain("Overview");
		expect(content).toContain("Data Sources");
		expect(content).toContain("Version History");
		expect(content).toContain("v0.1.0");
	});

	it("places the About link below Help in the hamburger drawer", () => {
		const layout = readFileSync("src/routes/+layout.svelte", "utf8");
		const helpIdx = layout.indexOf('href="/help"');
		const aboutIdx = layout.indexOf('href="/about"');

		expect(helpIdx, "Layout must contain Help link").toBeGreaterThan(-1);
		expect(aboutIdx, "Layout must contain About link").toBeGreaterThan(-1);
		expect(aboutIdx, "About link must be placed after/below Help link").toBeGreaterThan(helpIdx);
	});

	// GROK P3 (td-950907): the v0.1.6 entry must describe the migration
	// ribbon's actual phone behavior (band-only picking, P1-1), not claim it
	// "works the same way" on a phone as on a desktop. CODEX1 re-check:
	// scope the assertion to the v0.1.6 entry itself (between its own
	// `<!-- v0.1.6 -->` marker and the next `<!-- v0.1.` marker) — a plain
	// whole-file search would pass even if this sentence leaked into a
	// different version's entry instead.
	it("v0.1.6 describes the phone-specific migration ribbon interaction", () => {
		const content = readFileSync("src/routes/about/+page.svelte", "utf8");
		const start = content.indexOf("<!-- v0.1.6 -->");
		expect(start, "v0.1.6 entry marker not found").toBeGreaterThan(-1);
		const end = content.indexOf("<!-- v0.1.", start + 1);
		expect(end, "next version marker not found after v0.1.6").toBeGreaterThan(start);
		const entry = content.slice(start, end);
		// Source text wraps across lines; collapse whitespace the way a
		// browser would render it before matching the full sentence.
		const normalized = entry.replace(/\s+/g, " ");
		expect(normalized).toContain(
			"On a phone, tap any square or use the slider; on larger screens tap any square.",
		);
	});

	it("v0.1.6 describes seasonal summary card, auto-crop latitudes toggle, and landmarks (td-476c32)", () => {
		const content = readFileSync("src/routes/about/+page.svelte", "utf8");
		const start = content.indexOf("<!-- v0.1.6 -->");
		const end = content.indexOf("<!-- v0.1.", start + 1);
		const entry = content.slice(start, end);
		const normalized = entry.replace(/\s+/g, " ");
		expect(normalized).toContain("seasonal summary card");
		expect(normalized).toContain("occupied latitudinal range");
		expect(normalized).toContain("Latitudes toggle");
		expect(normalized).toContain("geographic landmark anchors");
	});

	it("v0.1.6 describes desktop All continents starting on species data-derived primary column (CODEX13 P2)", () => {
		const content = readFileSync("src/routes/about/+page.svelte", "utf8");
		const start = content.indexOf("<!-- v0.1.6 -->");
		const end = content.indexOf("<!-- v0.1.", start + 1);
		const entry = content.slice(start, end);
		const normalized = entry.replace(/\s+/g, " ");
		expect(normalized).toContain(
			"All continents (starting on the species' data-derived primary column) at desktop widths"
		);
	});

	it("v0.1.6 announces Field Guide county, hotspot and map/radius selection (td-82fbc1)", () => {
		const content = readFileSync("src/routes/about/+page.svelte", "utf8");
		const start = content.indexOf("<!-- v0.1.6 -->");
		const end = content.indexOf("<!-- v0.1.", start + 1);
		const normalized = content.slice(start, end).replace(/\s+/g, " ");
		expect(normalized).toContain("Field Guide by county, hotspot or map");
		expect(normalized).toContain("1 to 200 miles");
		expect(normalized).toContain("unavailable rather than empty");
		expect(normalized).toContain("does not fetch new bird data from eBird");
		expect(normalized).not.toContain("fetches nothing");
		expect(normalized).toContain("leaves your Home location alone");
	});

	it("v0.1.6 announces Hotspots & data discovery without implying it loads data (td-687b1c)", () => {
		const content = readFileSync("src/routes/about/+page.svelte", "utf8");
		const start = content.indexOf("<!-- v0.1.6 -->");
		const end = content.indexOf("<!-- v0.1.", start + 1);
		const normalized = content.slice(start, end).replace(/\s+/g, " ");
		expect(normalized).toContain("Find places on Hotspots &amp; data by name or map");
		expect(normalized).toContain("1 to 200 miles");
		expect(normalized).toContain("50 per page with an exact total");
		expect(normalized).toContain("reported location — hotspot status unverified");
		expect(normalized).toContain("Searching and selecting never load bird data or change Home");
	});
});

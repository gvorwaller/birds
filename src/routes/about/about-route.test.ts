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
			"On a phone, tap a latitude row and choose the month with the slider; on larger screens tap any square.",
		);
	});
});

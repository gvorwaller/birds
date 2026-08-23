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
});

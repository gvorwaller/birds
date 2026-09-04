import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Help route — migration ribbon copy (td-950907)", () => {
	// GROK P3: "Tapping a cell opens the regions behind it" was leftover
	// whole-cell wording — wrong on a phone, where a tap only ever picks a
	// band and the scrubber owns the month (P1-1). Pin the corrected
	// sentence and pin the stale one's absence, so it can't quietly return.
	it("describes region-drill picking correctly on both phone and larger screens", () => {
		const content = readFileSync("src/routes/help/+page.svelte", "utf8");
		// Source text wraps across lines; collapse whitespace the way a
		// browser would render it before matching the full sentence.
		const normalized = content.replace(/\s+/g, " ");
		expect(normalized).toContain(
			"Pick a band and month — a square on larger screens, a latitude row plus the slider on a phone — to open the regions behind it, sorted by how often they report the bird, showing the 40 highest.",
		);
		expect(content).not.toContain("Tapping a cell opens the regions behind it");
	});
});

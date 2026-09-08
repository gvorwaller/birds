import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Help route — migration ribbon copy (td-950907)", () => {
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
});

import { describe, expect, it } from "vitest";
import { normalizeTripStopNote, plannerTargetNote } from "./planner-note";

describe("planner trip stop notes", () => {
  it("writes planner-selected targets without a competing current count", () => {
    expect(
      plannerTargetNote(
        ["Northern Rough-winged Swallow", "King Rail"],
        "2026-06-16",
      ),
    ).toBe(
      "Planner-selected targets (last seen 2026-06-16): Northern Rough-winged Swallow, King Rail.",
    );
  });

  it("normalizes legacy planner notes that included stale counts", () => {
    expect(
      normalizeTripStopNote(
        "2 of your needs reported here (last seen 2026-06-16): Northern Rough-winged Swallow, King Rail.",
      ),
    ).toBe(
      "Planner-selected targets (last seen 2026-06-16): Northern Rough-winged Swallow, King Rail.",
    );
  });

  it("leaves custom notes alone", () => {
    expect(normalizeTripStopNote("Scope the north pond first.")).toBe(
      "Scope the north pond first.",
    );
  });
});

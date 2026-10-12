import { describe, expect, it } from "vitest";
import { quietAreaMessage, reportDay } from "./home-quiet-area";

describe("Home quiet-area line (td-a54f8c)", () => {
  it("names the most recent report among the hotspots in range", () => {
    expect(
      quietAreaMessage("50 km", "last 30 days", [
        { locName: "Søvik ferjekai", latestObsDt: "2026-08-02 10:00" },
        { locName: "Onøy til Lovund ferge", latestObsDt: "2026-09-09 14:12" },
        { locName: "Nameless", latestObsDt: null },
      ]),
    ).toBe(
      "No eBird reports within 50 km in the last 30 days. The 3 eBird hotspots in range are on the map; the most recent report at one of them was Onøy til Lovund ferge on Sep 9, 2026.",
    );
  });

  it("one hotspot, no hotspots, and hotspots with no reports", () => {
    expect(quietAreaMessage("8 km", "last 7 days", [{ locName: "Tjøtta", latestObsDt: "2026-07-01 08:00" }])).toBe(
      "No eBird reports within 8 km in the last 7 days. The eBird hotspot in range, Tjøtta, is on the map; its most recent report was on Jul 1, 2026.",
    );
    expect(quietAreaMessage("5 mi", "last 24 hours", [])).toBe("No eBird reports within 5 mi in the last 24 hours.");
    expect(quietAreaMessage("50 km", "last 30 days", [{ locName: "A", latestObsDt: null }, { locName: "B", latestObsDt: "bad" }])).toBe(
      "No eBird reports within 50 km in the last 30 days. The 2 eBird hotspots in range are on the map.",
    );
  });

  it("reportDay reads eBird's date and rejects anything else", () => {
    expect(reportDay("2026-09-09 14:12")).toBe("Sep 9, 2026");
    expect(reportDay("Sep 9")).toBeNull();
    expect(reportDay(null)).toBeNull();
  });
});

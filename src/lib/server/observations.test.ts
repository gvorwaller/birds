import { describe, expect, it } from "vitest";
import type { EbirdObs } from "./ebird";
import {
  mergeSpeciesObservations,
  speciesObservationDetails,
} from "./observations";
import { aggregate } from "./needs";

function obs(
  p: Partial<EbirdObs> &
    Pick<
      EbirdObs,
      "speciesCode" | "comName" | "locId" | "locName" | "obsDt" | "lat" | "lng"
    >,
): EbirdObs {
  return {
    sciName: `${p.comName} sci`,
    howMany: 1,
    obsValid: true,
    obsReviewed: false,
    locationPrivate: false,
    ...p,
  };
}

describe("mergeSpeciesObservations", () => {
  it("includes notable-only observations and de-dupes rows already in recent results", () => {
    const downtownBangor = obs({
      speciesCode: "fiscro",
      comName: "Fish Crow",
      locId: "L1",
      locName: "Downtown Bangor",
      obsDt: "2026-06-27 11:55",
      lat: 44.801,
      lng: -68.777,
    });
    const recentHarbor = obs({
      speciesCode: "fiscro",
      comName: "Fish Crow",
      locId: "L2",
      locName: "Harbor",
      obsDt: "2026-06-26 09:00",
      lat: 44.4,
      lng: -68.6,
    });
    const otherSpecies = obs({
      speciesCode: "amecro",
      comName: "American Crow",
      locId: "L3",
      locName: "Elsewhere",
      obsDt: "2026-06-27 12:00",
      lat: 44.7,
      lng: -68.7,
    });

    const merged = mergeSpeciesObservations(
      "fiscro",
      [recentHarbor, downtownBangor],
      [downtownBangor, otherSpecies],
    );

    expect(merged.map((o) => o.locName)).toEqual(["Harbor", "Downtown Bangor"]);
  });
});

describe("speciesObservationDetails", () => {
  it("returns every species report so detail rows stay consistent with summary counts", () => {
    const reports = Array.from({ length: 20 }, (_, i) =>
      obs({
        speciesCode: "comloo",
        comName: "Common Loon",
        locId: `L${i + 1}`,
        locName: `Lake ${i + 1}`,
        obsDt: `2026-07-${String((i % 7) + 1).padStart(2, "0")} 08:00`,
        howMany: i % 2 === 0 ? 2 : 1,
        lat: 44.4 + i * 0.01,
        lng: -68.6 - i * 0.01,
      }),
    );

    const summary = aggregate(
      reports,
      { lat: 44.413, lon: -68.588 },
      new Map(),
    ).get("comloo")!;
    const detail = speciesObservationDetails(reports, {
      lat: 44.413,
      lon: -68.588,
    });

    expect(detail).toHaveLength(reports.length);
    expect(new Set(detail.map((o) => o.locId)).size).toBe(
      summary.locationCount,
    );
    expect(detail.reduce((sum, o) => sum + (o.howMany ?? 1), 0)).toBe(
      summary.totalCount,
    );
  });
});

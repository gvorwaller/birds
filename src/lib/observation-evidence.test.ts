import { describe, expect, it } from "vitest";
import { observationIdentity, reportStatus } from "./observation-evidence";

const base = { speciesCode: "naswar", lat: 30, lng: -81, obsDt: "2026-09-18 13:16" };

describe("observation evidence identity", () => {
  it("keeps distinct named checklists at one place and time", () => {
    expect(observationIdentity({ ...base, locId: "L1", subId: "S1" })).not.toBe(
      observationIdentity({ ...base, locId: "L1", subId: "S2" }),
    );
  });
  it("uses anonymous species/place/time identity without inventing a checklist", () => {
    expect(observationIdentity({ ...base, locId: "L1" })).toBe(
      observationIdentity({ ...base, locId: "L1" }),
    );
  });
  it("merges review status conservatively", () => {
    expect(reportStatus({ obsValid: false })).toBe("unconfirmed");
    expect(reportStatus({ obsValid: true })).toBe("accepted");
    expect(reportStatus({})).toBe("review-unavailable");
  });
});

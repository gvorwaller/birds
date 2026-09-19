import { describe, expect, it } from "vitest";
import { jobPresentationText } from "./job-presentation";

describe("jobPresentationText", () => {
  it("covers progress, control, schedule, terminal, and unknown states honestly", () => {
    expect(jobPresentationText({ state: "running" }, { unitsTotal: 0 })).toContain("progress not yet reported");
    expect(jobPresentationText({ state: "running", explanation: "worker unconfirmed" }, { unitsTotal: 2, unitsDone: 1 })).toContain("worker unconfirmed");
    expect(jobPresentationText({ state: "cancelling" })).toBe("Cancelling");
    expect(jobPresentationText({ state: "paused", explanation: "worker paused" })).toContain("worker paused");
    expect(jobPresentationText({ state: "retry-scheduled", nextEligibleAt: "2026-09-19T12:30:00Z" })).toMatch(/Retry scheduled at .*19/);
    expect(jobPresentationText({ state: "scheduled" })).toContain("time not available");
    expect(jobPresentationText({ state: "waiting-worker" })).toBe("Waiting for worker");
    expect(jobPresentationText({ state: "complete" })).toBe("Complete");
    expect(jobPresentationText({ state: "mystery" })).toBe("Status unavailable");
  });
});

import { describe, expect, it } from "vitest";
import { loopVerdict, mergeFailures } from "./forecast-load-core";

const ensure = (over: Partial<Parameters<typeof loopVerdict>[0]>) => ({
  refreshed: [],
  failed: [],
  notAttempted: [],
  credentialProblem: null,
  busy: false,
  ...over,
});

describe("loopVerdict", () => {
  it("continues while there is progress and work remaining", () => {
    expect(
      loopVerdict(ensure({ refreshed: ["L1"], notAttempted: ["L2", "L3"] })),
    ).toEqual({ next: "continue" });
    // A failure still counts as progress — the batch moved past it.
    expect(
      loopVerdict(
        ensure({
          failed: [{ code: "L1", error: "500" }],
          notAttempted: ["L2"],
        }),
      ),
    ).toEqual({ next: "continue" });
  });

  it("finishes when nothing remains", () => {
    expect(loopVerdict(ensure({ refreshed: ["L1"] }))).toEqual({
      next: "done",
    });
  });

  it("stops hard on credential problems and competing batches", () => {
    expect(
      loopVerdict(
        ensure({ credentialProblem: "bad login", notAttempted: ["L2"] }),
      ),
    ).toEqual({ next: "stop", reason: "credential" });
    expect(loopVerdict(ensure({ busy: true, notAttempted: ["L2"] }))).toEqual({
      next: "stop",
      reason: "busy",
    });
  });

  it("stops instead of spinning when a round made zero progress", () => {
    // e.g. daily cap reached: everything notAttempted, nothing moved.
    expect(loopVerdict(ensure({ notAttempted: ["L2", "L3"] }))).toEqual({
      next: "stop",
      reason: "stalled",
    });
  });
});

describe("mergeFailures", () => {
  it("dedupes by location keeping the newest error", () => {
    const merged = mergeFailures(
      [{ code: "L1", error: "HTTP 500" }],
      [
        { code: "L1", error: "HTTP 503" },
        { code: "L2", error: "HTTP 500" },
      ],
    );
    expect(merged).toEqual([
      { code: "L1", error: "HTTP 503" },
      { code: "L2", error: "HTTP 500" },
    ]);
  });
});

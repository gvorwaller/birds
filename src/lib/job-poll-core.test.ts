import { describe, expect, it } from "vitest";
import {
  INVALIDATE_THROTTLE_MS,
  POLL_ACTIVE_MS,
  POLL_WAITING_MS,
  classifyPollResponse,
  isActive,
  nextIntervalMs,
  shouldInvalidate,
  terminalTransitions,
  type PolledJob,
} from "./job-poll-core";

function job(
  id: number,
  status: string,
  progress: PolledJob["progress"] = {},
): PolledJob {
  return { id, status, progress };
}

describe("nextIntervalMs", () => {
  it("stops (null) when nothing is active", () => {
    expect(nextIntervalMs([])).toBeNull();
    expect(nextIntervalMs([job(1, "succeeded"), job(2, "failed")])).toBeNull();
  });

  it("polls fast while anything runs or waits to start", () => {
    expect(nextIntervalMs([job(1, "running")])).toBe(POLL_ACTIVE_MS);
    expect(nextIntervalMs([job(1, "pending")])).toBe(POLL_ACTIVE_MS);
  });

  it("polls lazily when ALL active jobs are waiting out a retry backoff", () => {
    expect(
      nextIntervalMs([job(1, "pending", { phase: "waiting_retry" })]),
    ).toBe(POLL_WAITING_MS);
    // One genuinely active job keeps the fast cadence.
    expect(
      nextIntervalMs([
        job(1, "pending", { phase: "waiting_retry" }),
        job(2, "running"),
      ]),
    ).toBe(POLL_ACTIVE_MS);
  });
});

describe("classifyPollResponse", () => {
  it("401/403 and redirects are auth stops", () => {
    expect(classifyPollResponse(401, "application/json", true).kind).toBe("auth");
    expect(classifyPollResponse(403, null, false).kind).toBe("auth");
    expect(classifyPollResponse(303, null, false).kind).toBe("auth");
  });

  it("200 JSON is ok; 200 HTML is the historic login-page trap → auth (GROK #1)", () => {
    expect(classifyPollResponse(200, "application/json", true).kind).toBe("ok");
    // Content-type missing but body looks like JSON → still ok.
    expect(classifyPollResponse(200, null, true).kind).toBe("ok");
    expect(classifyPollResponse(200, "text/html", false).kind).toBe("auth");
  });

  it("5xx and network-ish statuses are transient errors", () => {
    expect(classifyPollResponse(500, null, false).kind).toBe("error");
    expect(classifyPollResponse(502, "text/html", false).kind).toBe("error");
    expect(classifyPollResponse(0, null, false).kind).toBe("error");
  });
});

describe("terminalTransitions", () => {
  it("detects active→terminal crossings only", () => {
    const prev = [job(1, "running"), job(2, "pending"), job(3, "succeeded")];
    const next = [job(1, "succeeded"), job(2, "pending"), job(3, "succeeded")];
    expect(terminalTransitions(prev, next)).toEqual([1]);
  });

  it("a job first seen already-terminal is not a transition", () => {
    expect(terminalTransitions([], [job(9, "failed")])).toEqual([]);
  });
});

describe("shouldInvalidate", () => {
  const t0 = 1_000_000;

  it("terminal transitions always invalidate, even inside the throttle window", () => {
    const prev = [job(1, "running")];
    const next = [job(1, "succeeded")];
    expect(shouldInvalidate(prev, next, t0 - 1, t0)).toBe(true);
  });

  it("unit progress invalidates only outside the throttle window", () => {
    const prev = [job(1, "running", { unitsDone: 3 })];
    const next = [job(1, "running", { unitsDone: 5 })];
    expect(shouldInvalidate(prev, next, t0, t0 + INVALIDATE_THROTTLE_MS - 1)).toBe(
      false,
    );
    expect(shouldInvalidate(prev, next, t0, t0 + INVALIDATE_THROTTLE_MS)).toBe(true);
  });

  it("heartbeat-only ticks never invalidate", () => {
    const prev = [job(1, "running", { unitsDone: 3 })];
    const next = [job(1, "running", { unitsDone: 3 })];
    expect(shouldInvalidate(prev, next, 0, t0)).toBe(false);
  });
});

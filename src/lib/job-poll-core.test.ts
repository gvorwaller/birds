import { describe, expect, it } from "vitest";
import {
  INVALIDATE_THROTTLE_MS,
  POLL_ACTIVE_MS,
  POLL_WAITING_MS,
  STALE_AFTER_MS,
  classifyPollResponse,
  invalidateStep,
  isActive,
  isStaleNow,
  nextIntervalMs,
  shouldInvalidate,
  terminalTransitions,
  type InvalidateState,
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

describe("isStaleNow", () => {
  it("flips true only past the threshold and never with a clear staleSince", () => {
    const t0 = 50_000;
    expect(isStaleNow(null, t0)).toBe(false);
    expect(isStaleNow(t0, t0)).toBe(false);
    expect(isStaleNow(t0, t0 + STALE_AFTER_MS)).toBe(false);
    expect(isStaleNow(t0, t0 + STALE_AFTER_MS + 1)).toBe(true);
    // The manager re-evaluates on EVERY failed poll (cadence ≤ 15s), so the
    // first failure past the threshold flips rune state (CODEX1 re-review #4).
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

describe("invalidateStep — the owed-refresh latch (td-671082 / CODEX1)", () => {
  const t0 = 1_000_000;
  const fresh: InvalidateState = { pending: false, lastInvalidateAt: 0 };
  const running = [job(1, "running")];
  const done = [job(1, "succeeded")];

  it("a terminal transition during navigation is LATCHED, then fires EXACTLY ONCE on the first quiet on-forecast tick — even with identical snapshots", () => {
    // Tick 1: job finishes while navigating → no fire, owed.
    const s1 = invalidateStep(fresh, running, done, true, true, t0);
    expect(s1.fire).toBe(false);
    expect(s1.state.pending).toBe(true);
    // Tick 2: navigation quiet, snapshots now IDENTICAL (done → done) —
    // shouldInvalidate alone can't see it; the latch carries it.
    const s2 = invalidateStep(s1.state, done, done, false, true, t0 + 2500);
    expect(s2.fire).toBe(true);
    expect(s2.state.pending).toBe(false);
    // Tick 3: nothing owed, nothing new → quiet.
    const s3 = invalidateStep(s2.state, done, done, false, true, t0 + 5000);
    expect(s3.fire).toBe(false);
  });

  it("GRACE-STOP sequence: terminal while gated → gated grace tick → poller stops → forecast arrival drains EXACTLY once (CODEX1 re-review)", () => {
    // Tick 1: job goes terminal while navigation is active → latched.
    const s1 = invalidateStep(fresh, running, done, true, true, t0);
    expect(s1.fire).toBe(false);
    expect(s1.state.pending).toBe(true);
    // Tick 2 (the single grace poll): STILL gated — user is mid-navigation
    // or off-forecast. The poller stops after this; no more poll ticks exist.
    const s2 = invalidateStep(s1.state, done, done, true, false, t0 + 15_000);
    expect(s2.fire).toBe(false);
    expect(s2.state.pending).toBe(true);
    // Later: the layout's afterNavigate → jobsPoll.onNavigated() calls with
    // identical snapshots on a quiet router, on a forecast page.
    const s3 = invalidateStep(s2.state, done, done, false, true, t0 + 60_000);
    expect(s3.fire).toBe(true);
    expect(s3.state.pending).toBe(false);
    // A second arrival owes nothing.
    const s4 = invalidateStep(s3.state, done, done, false, true, t0 + 90_000);
    expect(s4.fire).toBe(false);
  });

  it("a transition observed OFF forecast pages latches and drains on arrival", () => {
    const s1 = invalidateStep(fresh, running, done, false, false, t0);
    expect(s1.fire).toBe(false);
    expect(s1.state.pending).toBe(true);
    const s2 = invalidateStep(s1.state, done, done, false, true, t0 + 2500);
    expect(s2.fire).toBe(true);
  });

  it("quiet on-forecast transitions fire immediately (no behavior change)", () => {
    const s = invalidateStep(fresh, running, done, false, true, t0);
    expect(s.fire).toBe(true);
    expect(s.state.lastInvalidateAt).toBe(t0);
  });

  it("no qualifying change → never owed, never fires", () => {
    const s = invalidateStep(fresh, running, running, true, true, t0);
    expect(s.fire).toBe(false);
    expect(s.state.pending).toBe(false);
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

describe("scheduled singletons (td-b7d021 pin a)", () => {
  const scheduled = { id: 1, status: "pending", scheduled: true, progress: {} };
  const real = { id: 2, status: "running", progress: {} };
  it("a scheduled job is never active", () => {
    expect(isActive(scheduled as never)).toBe(false);
    expect(isActive(real as never)).toBe(true);
  });
  it("scheduled-only → nextIntervalMs null (idle poll, chip dark)", () => {
    expect(nextIntervalMs([scheduled] as never)).toBeNull();
    expect(nextIntervalMs([scheduled, real] as never)).not.toBeNull();
  });
});

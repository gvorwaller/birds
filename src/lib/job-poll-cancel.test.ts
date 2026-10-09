/**
 * td-b99b6d Rev 3.1: a cancel that does not go through (503 job_busy while
 * the worker holds the job row, another non-OK answer, or a network error)
 * is shown inline — the server's own message when it sent one — and the jobs
 * poll keeps running. The page renders `jobsPoll.cancelNotice` in an
 * always-mounted role="status" region (forecast/data).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$app/environment", () => ({ browser: true }));
vi.mock("$app/navigation", () => ({ invalidateAll: vi.fn() }));
vi.mock("$app/state", () => ({ navigating: { to: null } }));

const BUSY =
  "That job is finishing a step — try cancelling again in a few seconds.";
const running = { id: 5, type: "load_region", status: "running", progress: {} };

let polls = 0;
let cancelAnswer: () => Promise<Response>;
let jobsNow: unknown[] = [running];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  polls = 0;
  jobsNow = [running];
  vi.stubGlobal("document", {
    addEventListener: vi.fn(),
    visibilityState: "visible",
  });
  vi.stubGlobal("window", { addEventListener: vi.fn() });
  vi.stubGlobal("location", { pathname: "/forecast/data" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/jobs") {
        polls++;
        return json({ worker: { alive: true }, jobs: jobsNow });
      }
      return cancelAnswer();
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const { jobsPoll } = await import("./job-poll.svelte");
const {
  CANCEL_FAILED_MESSAGE,
  CANCEL_UNREACHABLE_MESSAGE,
  cancelFailureMessage,
} = await import("./job-poll-core");

describe("cancel feedback", () => {
  it("503 job_busy shows the server's message and the poll continues", async () => {
    cancelAnswer = async () => json({ error: "job_busy", message: BUSY }, 503);
    await jobsPoll.cancel(5);
    expect(jobsPoll.cancelNotice).toEqual({ jobId: 5, message: BUSY });
    await vi.advanceTimersByTimeAsync(0);
    const after = polls;
    expect(after).toBeGreaterThanOrEqual(1); // an immediate poll after the cancel
    await vi.advanceTimersByTimeAsync(2_600);
    expect(polls).toBeGreaterThan(after); // still polling at the active cadence
    expect(jobsPoll.cancelNotice?.message).toBe(BUSY); // the job is still running
  });

  it("a network error shows the unreachable line; a later successful cancel clears it", async () => {
    cancelAnswer = async () => {
      throw new TypeError("Failed to fetch");
    };
    await jobsPoll.cancel(5);
    expect(jobsPoll.cancelNotice).toEqual({
      jobId: 5,
      message: CANCEL_UNREACHABLE_MESSAGE,
    });
    cancelAnswer = async () => json({ outcome: "flagged" });
    await jobsPoll.cancel(5);
    expect(jobsPoll.cancelNotice).toBeNull();
  });

  it("the notice clears once that job is no longer outstanding", async () => {
    cancelAnswer = async () => json({ error: "job_busy", message: BUSY }, 503);
    await jobsPoll.cancel(5);
    expect(jobsPoll.cancelNotice).not.toBeNull();
    jobsNow = [{ ...running, status: "cancelled" }];
    await vi.advanceTimersByTimeAsync(2_600);
    expect(jobsPoll.cancelNotice).toBeNull();
  });

  it("message choice: the server's message, else a generic retry line — never raw bodies", () => {
    expect(cancelFailureMessage({ error: "job_busy", message: BUSY })).toBe(
      BUSY,
    );
    expect(cancelFailureMessage(null)).toBe(CANCEL_FAILED_MESSAGE);
    expect(cancelFailureMessage({ message: "" })).toBe(CANCEL_FAILED_MESSAGE);
    expect(cancelFailureMessage({ message: 42 })).toBe(CANCEL_FAILED_MESSAGE);
    expect(cancelFailureMessage({ message: "x".repeat(500) })).toBe(
      CANCEL_FAILED_MESSAGE,
    );
  });
});

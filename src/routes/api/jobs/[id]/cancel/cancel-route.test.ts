/**
 * td-b99b6d Rev 3.1: the cancel route's lock-timeout answer. requestCancel
 * makes ONE bounded attempt at the job row; a row the worker holds inside a
 * fenced transaction surfaces as a stable 503 job_busy body the hub shows
 * inline — never a hung request and never a 500.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requestCancel: vi.fn() }));

vi.mock("$server/jobs", async () => {
  const claim = await import("$server/job-claim");
  return {
    requestCancel: mocks.requestCancel,
    QueueLockTimeoutError: claim.QueueLockTimeoutError,
  };
});

import { QueueLockTimeoutError } from "$server/job-claim";
import { POST } from "./+server";

const call = (id = "12") =>
  POST({
    params: { id },
    locals: { user: { id: 3 } },
  } as never) as Promise<Response>;

beforeEach(() => {
  mocks.requestCancel.mockReset();
});

describe("POST /api/jobs/[id]/cancel", () => {
  it("passes the outcome through on success", async () => {
    mocks.requestCancel.mockResolvedValue("flagged");
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "flagged" });
    expect(mocks.requestCancel).toHaveBeenCalledWith(12, 3);
  });

  it("a busy job row (QueueLockTimeoutError) is 503 job_busy with the stable message", async () => {
    mocks.requestCancel.mockRejectedValue(
      new QueueLockTimeoutError("requestCancel", 15_000),
    );
    const res = await call();
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.json()).toEqual({
      error: "job_busy",
      message:
        "That job is finishing a step — try cancelling again in a few seconds.",
    });
  });

  it("a raw Postgres lock timeout (55P03) maps the same way", async () => {
    mocks.requestCancel.mockRejectedValue(
      Object.assign(new Error("canceling statement due to lock timeout"), {
        code: "55P03",
      }),
    );
    expect((await call()).status).toBe(503);
  });

  it("any other failure is not disguised as busy", async () => {
    mocks.requestCancel.mockRejectedValue(new Error("db down"));
    await expect(call()).rejects.toThrow("db down");
  });

  it("a malformed id is still a 400", async () => {
    await expect(call("x")).rejects.toMatchObject({ status: 400 });
    expect(mocks.requestCancel).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from "vitest";
import { decorateAdminJob } from "./admin-status";
import type { JobRow } from "./job-policy";

function row(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: 42,
    type: "load_region",
    status: "running",
    payload: { locs: [{ code: "US-ME" }] },
    label: "Maine",
    attempts: 2,
    max_attempts: 4,
    next_retry_at: null,
    cancel_requested: false,
    progress: {
      phase: "fetching",
      unitsTotal: 10,
      unitsDone: 4,
      unitsFailed: 0,
      unitsSkipped: 0,
      round: 1,
    },
    result: { refreshed: ["US-ME"] },
    error: null,
    requested_by: 1,
    requested_by_name: "Gaylon",
    enqueued_at: "2026-08-23T15:59:00.000Z",
    started_at: "2026-08-23T16:00:00.000Z",
    finished_at: null,
    heartbeat_at: "2026-08-23T16:00:05.000Z",
    ...overrides,
  };
}

describe("decorateAdminJob", () => {
  it("keeps the Admin-only result and derives live polling fields", () => {
    const decorated = decorateAdminJob(
      row(),
      new Date("2026-08-23T16:01:30.000Z"),
    );

    expect(decorated).toMatchObject({
      id: 42,
      displayName: "Load state data — Maine",
      statusColor: "busy",
      scheduled: false,
      target: "US-ME",
      requestedByName: "Gaylon",
      result: { refreshed: ["US-ME"] },
      durationMs: 90_000,
    });
  });

  it("marks a future recurring singleton as scheduled rather than active", () => {
    const decorated = decorateAdminJob(
      row({
        type: "scan_enrichment",
        status: "pending",
        label: "",
        payload: {},
        progress: {},
        started_at: null,
        next_retry_at: "2026-08-24T16:00:00.000Z",
      }),
      new Date("2026-08-23T16:00:00.000Z"),
    );

    expect(decorated.scheduled).toBe(true);
    expect(decorated.durationMs).toBeNull();
  });
});
